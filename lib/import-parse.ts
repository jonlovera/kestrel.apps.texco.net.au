/**
 * Import-file parsing and validation — no server-only imports so every rule
 * is unit-testable. xlsx via exceljs, csv via papaparse (SheetJS is banned:
 * unpatched advisories).
 *
 * Errors are plain English and name the row and column:
 *   Row 14, 'Bonus %': expected a number, got 'abc'
 * A file either imports completely or not at all.
 */
import Papa from "papaparse";
import ExcelJS from "exceljs";
import {
  EmployeeSchema,
  type Employee,
  type Overrides,
  type Dataset,
} from "./schema";
import { applyOverrides, computeScalesAndBonuses } from "./calc";
import { deriveFacets } from "./dataset-edit";

/** Header labels accepted in files (case-insensitive), keyed by field. */
export const FIELD_LABELS: Record<string, string> = {
  id: "ID",
  sn: "Surname",
  gn: "Given name",
  pos: "Position",
  dept: "Department",
  mgr: "Manager",
  cat: "Category",
  st: "State",
  vp: "VIC %",
  np: "NSW %",
  pkg: "Package",
  bp: "Bonus %",
  ipm: "IPM %",
  bipm: "After IPM",
  da: "Disc adj",
  f25: "FY25 bonus",
  sm: "Site manager",
};
const FIELDS = Object.keys(FIELD_LABELS);

/** header text (raw key or friendly label, any case) → field key */
function headerToField(header: string): string | null {
  const h = header.trim().toLowerCase();
  for (const f of FIELDS) {
    if (h === f || h === FIELD_LABELS[f].toLowerCase()) return f;
  }
  return null;
}

const NUMERIC_KEYS = new Set(["vp", "np", "pkg", "bp", "ipm", "bipm", "da", "f25"]);

function coerceCell(field: string, raw: unknown): unknown {
  const s = typeof raw === "string" ? raw.trim() : raw;
  if (field === "sm") {
    if (typeof s === "number") return s === 0 ? 0 : 1;
    const t = String(s ?? "").toLowerCase();
    if (["1", "true", "yes", "y"].includes(t)) return 1;
    if (["0", "false", "no", "n", ""].includes(t)) return 0;
    return s; // let zod produce the error
  }
  if (NUMERIC_KEYS.has(field)) {
    if (typeof s === "number") return s;
    const str = String(s ?? "");
    const isPercent = str.includes("%");
    const cleaned = str.replace(/[$,%\s]/g, "");
    if (cleaned === "") return s === "" ? "" : s;
    const n = Number(cleaned);
    if (Number.isNaN(n)) return s;
    // "20%" means the fraction 0.2 (matches how Excel shows these columns)
    return isPercent ? n / 100 : n;
  }
  return String(s ?? "");
}

export interface ParseFailure {
  ok: false;
  errors: string[];
}
export interface ParseSuccess {
  ok: true;
  employees: Employee[];
}
export type ParseResult = ParseFailure | ParseSuccess;

/** Turn header-keyed raw rows into validated employees, or name every fault. */
export function rowsToEmployees(rawRows: Record<string, unknown>[]): ParseResult {
  if (rawRows.length === 0) {
    return { ok: false, errors: ["The file contains no data rows."] };
  }

  // Resolve headers once, from the first row's keys.
  const headerMap = new Map<string, string>(); // original header -> field
  for (const header of Object.keys(rawRows[0])) {
    const field = headerToField(header);
    if (field) headerMap.set(header, field);
  }
  const found = new Set(headerMap.values());
  const missing = FIELDS.filter((f) => !found.has(f));
  if (missing.length) {
    return {
      ok: false,
      errors: [
        `Missing column${missing.length > 1 ? "s" : ""}: ${missing
          .map((f) => `'${FIELD_LABELS[f]}'`)
          .join(", ")}. The file needs one column per field — headers can be the short keys (${missing.join(", ")}) or the labels shown.`,
      ],
    };
  }

  const errors: string[] = [];
  const employees: Employee[] = [];
  const seen = new Map<string, number>();

  rawRows.forEach((raw, idx) => {
    const rowNo = idx + 2; // 1-based + header row, matching what she sees in Excel
    const candidate: Record<string, unknown> = {};
    for (const [header, field] of headerMap) {
      candidate[field] = coerceCell(field, raw[header]);
    }
    const parsed = EmployeeSchema.safeParse(candidate);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? "?");
        const label = FIELD_LABELS[field] ?? field;
        const got = candidate[field];
        const gotText =
          got === "" || got === undefined || got === null
            ? "nothing"
            : `'${String(got)}'`;
        const expected =
          issue.code === "invalid_type"
            ? `expected a ${(issue as { expected?: string }).expected ?? "value"}`
            : issue.message.toLowerCase();
        errors.push(`Row ${rowNo}, '${label}': ${expected}, got ${gotText}`);
      }
      return;
    }
    const dup = seen.get(parsed.data.id);
    if (dup !== undefined) {
      errors.push(
        `Row ${rowNo}, 'ID': '${parsed.data.id}' also appears on row ${dup} — IDs must be unique`
      );
      return;
    }
    seen.set(parsed.data.id, rowNo);
    employees.push(parsed.data);
  });

  if (errors.length) return { ok: false, errors: errors.slice(0, 50) };
  return { ok: true, employees };
}

