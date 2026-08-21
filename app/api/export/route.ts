import { NextResponse } from "next/server";
import { getEffectiveDataset } from "@/lib/data";
import { loadOverrides, loadCopy, loadSnapshotByTs } from "@/lib/store";
import { DatasetSchema, OverridesSchema } from "@/lib/schema";
import { buildWorkbook, exportFilename } from "@/lib/export-xlsx";
import { requireEditor } from "@/lib/api-guard";

export const dynamic = "force-dynamic";

/**
 * Download the scheme as a workbook — the file that gets filed back to the HR
 * folder as the final record.
 *
 * Without `?ts=` it exports the figures as they stand now; with one it
 * exports that snapshot, so an earlier version can be reproduced exactly
 * rather than reconstructed.
 *
 * Full-access only: the workbook carries every row and every figure, so it is
 * the whole scheme by definition and can't be scoped down meaningfully.
 */
export async function GET(req: Request) {
  const guard = await requireEditor("export");
  if ("response" in guard) return guard.response;
  const { email } = guard;

  const ts = new URL(req.url).searchParams.get("ts");
  const copy = await loadCopy();

  let data, overrides, asOf;
  if (ts) {
    const snapshot = await loadSnapshotByTs(ts);
    if (!snapshot) {
      return NextResponse.json({ error: "Snapshot not found" }, { status: 404 });
    }
    // snapshots are stored loosely typed; re-parse rather than trust the shape
    const parsedData = DatasetSchema.safeParse(snapshot.state.dataset);
    const parsedOv = OverridesSchema.safeParse(snapshot.state.overrides);
    if (!parsedData.success || !parsedOv.success) {
      return NextResponse.json(
        { error: "That snapshot can't be read — its stored shape is not valid" },
        { status: 422 }
      );
    }
    data = parsedData.data;
    overrides = parsedOv.data;
    asOf = snapshot.ts;
  } else {
    [data, overrides] = await Promise.all([getEffectiveDataset(), loadOverrides()]);
    asOf = new Date().toISOString();
  }

  const buffer = await buildWorkbook(data, overrides, {
    schemeName: copy.schemeName,
    actor: email,
    asOf,
    status: copy.bannerVisible ? copy.bannerText : undefined,
  });

  console.log(
    `[audit] export email=${email} rows=${data.emp.length} snapshot=${ts ?? "current"} ts=${new Date().toISOString()}`
  );

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${exportFilename(copy.schemeName, asOf)}"`,
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
