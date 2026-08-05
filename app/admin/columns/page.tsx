import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { scopeForUser } from "@/lib/access";
import { loadColumnConfig, saveColumnConfig, appendHistory } from "@/lib/store";
import { takeSnapshot } from "@/lib/snapshots";
import { ColumnConfigSchema, normalizeConfig } from "@/lib/columns";
import ColumnsEditor from "@/components/ColumnsEditor";

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

export default async function ColumnsPage() {
  const email = await requireAdminPage();
  const config = await loadColumnConfig();

  async function saveAction(formData: FormData) {
    "use server";
    const actor = await requireAdminPage(); // authorise independently
    const parsed = ColumnConfigSchema.safeParse(
      JSON.parse(String(formData.get("config") ?? "[]"))
    );
    if (!parsed.success) throw new Error("Invalid column configuration");
    const cfg = normalizeConfig(parsed.data);
    await takeSnapshot(actor, "columns");
    await saveColumnConfig(cfg);
    await appendHistory([
      {
        ts: new Date().toISOString(),
        actor,
        kind: "columns",
        summary: `Changed column settings (visible: ${cfg
          .filter((c) => c.visible)
          .map((c) => c.field)
          .join(", ")})`,
      },
    ]);
    console.log(
      `[audit] columns-change by=${actor} ts=${new Date().toISOString()}`
    );
    revalidatePath("/");
    revalidatePath("/admin/columns");
  }

  console.log(
    `[audit] pageview page=admin/columns email=${email} ts=${new Date().toISOString()}`
  );

  return <ColumnsEditor initialConfig={config} saveAction={saveAction} />;
}
