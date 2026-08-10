import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireWriter } from "@/lib/api-guard";
import { getDataset } from "@/lib/data";
import {
  loadOverrides,
  saveStoredDataset,
  saveOverridesForce,
  appendHistory,
} from "@/lib/store";
import { takeSnapshot } from "@/lib/snapshots";
import { EmployeeSchema, type Overrides } from "@/lib/schema";
import { buildImportPreview, candidateDataset } from "@/lib/import-parse";
import { fmt } from "@/lib/fmt";

export const dynamic = "force-dynamic";

const ApplySchema = z.object({
  rows: z.array(EmployeeSchema).min(1).max(10_000),
  confirmRemovals: z.boolean().optional(),
  totalAfter: z.number(), // echoed from the preview, for the history entry
});

/**
 * Commit a previously-previewed import: snapshot first, replace the source
 * dataset, prune overrides of removed employees. Never partial — all
 * validation re-runs here.
 */
export async function POST(req: Request) {
  const guard = await requireWriter("import-apply");
  if ("response" in guard) return guard.response;
  const { email } = guard;

  let body: z.infer<typeof ApplySchema>;
  try {
    body = ApplySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }
  const ids = new Set(body.rows.map((r) => r.id));
  if (ids.size !== body.rows.length) {
    return NextResponse.json({ error: "Duplicate employee ids" }, { status: 400 });
  }

  const [current, overrides] = await Promise.all([getDataset(), loadOverrides()]);
  const preview = buildImportPreview(current.emp, body.rows, overrides);
  if (preview.removedWithData.length > 0 && !body.confirmRemovals) {
    return NextResponse.json(
      {
        error:
          "This import removes employees who have entered data — confirm the removals to proceed",
        removedWithData: preview.removedWithData,
      },
      { status: 409 }
    );
  }

  await takeSnapshot(email, "import");
  await saveStoredDataset(candidateDataset(current, body.rows));
  const survivingOverrides: Overrides = Object.fromEntries(
    Object.entries(overrides).filter(([id]) => ids.has(id))
  );
  // Force-write bumps the version so open editors reload cleanly.
  await saveOverridesForce(survivingOverrides);

  await appendHistory([
    {
      ts: new Date().toISOString(),
      actor: email,
      kind: "import",
      summary: `Imported ${body.rows.length} employees (${preview.added.length} added, ${preview.removed.length} removed) — total pool now ${fmt(body.totalAfter)}`,
    },
  ]);
  console.log(
    `[audit] import-apply email=${email} rows=${body.rows.length} added=${preview.added.length} removed=${preview.removed.length} ts=${new Date().toISOString()}`
  );
  revalidatePath("/");

  const res = NextResponse.json({ ok: true });
  res.headers.set("Cache-Control", "no-store, max-age=0");
  return res;
}
