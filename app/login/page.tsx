import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { auth, signIn } from "@/auth";
import { TexcoX, TexcoWordmark } from "@/components/TexcoBrand";
import { PREVIEW_LOGIN_ID, previewLoginEnabled } from "@/lib/preview-login";

export const metadata = { title: "Sign in — Texco" };

const MESSAGES: Record<string, string> = {
  AccountDeactivated:
    "Your Texco account has been deactivated. Contact IT if you believe this is wrong.",
  CredentialsSignin: "Invalid email or password.",
};

/**
 * In production, not really a login page.
 *
 * Signing in happens on Texco Identity, so a guest arriving here is forwarded
 * straight into the OAuth flow — invisible when they already have an identity
 * session from another Texco app. This renders only when there is something to
 * say: an auth error, or a deliberate logout.
 *
 * Outside production it is a real login page: previews and local dev offer the
 * shared-password form (lib/preview-login.ts), so the auto-forward is
 * suppressed whenever that form is available — there is now a choice to make.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    callbackUrl?: string;
    error?: string;
    logged_out?: string;
  }>;
}) {
  const session = await auth();
  if (session?.user?.email) redirect("/");

  const { callbackUrl, error, logged_out: loggedOut } = await searchParams;
  const passwordLogin = previewLoginEnabled();
  // A preview's per-deployment URL is not a registered identity redirect_uri,
  // so offering the SSO button there would only ever lead to a failure page.
  const showIdentity = process.env.VERCEL_ENV !== "preview";

  // Nothing to show: send them to identity rather than asking them to click a
  // button that only ever does one thing.
  if (!error && !loggedOut && !passwordLogin) {
    redirect(
      `/auth/redirect${callbackUrl ? `?callbackUrl=${encodeURIComponent(callbackUrl)}` : ""}`
    );
  }

  const signInHref = `/auth/redirect${
    callbackUrl ? `?callbackUrl=${encodeURIComponent(callbackUrl)}` : ""
  }`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-brand-95">
      <div className="w-[380px] overflow-hidden bg-white shadow-2xl">
        <div className="bg-brand-95 px-8 pt-7 pb-5 text-center">
          <TexcoX className="mx-auto mb-4 h-9 w-9 text-brand-orange" />
          <TexcoWordmark className="mx-auto mb-1 block w-[200px] text-white" />
        </div>
        <div className="p-8">
          {loggedOut && !error && (
            <p className="mb-4 text-center text-[13px] text-brand-70">
              You&apos;ve been signed out.
            </p>
          )}
          {error && (
            <p className="mb-4 text-center text-[13px] font-semibold text-error">
              {MESSAGES[error] ?? "Sign-in failed. Please try again or contact IT."}
            </p>
          )}

          {showIdentity && (
            <a
              href={signInHref}
              className="block w-full bg-brand-orange px-4 py-3 text-center text-[13px] font-bold text-white transition-colors hover:bg-brand-orange-hover"
            >
              Sign in with Texco Identity
            </a>
          )}

          {passwordLogin && (
            <form
              className={
                showIdentity
                  ? "mt-6 border-t border-neutral-200 pt-4"
                  : undefined
              }
              action={async (formData: FormData) => {
                "use server";
                try {
                  await signIn(PREVIEW_LOGIN_ID, {
                    email: String(formData.get("email") ?? ""),
                    password: String(formData.get("password") ?? ""),
                    redirectTo: callbackUrl ?? "/",
                  });
                } catch (err) {
                  // A rejected password arrives as AuthError; anything else is
                  // the NEXT_REDIRECT that a successful sign-in throws, and
                  // must be left alone to do its job.
                  if (err instanceof AuthError) {
                    redirect(
                      `/login?error=CredentialsSignin${
                        callbackUrl
                          ? `&callbackUrl=${encodeURIComponent(callbackUrl)}`
                          : ""
                      }`
                    );
                  }
                  throw err;
                }
              }}
            >
              <label className="mb-1 block text-xs font-semibold text-neutral-500">
                Preview sign-in (shared password)
              </label>
              <input
                name="email"
                type="email"
                required
                autoComplete="username"
                placeholder="someone@texco.net.au"
                className="mb-2 w-full border-2 border-neutral-200 px-3 py-2 text-sm outline-none focus:border-brand-orange"
              />
              <input
                name="password"
                type="password"
                required
                autoComplete="current-password"
                placeholder="Shared password"
                className="mb-2 w-full border-2 border-neutral-200 px-3 py-2 text-sm outline-none focus:border-brand-orange"
              />
              <button
                type="submit"
                className="w-full bg-neutral-200 px-3 py-2 text-xs font-bold tracking-wide text-neutral-600 hover:bg-neutral-300"
              >
                Sign in
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
