import { redirect } from "next/navigation";
import { resolveViewer } from "@/lib/view-as";
import { loadPageviews, loadAnonVisits } from "@/lib/store";
import VisitorLogs from "@/components/VisitorLogs";

export const metadata = { title: "Texco" };
export const dynamic = "force-dynamic";

async function requireAdminPage() {
  const { actor, scope } = await resolveViewer();
  if (!actor) redirect("/login");
  if (!scope) redirect("/no-access");
  if (!scope.canEdit) redirect("/");
  return actor;
}

export default async function VisitorsPage() {
  const email = await requireAdminPage();
  const [pageviews, anonVisits] = await Promise.all([
    loadPageviews(),
    loadAnonVisits(),
  ]);

  const uniqueEmails = new Set(pageviews.map((p) => p.email)).size;
  const uniqueIpPrefixes = new Set(
    anonVisits.map((v) => v.ipPrefix).filter((p): p is string => p !== null)
  ).size;

  console.log(
    `[audit] pageview page=admin/visitors email=${email} ts=${new Date().toISOString()}`
  );

  return (
    <VisitorLogs
      pageviews={pageviews}
      anonVisits={anonVisits}
      stats={{
        totalPageviews: pageviews.length,
        uniqueEmails,
        totalAnonVisits: anonVisits.length,
        uniqueIpPrefixes,
      }}
    />
  );
}
