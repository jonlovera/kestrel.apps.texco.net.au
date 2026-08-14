import { cookies } from "next/headers";
import { signOut } from "@/auth";
import { identityLogoutUrl } from "@/lib/identity";
import { ADMIN_GATE_COOKIE } from "@/lib/admin-gate";

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
  // Doesn't verify anything on its own — proxy.ts re-derives who's a full
  // admin from the database every time — but no reason to leave it sitting
  // in the browser for whoever signs in next on this machine.
  (await cookies()).delete(ADMIN_GATE_COOKIE);
  return Response.redirect(identityLogoutUrl(), 302);
}
