import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import { TexcoX, TexcoWordmark } from "@/components/TexcoBrand";

export const metadata = { title: "Sign in — Texco" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}) {
  const session = await auth();
  if (session?.user?.email) redirect("/");

  const { callbackUrl, error } = await searchParams;
  const devLogin =
    process.env.NODE_ENV === "development" && process.env.DEV_LOGIN === "1";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#191919]">
      <div className="w-[380px] overflow-hidden rounded-lg bg-white shadow-2xl">
        <div className="bg-[#191919] px-8 pt-7 pb-5 text-center">
          <TexcoX className="mx-auto mb-4 h-9 w-9" />
          <TexcoWordmark className="mx-auto mb-1 block w-[200px]" />
        </div>
        <div className="p-8">
          <form
            action={async () => {
              "use server";
              await signIn("microsoft-entra-id", {
                redirectTo: callbackUrl ?? "/",
              });
            }}
          >
            <button
              type="submit"
              className="w-full rounded-md bg-[#FC4D0F] px-4 py-3 text-[13px] font-bold uppercase tracking-[3px] text-white transition-colors hover:bg-[#e0440d]"
            >
              Sign in with Microsoft
            </button>
          </form>
          {error && (
            <p className="mt-3 text-center text-[13px] text-[#FC4D0F]">
              Sign-in failed. Please try again or contact IT.
            </p>
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
                className="mb-2 w-full rounded-md border-2 border-neutral-200 px-3 py-2 text-sm outline-none focus:border-[#FC4D0F]"
              />
              <button
                type="submit"
                className="w-full rounded-md bg-neutral-200 px-3 py-2 text-xs font-bold uppercase tracking-wide text-neutral-600 hover:bg-neutral-300"
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
