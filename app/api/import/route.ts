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

  let rawRows;
  try {
    rawRows = await parseImportFile(file.name, Buffer.from(await file.arrayBuffer()));
  } catch (err) {
    return NextResponse.json(
      { errors: [err instanceof Error ? err.message : "The file couldn't be read."] },
      { status: 400 }
    );
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
  const preview = buildImportPreview(current.emp, parsed.employees, overrides);

  // Reconciliation figures through the normal pipeline (params applied,
  // overrides restricted to surviving employees).
  const effBefore = applyParams(current, params);
  const totalBefore = totalPool(effBefore, overrides);
  const survivingIds = new Set(parsed.employees.map((e) => e.id));
  const survivingOverrides: Overrides = Object.fromEntries(
    Object.entries(overrides).filter(([id]) => survivingIds.has(id))
  );
  const effAfter = applyParams(candidateDataset(current, parsed.employees), params);
  const totalAfter = totalPool(effAfter, survivingOverrides);

  console.log(
    `[audit] import-preview email=${guard.email} rows=${preview.rowCount} added=${preview.added.length} removed=${preview.removed.length} ts=${new Date().toISOString()}`
  );

  const res = NextResponse.json({
    preview: { ...preview, totalBefore, totalAfter },
    rows: parsed.employees,
  });
  res.headers.set("Cache-Control", "no-store, max-age=0");
  return res;
}
