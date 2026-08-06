import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { saveColumnConfig, appendHistory } from "@/lib/store";
import { takeSnapshot } from "@/lib/snapshots";
import { ColumnConfigSchema, normalizeConfig } from "@/lib/columns";
import { requireEditor, noStore } from "@/lib/api-guard";

export const dynamic = "force-dynamic";

/**
 * Save the table's presentation config from the dashboard's column menu.
 * Display only: this can never change a figure or who is entitled to see one
 * (lib/columns.test.ts holds that line).
 *
 * Last-write-wins, deliberately: the doc is tiny, two people rarely reorder
 * columns at the same moment, and a snapshot is taken first either way.
 * Compare-and-set is reserved for the dataset and overrides docs, where a lost
 * update would cost money rather than a column order.
 */
export async function POST(req: Request) {
  const guard = await requireEditor("columns-write");
  if ("response" in guard) return guard.response;
  const { email } = guard;

  let config;
  try {
    config = normalizeConfig(ColumnConfigSchema.parse(await req.json()));
  } catch {
    return NextResponse.json(
      { error: "Invalid column configuration" },
      { status: 400 }
    );
  }

  await takeSnapshot(email, "columns");
  await saveColumnConfig(config);
  await appendHistory([
    {
      ts: new Date().toISOString(),
      actor: email,
      kind: "columns",
      summary: `Changed column settings (visible: ${config
        .filter((c) => c.visible)
        .map((c) => c.field)
        .join(", ")})`,
    },
  ]);
  console.log(`[audit] columns-change by=${email} ts=${new Date().toISOString()}`);
  revalidatePath("/");

  return noStore(NextResponse.json({ ok: true, config }));
}
