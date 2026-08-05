import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { scopeForUser } from "@/lib/access";
import ImportPanel from "@/components/ImportPanel";

export const metadata = { title: "Texco" };
export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) redirect("/login");
  const scope = await scopeForUser(email);
  if (!scope) redirect("/no-access");
  if (!scope.canEdit) redirect("/");

  console.log(
    `[audit] pageview page=admin/import email=${email} ts=${new Date().toISOString()}`
  );

  return <ImportPanel />;
}
