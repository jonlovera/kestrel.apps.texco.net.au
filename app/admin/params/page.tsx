import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { scopeForUser } from "@/lib/access";
import { getDataset, getParams } from "@/lib/data";
import { loadOverrides, saveParams, appendHistory } from "@/lib/store";
import { takeSnapshot } from "@/lib/snapshots";
import { ParamsSchema } from "@/lib/params-apply";
import { fmt } from "@/lib/fmt";
import ParamsEditor from "@/components/ParamsEditor";

export const metadata = { title: "Texco" };
export const dynamic = "force-dynamic";

async function requireAdminPage() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) redirect("/login");
  const scope = await scopeForUser(email);
  if (!scope) redirect("/no-access");
  if (!scope.canEdit) redirect("/");
  return email;
}

export default async function ParamsPage() {
  const email = await requireAdminPage();
  const [dataset, params, overrides] = await Promise.all([
    getDataset(),
    getParams(),
    loadOverrides(),
  ]);

  async function saveAction(formData: FormData) {
    "use server";
    const actor = await requireAdminPage(); // authorise independently
    const before = await getParams();
    const candidate = ParamsSchema.parse({
      vCap: Number(formData.get("vCap")),
      nCap: Number(formData.get("nCap")),
      gCap: Number(formData.get("gCap")),
      companyModifier: Number(formData.get("companyModifier")),
    });
    await takeSnapshot(actor, "params");
    await saveParams(candidate);
    await appendHistory([
      {
        ts: new Date().toISOString(),
        actor,
        kind: "params",
        summary:
          `Changed scheme parameters: VIC cap ${fmt(before.vCap)} → ${fmt(candidate.vCap)}, ` +
          `NSW cap ${fmt(before.nCap)} → ${fmt(candidate.nCap)}, ` +
          `group cap ${fmt(before.gCap)} → ${fmt(candidate.gCap)}, ` +
          `company modifier ${before.companyModifier} → ${candidate.companyModifier}`,
      },
    ]);
    console.log(`[audit] params-change by=${actor} ts=${new Date().toISOString()}`);
    revalidatePath("/");
    revalidatePath("/admin/params");
  }

  console.log(
    `[audit] pageview page=admin/params email=${email} ts=${new Date().toISOString()}`
  );

  // The params page is full-access only, so shipping the dataset to the
  // client for the live preview discloses nothing the user can't already see.
  return (
    <ParamsEditor
      dataset={dataset}
      overrides={overrides}
      current={params}
      saveAction={saveAction}
    />
  );
}
