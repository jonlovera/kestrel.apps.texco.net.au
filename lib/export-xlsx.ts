/**
 * The workbook that gets filed back to the HR folder as the final record.
 *
 * Pure — takes a dataset and its overrides, returns bytes. No I/O and no
 * server-only imports, so the workbook can be built and read back in a test
 * the way lib/import-parse.test.ts already does with import files.
 *
 * Two things it has to get right, because both are how the file is used:
 *
 *  - Employee ID is present. HR reconcile against payroll by ID, not by name,
 *    and names collide (Texco has several Bulls).
 *  - The headers match lib/import-parse.ts's FIELD_LABELS exactly, so an
 *    export can be edited and imported straight back in. Round-tripping is
 *    the difference between a report and a working document.
 */
import ExcelJS from "exceljs";
import type { Dataset, Overrides } from "./schema";
import { applyOverrides, computeScalesAndBonuses } from "./calc";

const MONEY = '"$"#,##0';
const PERCENT = "0%";

interface Column {
  header: string;
  width: number;
  /** value for one employee row */
  value: (e: ReturnType<typeof rowsFor>[number]) => string | number;
  format?: string;
}

function rowsFor(data: Dataset, overrides: Overrides) {
  const emps = applyOverrides(data.emp, overrides);
  computeScalesAndBonuses(emps, data);
  return emps;
}

/**
 * The import's 17 columns in the import's order, so the file round-trips,
 * followed by the calculated figures the import derives rather than reads.
 */
const COLUMNS: Column[] = [
  { header: "ID", width: 10, value: (e) => e.id },
  { header: "Surname", width: 16, value: (e) => e.sn },
  { header: "Given name", width: 14, value: (e) => e.gn },
  { header: "Position", width: 30, value: (e) => e.pos },
  { header: "Department", width: 24, value: (e) => e.dept },
  { header: "Manager", width: 18, value: (e) => e.mgr },
  { header: "Category", width: 18, value: (e) => e.cat },
  { header: "State", width: 9, value: (e) => e.st },
  { header: "VIC %", width: 8, value: (e) => e.vp, format: PERCENT },
  { header: "NSW %", width: 8, value: (e) => e.np, format: PERCENT },
  { header: "Package", width: 13, value: (e) => e.pkg, format: MONEY },
  { header: "Bonus %", width: 9, value: (e) => e.bpEdit, format: PERCENT },
  { header: "IPM %", width: 9, value: (e) => e.ipmEdit, format: PERCENT },
  { header: "After IPM", width: 13, value: (e) => e.bipmCalc, format: MONEY },
  { header: "Disc adj", width: 12, value: (e) => e.daEdit, format: MONEY },
  { header: "FY25 bonus", width: 13, value: (e) => e.f25, format: MONEY },
  { header: "Site manager", width: 12, value: (e) => (e.sm ? "Yes" : "No") },
  // derived — recomputed on import rather than read, but wanted in the record
  { header: "Calculated bonus", width: 16, value: (e) => e.calcBonus, format: MONEY },
  { header: "Final bonus", width: 14, value: (e) => e.finalBonus, format: MONEY },
  { header: "YoY change", width: 13, value: (e) => e.finalBonus - e.f25, format: MONEY },
  { header: "Locked", width: 9, value: (e) => (e.locked ? "Yes" : "No") },
];

export interface ExportMeta {
  /** the scheme name as it reads on the dashboard */
  schemeName: string;
  /** who produced the file */
  actor: string;
  /** ISO timestamp of the figures — a snapshot's, or now */
  asOf: string;
  /** e.g. "Draft — not final"; omitted when the banner is switched off */
  status?: string;
}

export async function buildWorkbook(
  data: Dataset,
  overrides: Overrides,
  meta: ExportMeta
): Promise<Buffer> {
  const emps = rowsFor(data, overrides);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Kestrel";
  wb.created = new Date(meta.asOf);

  // Sheet one is the table and nothing else: headers on row 1, one row per
  // person, no title block and no totals row. That is what makes the file
  // re-importable — lib/import-parse.ts reads headers from row 1 of the first
  // worksheet, and would read a totals row as an employee. Provenance and
  // totals live on the second sheet, where they can't corrupt a round trip.
  const ws = wb.addWorksheet("Bonus scheme");
  ws.addRow(COLUMNS.map((c) => c.header));
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF191919" }, // brand ink, never pure black
  };

  for (const e of emps) ws.addRow(COLUMNS.map((c) => c.value(e)));

  COLUMNS.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = c.width;
    if (c.format) {
      for (let r = 2; r <= ws.rowCount; r++) ws.getCell(r, i + 1).numFmt = c.format;
    }
  });

  // header stays put while scrolling 150+ rows, and is filterable
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1 + emps.length, column: COLUMNS.length },
  };

  // Sheet two: what this file is, when it was true, and the figures that let
  // someone reconcile it without re-adding a column. A file in a shared folder
  // has to say what it is, or it becomes indistinguishable from every other
  // version of itself.
  const about = wb.addWorksheet("Summary");
  about.getColumn(1).width = 26;
  about.getColumn(2).width = 44;
  const line = (label: string, value: string | number, format?: string) => {
    const row = about.addRow([label, value]);
    row.getCell(1).font = { bold: true };
    if (format) row.getCell(2).numFmt = format;
  };
  about.addRow([meta.schemeName]).getCell(1).font = { bold: true, size: 14 };
  about.addRow([]);
  if (meta.status) line("Status", meta.status);
  line("Figures as at", new Date(meta.asOf).toLocaleString("en-AU"));
  line("Exported by", meta.actor);
  about.addRow([]);
  line("Employees", emps.length);
  line("Total package", emps.reduce((s, e) => s + e.pkg, 0), MONEY);
  line("Total FY25 bonus", emps.reduce((s, e) => s + e.f25, 0), MONEY);
  line("Total discretionary", emps.reduce((s, e) => s + e.daEdit, 0), MONEY);
  line("Total final bonus", emps.reduce((s, e) => s + e.finalBonus, 0), MONEY);
  about.addRow([]);
  about.addRow([
    "The first sheet can be edited and imported straight back into the tool.",
  ]);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** A filename that sorts chronologically and is safe on every platform. */
export function exportFilename(schemeName: string, asOf: string): string {
  const slug = schemeName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const stamp = asOf.replace(/[:.]/g, "-").replace(/T/, "_").slice(0, 19);
  return `${slug || "bonus-scheme"}_${stamp}.xlsx`;
}
