/**
 * View-as tests.
 *
 * The load-bearing rule, and the reason this file exists: the cookie naming
 * someone to view as is honoured ONLY when the real signed-in user is
 * full-access. That check — not the cookie's httpOnly flag — is what stops a
 * state lead forging one and reading the whole scheme.
 *
 * resolveViewer itself reaches for the session and the database, so the rule
 * is extracted here and asserted directly; the wiring is covered end to end
 * against a running server.
 */
import { describe, it, expect } from "vitest";
import type { Scope } from "./access";

/** The decision resolveViewer makes, in isolation. */
function honourCookie(
  actorScope: Pick<Scope, "canEdit"> | null,
  actor: string,
  cookie: string | undefined
): string | null {
  if (!actorScope?.canEdit) return null;
  if (!cookie) return null;
  const target = cookie.toLowerCase();
  return target && target !== actor.toLowerCase() ? target : null;
}

const admin = { canEdit: true };
const lead = { canEdit: false };

describe("who may view as someone else", () => {
  it("a full-access user may", () => {
    expect(honourCookie(admin, "admin@texco.net.au", "vic.lead@texco.net.au")).toBe(
      "vic.lead@texco.net.au"
    );
  });

  it("a state lead may NOT — a forged cookie is ignored outright", () => {
    // the escalation attempt: a lead naming an admin
    expect(honourCookie(lead, "vic.lead@texco.net.au", "admin@texco.net.au")).toBeNull();
  });

  it("someone with no scope at all may not", () => {
    expect(honourCookie(null, "nobody@texco.net.au", "admin@texco.net.au")).toBeNull();
  });

  it("viewing as yourself is a no-op rather than a special case", () => {
    expect(honourCookie(admin, "admin@texco.net.au", "ADMIN@texco.net.au")).toBeNull();
  });

  it("no cookie means your own view", () => {
    expect(honourCookie(admin, "admin@texco.net.au", undefined)).toBeNull();
    expect(honourCookie(admin, "admin@texco.net.au", "")).toBeNull();
  });

  it("is case-insensitive, since email is", () => {
    expect(honourCookie(admin, "admin@texco.net.au", "VIC.Lead@Texco.net.au")).toBe(
      "vic.lead@texco.net.au"
    );
  });
});
