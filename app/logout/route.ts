import { cookies } from "next/headers";
import { auth, signOut } from "@/auth";
import { identityLogoutUrl } from "@/lib/identity";
import { ADMIN_GATE_COOKIE } from "@/lib/admin-gate";
import { PREVIEW_LOGIN_ID } from "@/lib/preview-login";

export const dynamic = "force-dynamic";

/**
 * Single logout. Ends the session here, then hands the browser to identity,
 * which ends its own session, notifies every other Texco app by webhook, and
 * shows its signed-out page.
 *
 * Deliberately not a redirect back to a protected page: /login forwards guests
 * straight into the OAuth flow, so returning there would sign the user back in
 * before they saw anything.
 *
 * The exception is a non-production shared-password session, which identity
 * knows nothing about: sending one of those to identity's signed-out page
 * would be a confusing detour off the preview entirely. Those end on the
 * local /login instead, where `logged_out=1` both says so and suppresses the
 * auto-forward. Sessions established before this stamp existed carry no
 * provider and take the identity path, which is what they did before.
 */
export async function GET(req: Request) {
  const session = await auth();
  const provider = (session?.user as { provider?: string } | undefined)?.provider;
  const viaPassword = provider === PREVIEW_LOGIN_ID;

  await signOut({ redirect: false });
  // Doesn't verify anything on its own — proxy.ts re-derives who's a full
  // admin from the database every time — but no reason to leave it sitting
  // in the browser for whoever signs in next on this machine.
  (await cookies()).delete(ADMIN_GATE_COOKIE);

  const destination = viaPassword
    ? new URL("/login?logged_out=1", req.url).toString()
    : identityLogoutUrl();
  return Response.redirect(destination, 302);
}
