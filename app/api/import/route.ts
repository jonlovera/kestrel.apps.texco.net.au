import { NextResponse } from "next/server";
import { requireWriter } from "@/lib/api-guard";
import { getDataset, getParams } from "@/lib/data";
import { loadOverrides } from "@/lib/store";
import { applyParams } from "@/lib/params-apply";
import {
  parseImportFile,
  rowsToEmployees,
  buildImportPreview,
  candidateDataset,
  totalPool,
} from "@/lib/import-parse";
import { ModelReadError } from "@/lib/import-model";
import type { Overrides } from "@/lib/schema";

export const dynamic = "force-dynamic";

/**
 * Upload → parse → validate → preview. Nothing is written; the client shows
 * the preview and calls /api/import/apply to commit.
 */
export async function POST(req: Request) {
  const guard = await requireWriter("import-check");
  if ("response" in guard) return guard.response;

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
  }
  if (file.size > 5 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 5 MB)" }, { status: 400 });
  }

  let rawRows, lockedAmounts;
  try {
    ({ rows: rawRows, lockedAmounts } = await parseImportFile(
      file.name,
      Buffer.from(await file.arrayBuffer())
    ));
  } catch (err) {
    // The model reader finds many faults at once (a whole column left
    // uncalculated, say); listing only the first would mean fixing the file
    // one round-trip at a time.
    const errors =
      err instanceof ModelReadError
        ? err.errors
        : [err instanceof Error ? err.message : "The file couldn't be read."];
    return NextResponse.json({ errors }, { status: 400 });
  }

  const parsed = rowsToEmployees(rawRows);
  if (!parsed.ok) {
    return NextResponse.json({ errors: parsed.errors }, { status: 400 });
  }

  const [current, params, overrides] = await Promise.all([
    getDataset(),
    getParams(),
    loadOverrides(),
  ]);

  // Excluded people are dropped before anything else looks at this list —
  // the added/removed diff, the reconciliation total, and what Apply would
  // actually save all need to agree on the same, already-filtered roster.
  const candidate = candidateDataset(current, parsed.employees);
  const preview = buildImportPreview(current.emp, candidate.emp, overrides);
  const excludedIds = new Set(current.excludedIds);
  const excludedInFile = parsed.employees
    .filter((e) => excludedIds.has(e.id))
    .map((e) => `${e.gn} ${e.sn}`);

  const survivingIds = new Set(candidate.emp.map((e) => e.id));

  // Named before it happens, the same as the exclude list above: the sheet's
  // "Locked Amount" column fixes a person's bonus and excludes them from the
  // pool entirely (lib/import-model.ts) — applying an import shouldn't
  // silently start freezing people without saying so. Filtered to whoever
  // actually survives into the candidate roster (an excluded or removed
  // person's locked amount is meaningless).
  const importedLocks = Object.fromEntries(
    Object.entries(lockedAmounts).filter(([id]) => survivingIds.has(id))
  );
  const empById = new Map(candidate.emp.map((e) => [e.id, e]));
  const lockedInFile = Object.keys(importedLocks)
    .map((id) => empById.get(id))
    .filter((e): e is NonNullable<typeof e> => !!e)
    .map((e) => `${e.gn} ${e.sn}`);

  // Reconciliation figures through the normal pipeline (params applied,
  // overrides restricted to surviving employees).
  const effBefore = applyParams(current, params);
  const totalBefore = totalPool(effBefore, overrides);
  const survivingOverrides: Overrides = Object.fromEntries(
    Object.entries(overrides).filter(([id]) => survivingIds.has(id))
  );
  const effAfter = applyParams(candidate, params);
  const totalAfter = totalPool(effAfter, survivingOverrides);

  console.log(
    `[audit] import-preview email=${guard.email} rows=${preview.rowCount} added=${preview.added.length} removed=${preview.removed.length} excluded=${excludedInFile.length} locked=${lockedInFile.length} ts=${new Date().toISOString()}`
  );

  const res = NextResponse.json({
    preview: { ...preview, totalBefore, totalAfter, excludedInFile, lockedInFile },
    rows: candidate.emp,
    lockedAmounts: importedLocks,
  });
  res.headers.set("Cache-Control", "no-store, max-age=0");
  return res;
}
