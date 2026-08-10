import { redirect } from "next/navigation";
import { resolveViewer } from "@/lib/view-as";
import ImportPanel from "@/components/ImportPanel";

export const metadata = { title: "Texco" };
export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const { actor, scope } = await resolveViewer();
  if (!actor) redirect("/login");
  if (!scope) redirect("/no-access");
  if (!scope.canEdit) redirect("/");
  const email = actor;

  console.log(
    `[audit] pageview page=admin/import email=${email} ts=${new Date().toISOString()}`
  );

  return <ImportPanel />;
}
