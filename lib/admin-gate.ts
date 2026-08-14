import { createHmac, timingSafeEqual } from "crypto";

/**
 * The password gate every full-access admin must pass before the app shows
 * them anything — a same-day response to the fact that full access includes
 * "View as", and a few IT staff holding it is a real impersonation risk.
 *
 * Deliberately framework-agnostic: no `cookies()`/`next/headers` in here, so
 * the same functions work from proxy.ts (which reads/writes cookies via
 * `NextRequest`/`NextResponse`, not `next/headers`) and from the server
 * action that verifies the password (which does use `next/headers`). Mirrors
 * lib/params-apply.ts's `canChangeCaps`: pure, testable authorisation logic
 * kept out of the route/proxy/action itself.
 *
 * One shared password for every full admin, not per-person — that's what
 * makes this a same-day fix rather than a real second-factor rollout. There
 * is no per-person accountability beyond who's in the audit log for typing
 * it in.
 */

export const ADMIN_GATE_COOKIE = "admin_gate";

/**
 * Constant-time compare against the configured password. Fails closed if
 * `ADMIN_PASSWORD` isn't set — an unconfigured secret must lock full admins
 * out, not wave them through.
 */
export function checkAdminPassword(input: string): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * HMAC-SHA256 over the admin's own email, keyed by the same shared password.
 * Signed rather than a plain flag so the cookie can't just be typed into dev
 * tools by someone who doesn't know the password — they'd need to actually
 * compute this, which requires knowing the key.
 */
function sign(email: string): string {
  const secret = process.env.ADMIN_PASSWORD ?? "";
  return createHmac("sha256", secret).update(email.toLowerCase()).digest("hex");
}

/** The cookie value to store once this email has verified the password. */
export function adminGateToken(email: string): string {
  return sign(email);
}

/**
 * Whether a previously-issued token actually verifies this email under the
 * current secret. False whenever `ADMIN_PASSWORD` is unset (nothing can
 * verify against a secret that doesn't exist) or the token is missing.
 */
export function verifyAdminGateToken(
  email: string,
  token: string | undefined | null
): boolean {
  if (!token || !process.env.ADMIN_PASSWORD) return false;
  const expected = Buffer.from(sign(email));
  const given = Buffer.from(token);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}