/** Parse an uploaded file (xlsx or csv) into header-keyed raw rows. */
export async function parseImportFile(
  filename: string,
  buf: Buffer
): Promise<Record<string, unknown>[]> {
  if (/\.(xlsx|xlsm)$/i.test(filename)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const headers: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
      headers[col] = String(cell.value ?? "").trim();
    });
    const rows: Record<string, unknown>[] = [];
    ws.eachRow((row, rowNo) => {
      if (rowNo === 1) return;
      const obj: Record<string, unknown> = {};
      let hasValue = false;
      headers.forEach((h, col) => {
        if (!h) return;
        const cell = row.getCell(col);
        let v: unknown = cell.value;
        // exceljs wraps formulas/rich text; unwrap to the displayed value
        if (v && typeof v === "object") {
          const o = v as { result?: unknown; text?: string; richText?: { text: string }[] };
          if (o.result !== undefined) v = o.result;
          else if (o.text !== undefined) v = o.text;
          else if (o.richText) v = o.richText.map((r) => r.text).join("");
        }
        if (v !== null && v !== undefined && v !== "") hasValue = true;
        obj[h] = v ?? "";
      });
      if (hasValue) rows.push(obj);
    });
    return rows;
  }

  const text = buf.toString("utf-8");
  const result = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: true,
  });
  if (result.errors.length) {
    // papaparse reports structural CSV faults (unclosed quotes etc.)
    const e = result.errors[0];
    throw new Error(
      `The CSV file couldn't be read (row ${(e.row ?? 0) + 2}): ${e.message}`
    );
  }
  return result.data;
}

export interface ImportPreview {
  rowCount: number;
  added: string[];
  removed: string[];
  /** removed employees who have manager-entered edits — needs confirmation */
  removedWithData: string[];
}

/** Shape imported employees into a dataset (caps kept, filter lists derived). */
export function candidateDataset(current: Dataset, employees: Employee[]): Dataset {
  return {
    emp: employees,
    vCap: current.vCap,
    nCap: current.nCap,
    gCap: current.gCap,
    ...deriveFacets(employees),
  };
}

/** Baseline pool total for a dataset+overrides, through the real engine. */
export function totalPool(data: Dataset, overrides: Overrides): number {
  const emps = applyOverrides(data.emp, overrides);
  computeScalesAndBonuses(emps, data);
  return emps.reduce((s, e) => s + e.finalBonus, 0);
}

/** Compare incoming employees to the current dataset. Names, not ids. */
export function buildImportPreview(
  current: Employee[],
  incoming: Employee[],
  overrides: Overrides
): ImportPreview {
  const name = (e: Employee) => `${e.gn} ${e.sn}`;
  const currentIds = new Map(current.map((e) => [e.id, e]));
  const incomingIds = new Set(incoming.map((e) => e.id));
  const added = incoming.filter((e) => !currentIds.has(e.id)).map(name);
  const removedEmps = current.filter((e) => !incomingIds.has(e.id));
  const removed = removedEmps.map(name);
  const removedWithData = removedEmps
    .filter((e) => overrides[e.id] && Object.keys(overrides[e.id]).length > 0)
    .map(name);
  return { rowCount: incoming.length, added, removed, removedWithData };
}
