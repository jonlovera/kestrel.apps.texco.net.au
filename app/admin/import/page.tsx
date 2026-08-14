import { redirect } from "next/navigation";
import { resolveViewer } from "@/lib/view-as";
import { getDataset } from "@/lib/data";
import { loadHistory, loadStoredDatasetVersion } from "@/lib/store";
import { excludedRoster } from "@/lib/dataset-edit";
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

  const [data, history, datasetVersion] = await Promise.all([
    getDataset(),
    loadHistory(),
    loadStoredDatasetVersion(),
  ]);
  const excluded = excludedRoster(data.excludedIds, history);

  return <ImportPanel excluded={excluded} datasetVersion={datasetVersion} />;
}
