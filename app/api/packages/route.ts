import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { requireWriter, noStore } from "@/lib/api-guard";
import { getDataset } from "@/lib/data";
import { loadPackageIncreases, savePackageIncreases, appendHistory } from "@/lib/store";
import {
  readRemunerationWorkbook,
  summarise,
  type PackageIncreaseDoc,
} from "@/lib/remuneration";
import { ImportError } from "@/lib/xlsx-cells";

export const dynamic = "force-dynamic";

/**
 * The FY27 remuneration review: upload the master workbook, keep what it says
 * about each person's package.
 *
 * requireWriter, not requireScopedWriter — this is whole-company salary data
 * with no per-row boundary of its own, so it belongs with the dataset and the
 * access list rather than with /api/state (see lib/api-guard.ts, which spells
 * out why reaching for the permissive gate is the mistake to avoid).
 *
 * Unlike /api/import there is no preview step: nothing here changes a payout,
 * an entitlement or the roster, so there is nothing to reconcile before
 * committing. A re-upload simply replaces the stored document.
 */
export async function GET() {
  const guard = await requireWriter("packages-read");
  if ("response" in guard) return guard.response;
  const doc = await loadPackageIncreases();
  return noStore(NextResponse.json({ doc }));
}

export async function POST(req: Request) {
  const guard = await requireWriter("packages-upload");
  if ("response" in guard) return guard.response;

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return noStore(NextResponse.json({ errors: ["No file uploaded."] }, { status: 400 }));
  }
  if (file.size > 5 * 1024 * 1024) {
    return noStore(
      NextResponse.json({ errors: ["File too large (max 5 MB)."] }, { status: 400 })
    );
  }
  if (!/\.(xlsx|xlsm)$/i.test(file.name)) {
    return noStore(
      NextResponse.json(
        { errors: ["The remuneration review is an Excel workbook — upload the .xlsx file."] },
        { status: 400 }
      )
    );
  }

  // The dataset is read only to mark which reviewed people are on the bonus
  // scheme; nobody is dropped for missing from it.
  const data = await getDataset();
  const knownIds = new Set(data.emp.map((e) => e.id));

  let doc: PackageIncreaseDoc;
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await file.arrayBuffer()) as unknown as ArrayBuffer);
    const rows = readRemunerationWorkbook(wb, knownIds);
    doc = {
      uploadedAt: new Date().toISOString(),
      uploadedBy: guard.email,
      filename: file.name,
      rows,
    };
  } catch (err) {
    // ImportError carries every fault it found, which is the whole point: a
    // workbook left on Manual calculation breaks a column at a time.
    const errors =
      err instanceof ImportError
        ? err.errors
        : [err instanceof Error ? err.message : "The file couldn't be read."];
    return noStore(NextResponse.json({ errors }, { status: 400 }));
  }

  await savePackageIncreases(doc);

  const s = summarise(doc.rows);
  console.log(
    `[audit] packages-upload email=${guard.email} file=${file.name} people=${s.people} increased=${s.increased} unmatched=${s.unmatched} ts=${doc.uploadedAt}`
  );
  // kind "import" rather than a new one: the history schema already has it and
  // nothing renders off `kind`, so this needs no migration to be readable.
  await appendHistory([
    {
      ts: doc.uploadedAt,
      actor: guard.email,
      kind: "import",
      summary: `FY27 remuneration review uploaded — ${s.increased} package increase${
        s.increased === 1 ? "" : "s"
      } across ${s.people} people`,
    },
  ]);

  return noStore(NextResponse.json({ doc }));
}
