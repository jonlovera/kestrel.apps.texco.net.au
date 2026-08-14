import { describe, it, expect } from "vitest";
import {
  checkAdminPassword,
  adminGateToken,
  verifyAdminGateToken,
} from "./admin-gate";

/**
 * process.env.ADMIN_PASSWORD is mutated per test and restored in a finally,
 * the same pattern lib/identity.test.ts uses for IDENTITY_URL — these
 * functions read it fresh on every call rather than caching it, so this is
 * enough to exercise both a configured and an unconfigured secret.
 */
function withPassword(value: string | undefined, run: () => void) {
  const original = process.env.ADMIN_PASSWORD;
  try {
    if (value === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = value;
    run();
  } finally {
    if (original === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = original;
  }
}

describe("checkAdminPassword", () => {
  it("accepts the configured password", () => {
    withPassword("TexcoMaster2026", () => {
      expect(checkAdminPassword("TexcoMaster2026")).toBe(true);
    });
  });

  it("rejects anything else", () => {
    withPassword("TexcoMaster2026", () => {
      expect(checkAdminPassword("wrong")).toBe(false);
      expect(checkAdminPassword("")).toBe(false);
      expect(checkAdminPassword("TexcoMaster2026 ")).toBe(false);
    });
  });

  it("fails closed when ADMIN_PASSWORD isn't configured", () => {
    // The regression this guards: an unset secret must lock every full admin
    // out, not silently accept anything (or, worse, an empty string).
    withPassword(undefined, () => {
      expect(checkAdminPassword("")).toBe(false);
      expect(checkAdminPassword("anything")).toBe(false);
    });
  });
});

describe("adminGateToken / verifyAdminGateToken", () => {
  it("a token issued for one email verifies for that email", () => {
    withPassword("TexcoMaster2026", () => {
      const token = adminGateToken("admin@texco.net.au");
      expect(verifyAdminGateToken("admin@texco.net.au", token)).toBe(true);
    });
  });

  it("is case-insensitive on the email, matching how scopes are keyed", () => {
    withPassword("TexcoMaster2026", () => {
      const token = adminGateToken("Admin@Texco.net.au");
      expect(verifyAdminGateToken("admin@texco.net.au", token)).toBe(true);
    });
  });

  it("a token issued for one email does not verify for another", () => {
    withPassword("TexcoMaster2026", () => {
      const token = adminGateToken("admin@texco.net.au");
      expect(verifyAdminGateToken("other-admin@texco.net.au", token)).toBe(false);
    });
  });

  it("rejects a missing token", () => {
    withPassword("TexcoMaster2026", () => {
      expect(verifyAdminGateToken("admin@texco.net.au", undefined)).toBe(false);
      expect(verifyAdminGateToken("admin@texco.net.au", null)).toBe(false);
      expect(verifyAdminGateToken("admin@texco.net.au", "")).toBe(false);
    });
  });

  it("rejects a hand-typed guess — the point of signing it", () => {
    withPassword("TexcoMaster2026", () => {
      expect(verifyAdminGateToken("admin@texco.net.au", "1")).toBe(false);
      expect(verifyAdminGateToken("admin@texco.net.au", "true")).toBe(false);
    });
  });

  it("a token issued under one secret stops verifying once the secret changes", () => {
    let token = "";
    withPassword("TexcoMaster2026", () => {
      token = adminGateToken("admin@texco.net.au");
    });
    withPassword("SomethingElse2027", () => {
      expect(verifyAdminGateToken("admin@texco.net.au", token)).toBe(false);
    });
  });

  it("fails closed when ADMIN_PASSWORD isn't configured, even with a token", () => {
    let token = "";
    withPassword("TexcoMaster2026", () => {
      token = adminGateToken("admin@texco.net.au");
    });
    withPassword(undefined, () => {
      expect(verifyAdminGateToken("admin@texco.net.au", token)).toBe(false);
    });
  });
});
