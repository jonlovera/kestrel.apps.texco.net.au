import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { auth, signIn } from "@/auth";
import { TexcoX, TexcoWordmark } from "@/components/TexcoBrand";

export const metadata = { title: "Sign in — Texco" };

const MESSAGES: Record<string, string> = {
  AccountDeactivated:
    "Your Texco account has been deactivated. Contact IT if you believe this is wrong.",
  CredentialsSignin: "Invalid email or password.",
};

/**
 * Not really a login page.
 *
 * Signing in happens on Texco Identity, so a guest arriving here is forwarded
 * straight into the OAuth flow — invisible when they already have an identity
 * session from another Texco app. This renders only when there is something to
 * say: an auth error, or a deliberate logout.
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
  const devLogin =
    process.env.NODE_ENV === "development" && process.env.DEV_LOGIN === "1";
  const passwordLogin = Boolean(process.env.TEMP_LOGIN_PASSWORD);

  // Nothing to show: send them to identity rather than asking them to click a
  // button that only ever does one thing.
  if (!error && !loggedOut && !devLogin && !passwordLogin) {
    redirect(
      `/auth/redirect${callbackUrl ? `?callbackUrl=${encodeURIComponent(callbackUrl)}` : ""}`
    );
  }

  const signInHref = `/auth/redirect${
    callbackUrl ? `?callbackUrl=${encodeURIComponent(callbackUrl)}` : ""
  }`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#191919]">
      <div className="w-[380px] overflow-hidden bg-white shadow-2xl">
        <div className="bg-[#191919] px-8 pt-7 pb-5 text-center">
          <TexcoX className="mx-auto mb-4 h-9 w-9" />
          <TexcoWordmark className="mx-auto mb-1 block w-[200px]" />
        </div>
        <div className="p-8">
          {loggedOut && !error && (
            <p className="mb-4 text-center text-[13px] text-[#5C5C5C]">
              You&apos;ve been signed out.
            </p>
          )}
          {error && (
            <p className="mb-4 text-center text-[13px] font-semibold text-[#FC4D0F]">
              {MESSAGES[error] ?? "Sign-in failed. Please try again or contact IT."}
            </p>
          )}

          <a
            href={signInHref}
            className="block w-full bg-[#FC4D0F] px-4 py-3 text-center text-[13px] font-bold text-white transition-colors hover:bg-[#e0440d]"
          >
            Sign in with Texco Identity
          </a>

          {passwordLogin && (
            <form
              className="mt-6 border-t border-neutral-200 pt-5"
              action={async (formData: FormData) => {
                "use server";
                try {
                  await signIn("password", {
                    email: String(formData.get("email") ?? ""),
                    password: String(formData.get("password") ?? ""),
                    redirectTo: callbackUrl ?? "/",
                  });
                } catch (err) {
                  if (err instanceof AuthError) {
                    redirect(
                      `/login?error=CredentialsSignin${
                        callbackUrl ? `&callbackUrl=${encodeURIComponent(callbackUrl)}` : ""
                      }`
                    );
                  }
                  throw err; // NEXT_REDIRECT on success
                }
              }}
            >
              <p className="mb-3 text-center text-[11px] text-neutral-400">
                Temporary sign-in — being retired
              </p>
              <input
                name="email"
                type="email"
                required
                placeholder="Email"
                className="mb-3 w-full border-2 border-neutral-200 px-4 py-3 text-[15px] outline-none focus:border-[#FC4D0F]"
              />
              <input
                name="password"
                type="password"
                required
                placeholder="Password"
                className="mb-4 w-full border-2 border-neutral-200 px-4 py-3 text-[15px] outline-none focus:border-[#FC4D0F]"
              />
              <button
                type="submit"
                className="w-full bg-[#191919] px-4 py-3 text-[13px] font-bold text-white transition-colors hover:bg-[#333]"
              >
                Sign in
              </button>
            </form>
          )}

          {devLogin && (
            <form
              className="mt-6 border-t border-neutral-200 pt-4"
              action={async (formData: FormData) => {
                "use server";
                await signIn("dev-login", {
                  email: String(formData.get("email") ?? ""),
                  redirectTo: callbackUrl ?? "/",
                });
              }}
            >
              <label className="mb-1 block text-xs font-semibold text-neutral-500">
                Dev login (local only)
              </label>
              <input
                name="email"
                type="email"
                placeholder="someone@texco.net.au"
                className="mb-2 w-full border-2 border-neutral-200 px-3 py-2 text-sm outline-none focus:border-[#FC4D0F]"
              />
              <button
                type="submit"
                className="w-full bg-neutral-200 px-3 py-2 text-xs font-bold tracking-wide text-neutral-600 hover:bg-neutral-300"
              >
                Sign in as
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
