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
  // The sheet's "Locked Amount" column, echoed back from the preview the
  // same way `rows` is — re-filtered against the candidate roster below
  // rather than trusted, the same defence-in-depth reasoning as re-deriving
  // `candidate` itself.
  lockedAmounts: z.record(z.string(), z.number()).default({}),
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
  // Re-derived here rather than trusted from the client: the preview already
  // sends back the filtered rows, but re-filtering means a permanently
  // excluded person can never end up saved regardless of what the request
  // actually contains — the same reasoning as re-validating everything else
  // on this route rather than trusting what was previewed.
  const candidate = candidateDataset(current, body.rows);
  const preview = buildImportPreview(current.emp, candidate.emp, overrides);
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
  await saveStoredDataset(candidate);
  const survivingIds = new Set(candidate.emp.map((e) => e.id));
  const survivingOverrides: Overrides = Object.fromEntries(
    Object.entries(overrides).filter(([id]) => survivingIds.has(id))
  );

  // The sheet's "Locked Amount" column becomes a lock override, the same
  // mechanism the dashboard's own Lock button writes to — overwriting
  // whatever lock state that id already had, since the spreadsheet is
  // authoritative for this figure the same way it is for every other
  // imported one.
  const importedLocks = Object.entries(body.lockedAmounts).filter(([id]) =>
    survivingIds.has(id)
  );
  for (const [id, amount] of importedLocks) {
    survivingOverrides[id] = { ...survivingOverrides[id], locked: true, lockedFinal: amount };
  }

  // Force-write bumps the version so open editors reload cleanly.
  await saveOverridesForce(survivingOverrides);

  await appendHistory([
    {
      ts: new Date().toISOString(),
      actor: email,
      kind: "import",
      summary: `Imported ${candidate.emp.length} employees (${preview.added.length} added, ${preview.removed.length} removed, ${importedLocks.length} locked) — total pool now ${fmt(body.totalAfter)}`,
    },
  ]);
  console.log(
    `[audit] import-apply email=${email} rows=${candidate.emp.length} added=${preview.added.length} removed=${preview.removed.length} locked=${importedLocks.length} ts=${new Date().toISOString()}`
  );
  revalidatePath("/");

  const res = NextResponse.json({ ok: true });
  res.headers.set("Cache-Control", "no-store, max-age=0");
  return res;
}
