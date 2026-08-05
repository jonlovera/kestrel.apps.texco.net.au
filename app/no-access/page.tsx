import { auth, signOut } from "@/auth";
import { redirect } from "next/navigation";
import { TexcoX } from "@/components/TexcoBrand";

export const metadata = { title: "Texco" };

export default async function NoAccessPage() {
  const session = await auth();
  if (!session?.user?.email) redirect("/login");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#191919]">
      <div className="w-[420px] overflow-hidden rounded-lg bg-white shadow-2xl">
        <div className="bg-[#191919] px-8 py-6 text-center">
          <TexcoX className="mx-auto mb-1 h-9 w-9" />
        </div>
        <div className="p-8 text-center">
          <h1 className="mb-2 text-lg font-bold text-[#191919]">
            Access not configured
          </h1>
          <p className="mb-6 text-sm text-neutral-500">
            You signed in as <strong>{session.user.email}</strong>, but this
            account hasn&apos;t been given access to this application.
          </p>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/login" });
            }}
          >
            <button
              type="submit"
              className="rounded-md bg-neutral-200 px-6 py-2 text-xs font-bold uppercase tracking-wide text-neutral-600 hover:bg-neutral-300"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
