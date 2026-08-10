/**
 * Tests for the parts of the Texco Identity integration that can be exercised
 * without an OAuth round trip: the signature check that authenticates every
 * webhook, and the profile mapping that decides who someone is and whether
 * they are still allowed in.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifyWebhookSignature,
  MAX_CLOCK_SKEW_SECONDS,
} from "./webhook-signature";
import { mapIdentityProfile, identityHost, identityLogoutUrl } from "./identity";

const SECRET = "whsec_testing_only";
const BODY = JSON.stringify({ event: "user.logged_out", m365_id: "abc-123" });
const NOW = 1_800_000_000_000; // fixed clock
const TS = String(Math.floor(NOW / 1000));

const sign = (timestamp: string, body: string, secret = SECRET) =>
  "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

const verify = (over: Partial<Parameters<typeof verifyWebhookSignature>[0]> = {}) =>
  verifyWebhookSignature({
    secret: SECRET,
    signature: sign(TS, BODY),
    timestamp: TS,
    rawBody: BODY,
    now: NOW,
    ...over,
  });

describe("webhook signature", () => {
  it("accepts a correctly signed delivery", () => {
    expect(verify()).toEqual({ ok: true });
  });

  it("fails closed when no secret is configured", () => {
    // an unset secret must never mean "accept anything"
    expect(verify({ secret: undefined })).toEqual({
      ok: false,
      reason: "unconfigured",
    });
    expect(verify({ secret: "" })).toEqual({ ok: false, reason: "unconfigured" });
  });

  it("rejects a body that has been altered after signing", () => {
    const tampered = BODY.replace("abc-123", "someone-else");
    expect(verify({ rawBody: tampered })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(verify({ signature: sign(TS, BODY, "not-the-secret") })).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("rejects a replayed delivery once it is outside the window", () => {
    const old = String(Math.floor(NOW / 1000) - MAX_CLOCK_SKEW_SECONDS - 1);
    expect(verify({ timestamp: old, signature: sign(old, BODY) })).toEqual({
      ok: false,
      reason: "stale",
    });
  });

  it("allows a little clock drift in both directions", () => {
    for (const delta of [-MAX_CLOCK_SKEW_SECONDS + 1, MAX_CLOCK_SKEW_SECONDS - 1]) {
      const ts = String(Math.floor(NOW / 1000) + delta);
      expect(verify({ timestamp: ts, signature: sign(ts, BODY) })).toEqual({ ok: true });
    }
  });

  it("rejects missing or non-numeric headers rather than throwing", () => {
    expect(verify({ signature: null })).toEqual({ ok: false, reason: "malformed" });
    expect(verify({ timestamp: null })).toEqual({ ok: false, reason: "malformed" });
    expect(verify({ timestamp: "not-a-number" })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("rejects a signature of the wrong length without throwing", () => {
    // timingSafeEqual throws on mismatched lengths; that must be handled
    expect(verify({ signature: "sha256=short" })).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("signs the raw bytes, not the re-serialised object", () => {
    // identity's json_encode spacing is not reproducible from a parsed object,
    // so a body that differs only in whitespace must not verify
    const respaced = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(verify({ rawBody: respaced })).toEqual({ ok: false, reason: "mismatch" });
  });
});

describe("identity profile mapping", () => {
  it("uses m365_id as the identity and lowercases the email", () => {
    const u = mapIdentityProfile({
      id: 42,
      m365_id: "OBJ-1",
      name: "Jonie Lovera",
      email: "JLovera@Texco.net.au",
      avatar: "https://identity/avatar.png",
      is_active: true,
    });
    expect(u).toEqual({
      id: "OBJ-1",
      email: "jlovera@texco.net.au",
      name: "Jonie Lovera",
      image: "https://identity/avatar.png",
      m365Id: "OBJ-1",
      isActive: true,
    });
  });

  it("treats a missing is_active as active", () => {
    // an older identity that doesn't send the field must not lock everyone out
    expect(mapIdentityProfile({ m365_id: "X", email: "a@b.c" }).isActive).toBe(true);
  });

  it("treats is_active false as deactivated, and only false", () => {
    expect(mapIdentityProfile({ m365_id: "X", is_active: false }).isActive).toBe(false);
    expect(mapIdentityProfile({ m365_id: "X", is_active: true }).isActive).toBe(true);
  });

  it("falls back to identity's own id when m365_id is absent", () => {
    const u = mapIdentityProfile({ id: 7, email: "a@b.c" });
    expect(u.id).toBe("7");
    expect(u.m365Id).toBeUndefined();
  });
});

describe("identity host", () => {
  it("defaults to the production host and trims a trailing slash", () => {
    const original = process.env.IDENTITY_URL;
    try {
      delete process.env.IDENTITY_URL;
      expect(identityHost()).toBe("https://identity.texco.net.au");
      process.env.IDENTITY_URL = "http://localhost:8001/";
      expect(identityHost()).toBe("http://localhost:8001");
      expect(identityLogoutUrl()).toBe("http://localhost:8001/logout");
    } finally {
      if (original === undefined) delete process.env.IDENTITY_URL;
      else process.env.IDENTITY_URL = original;
    }
  });
});
