import { redirect } from "next/navigation";
import { resolveViewer } from "@/lib/view-as";
import { loadPackageIncreases } from "@/lib/store";
import PackageIncreasePanel from "@/components/PackageIncreasePanel";

export const metadata = { title: "Texco" };
export const dynamic = "force-dynamic";

export default async function PackageIncreasePage() {
  const { actor, scope } = await resolveViewer();
  if (!actor) redirect("/login");
  if (!scope) redirect("/no-access");
  if (!scope.canEdit) redirect("/");

  console.log(
    `[audit] pageview page=admin/package-increase email=${actor} ts=${new Date().toISOString()}`
  );

  const doc = await loadPackageIncreases();
  return <PackageIncreasePanel initial={doc} />;
}
