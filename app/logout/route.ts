import { signOut } from "@/auth";
import { identityLogoutUrl } from "@/lib/identity";

export const dynamic = "force-dynamic";

/**
 * Single logout. Ends the session here, then hands the browser to identity,
 * which ends its own session, notifies every other Texco app by webhook, and
 * shows its signed-out page.
 *
 * Deliberately not a redirect back to a protected page: /login forwards guests
 * straight into the OAuth flow, so returning there would sign the user back in
 * before they saw anything.
 */
export async function GET() {
  await signOut({ redirect: false });
  return Response.redirect(identityLogoutUrl(), 302);
}
