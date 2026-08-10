import { redirect } from "next/navigation";
import { resolveViewer } from "@/lib/view-as";
import { endViewAs } from "@/app/actions/view-as";
import { TexcoX } from "@/components/TexcoBrand";

export const metadata = { title: "Texco" };
export const dynamic = "force-dynamic";

/**
 * What an admin sees when they view as somebody with no access — which is a
 * legitimate thing to check before telling a new starter to sign in. Shown
 * instead of /no-access so the exit route is obvious and the admin is never
 * left wondering whether they have lost their own access.
 */
export default async function ViewAsNoAccessPage() {
  const { actor, viewingAs } = await resolveViewer();
  if (!actor) redirect("/login");
  if (!viewingAs) redirect("/");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-brand-95">
      <div className="w-[440px] overflow-hidden bg-white shadow-2xl">
        <div className="bg-brand-95 px-8 py-6 text-center">
          <TexcoX className="mx-auto mb-1 h-9 w-9 text-brand-orange" />
        </div>
        <div className="p-8 text-center">
          <h1 className="mb-2 text-lg font-bold text-brand-95">
            {viewingAs} has no access
          </h1>
          <p className="mb-6 text-sm text-neutral-500">
            This is what they would see: the &ldquo;Access not
            configured&rdquo; page. Grant them access on the Access screen if
            that isn&apos;t what you expected.
          </p>
          <form action={endViewAs}>
            <button
              type="submit"
              className="bg-brand-orange px-6 py-2 text-xs font-bold tracking-wide text-white hover:bg-brand-orange-hover"
            >
              Stop viewing as {viewingAs}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
