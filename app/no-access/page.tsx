import { auth, signOut } from "@/auth";
import { redirect } from "next/navigation";
import { TexcoX } from "@/components/TexcoBrand";

export const metadata = { title: "Texco" };

export default async function NoAccessPage() {
  const session = await auth();
  if (!session?.user?.email) redirect("/login");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-brand-95">
      <div className="w-[420px] overflow-hidden bg-white shadow-2xl">
        <div className="bg-brand-95 px-8 py-6 text-center">
          <TexcoX className="mx-auto mb-1 h-9 w-9 text-brand-orange" />
        </div>
        <div className="p-8 text-center">
          <h1 className="mb-2 text-lg font-bold text-brand-95">
            Access not configured
          </h1>
          <p className="mb-6 text-sm text-neutral-500">
            You signed in as <strong>{session.user.email}</strong>, but this
            account hasn&apos;t been given access to this application.
          </p>
          <p className="mb-6 text-sm text-neutral-500">
            Access is granted per person. Ask the scheme owner in Finance, or
            whoever asked you to look at this, to add you.
          </p>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/logout" });
            }}
          >
            <button
              type="submit"
              className="bg-neutral-200 px-6 py-2 text-xs font-bold tracking-wide text-neutral-600 hover:bg-neutral-300"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
