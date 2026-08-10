import { signIn } from "@/auth";
import { IDENTITY_PROVIDER_ID } from "@/lib/identity";

export const dynamic = "force-dynamic";

/**
 * The way into the OAuth flow, at the path the rest of Texco uses.
 *
 * Guests hitting a protected page are forwarded here by /login, so the app
 * never renders a login screen of its own — and when an identity session
 * already exists the whole thing is invisible. It is also the target of the
 * manual "Sign in" link shown after a deliberate logout.
 */
export async function GET(req: Request) {
  const callbackUrl = new URL(req.url).searchParams.get("callbackUrl") ?? "/";
  // only ever return to somewhere on this app
  const redirectTo = callbackUrl.startsWith("/") ? callbackUrl : "/";
  return signIn(IDENTITY_PROVIDER_ID, { redirectTo });
}
