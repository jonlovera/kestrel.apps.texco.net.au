import { timingSafeEqual } from "crypto";

/**
 * Email + shared-password sign-in for NON-PRODUCTION environments only:
 * Vercel preview deployments and local `next dev`.
 *
 * Production signs in through Texco Identity and nothing here changes that.
 * Previews cannot: their URLs are generated per deployment, so a preview's
 * redirect_uri is not registered with the identity server and the OAuth hop
 * can only fail. This is the way in for testing a preview.
 *
 * The environment test is VERCEL_ENV, not NODE_ENV: a Vercel preview builds
 * with NODE_ENV === "production", which is exactly why the older
 * NODE_ENV-gated dev login never appeared on one.
 *
 * Two gates, both required, so the password cannot let anyone into
 * production even if the variable is created there by mistake:
 * PREVIEW_LOGIN_PASSWORD must be set, AND VERCEL_ENV must not be
 * "production". Policy is that the variable only exists for the preview and
 * development targets; this is the backstop, not the policy.
 *
 * Authorisation is untouched. Whoever signs in, lib/access.ts still decides
 * what that email may see, and an email outside the allowlist lands on
 * /no-access — useful in itself for testing what a stranger sees.
 *
 * Deliberately framework-free (no next/headers, no auth imports) and reads
 * the environment fresh on every call, mirroring lib/admin-gate.ts, so the
 * decisions are unit-testable without any NextAuth plumbing.
 */

/** The credentials provider's id, shared by auth.ts and every caller of signIn. */
export const PREVIEW_LOGIN_ID = "preview-login";

/**
 * Whether the shared-password provider should exist at all. False in
 * production regardless of configuration, and false anywhere the password
 * has not been set.
 */
export function previewLoginEnabled(): boolean {
  return (
    !!process.env.PREVIEW_LOGIN_PASSWORD &&
    process.env.VERCEL_ENV !== "production"
  );
}

/**
 * Constant-time compare against the configured password. Fails closed when
 * the password is unset or the environment is production, so the check can
 * never be the thing that waves someone through.
 */
export function checkPreviewPassword(input: string): boolean {
  if (!previewLoginEnabled()) return false;
  const expected = process.env.PREVIEW_LOGIN_PASSWORD ?? "";
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Whether the passwordless GET shortcuts (/dev/login, /dev/login/{email})
 * are live. Local `next dev` only, opted into with DEV_LOGIN=1, and still
 * subject to the password gate above — those routes sign in through the same
 * provider, injecting the password server-side so it never reaches a URL.
 */
export function devConvenienceLoginEnabled(): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    process.env.DEV_LOGIN === "1" &&
    previewLoginEnabled()
  );
}
