import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { scopeForUser } from "@/lib/access";
import { verifyAdminGateToken, ADMIN_GATE_COOKIE } from "@/lib/admin-gate";
import { cookies } from "next/headers";
import { TexcoX, TexcoWordmark } from "@/components/TexcoBrand";
import { verifyAdminPassword } from "@/app/actions/admin-gate";

export const metadata = { title: "Texco" };

/**
 * The second gate a full-access admin meets, on top of signing in — full
 * access carries "View as" (impersonating anyone), and this is the same-day
 * response to a handful of IT staff holding that. proxy.ts sends every
 * unverified full admin here, on any route; this page double-checks the same
 * two things (signed in, full access) so it's never reachable by mistake,
 * and bounces straight back to `/` for anyone the gate doesn't apply to —
 * a state lead, or an admin who's already verified this browser session.
 */
export default async function AdminGatePage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) redirect("/login");

  const scope = await scopeForUser(email);
  if (!scope?.canEdit) redirect("/");

  const token = (await cookies()).get(ADMIN_GATE_COOKIE)?.value;
  if (verifyAdminGateToken(email, token)) redirect("/");

  const { callbackUrl, error } = await searchParams;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-brand-95">
      <div className="w-[380px] overflow-hidden bg-white shadow-2xl">
        <div className="bg-brand-95 px-8 pt-7 pb-5 text-center">
          <TexcoX className="mx-auto mb-4 h-9 w-9 text-brand-orange" />
          <TexcoWordmark className="mx-auto mb-1 block w-[200px] text-white" />
        </div>
        <div className="p-8">
          <p className="mb-4 text-center text-[13px] text-brand-70">
            Full access needs one more step. Enter the admin password to
            continue.
          </p>
          {error && (
            <p className="mb-4 text-center text-[13px] font-semibold text-error">
              Incorrect password. Please try again.
            </p>
          )}

          <form action={verifyAdminPassword}>
            {callbackUrl && (
              <input type="hidden" name="callbackUrl" value={callbackUrl} />
            )}
            <input
              type="password"
              name="password"
              autoFocus
              placeholder="Admin password"
              className="mb-3 w-full border-2 border-neutral-200 px-3 py-2.5 text-[13px] outline-none focus:border-brand-orange"
            />
            <button
              type="submit"
              className="block w-full bg-brand-orange px-4 py-3 text-center text-[13px] font-bold text-white transition-colors hover:bg-brand-orange-hover"
            >
              Continue
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
