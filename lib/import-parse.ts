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
import { applyOverrides, computeScalesAndBonuses, isLockable, rowRule } from "./calc";
import { deriveFacets, isSplit } from "./dataset-edit";
import { isModelWorkbook, readModelWorkbook } from "./import-model";
import {
  cellValue,
  UNCOMPUTED,
  UNCOMPUTED_HINT,
  uncomputedSummary,
  isFormulaFault,
  formulaFaultHint,
  formulaFaultSummary,
  ImportError,
} from "./xlsx-cells";

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

/**
 * Recognised, but never required — a file that has always worked without
 * these columns must keep working. `elig` (Eligibility %) and `totalPkg`
 * (Total Package) are informational figures most flat files won't carry;
 * `EmployeeSchema` makes both optional to match.
 */
const OPTIONAL_FIELD_LABELS: Record<string, string> = {
  elig: "Eligibility %",
  totalPkg: "Total Package",
};
const ALL_LABELS: Record<string, string> = { ...FIELD_LABELS, ...OPTIONAL_FIELD_LABELS };

/** header text (raw key or friendly label, any case) → field key */
function headerToField(header: string): string | null {
  const h = header.trim().toLowerCase();
  for (const f of Object.keys(ALL_LABELS)) {
    // f.toLowerCase(), not f: every field key was lowercase-by-convention
    // until totalPkg, whose capital P otherwise never matched its own raw
    // key here — a real miss, not a hypothetical one.
    if (h === f.toLowerCase() || h === ALL_LABELS[f].toLowerCase()) return f;
  }
  return null;
}

const NUMERIC_KEYS = new Set([
  "vp",
  "np",
  "pkg",
  "totalPkg",
  "bp",
  "ipm",
  "bipm",
  "da",
  "f25",
  "elig",
]);

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
    if (cleaned === "") {
      // A blank cell in an optional column means "not provided", which is a
      // legal value — the export writes blanks for people without these
      // figures, and the round trip must accept its own output. A blank in a
      // required column stays "" so zod names the fault loudly.
      if (field in OPTIONAL_FIELD_LABELS) return undefined;
      return s === "" ? "" : s;
    }
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
  const seen = new Map<string, string>();

  rawRows.forEach((raw, idx) => {
    // A flat file's row number matches what she sees in Excel; the model
    // reader supplies its own sheet-and-row label instead, because its rows
    // come from three sheets and start well below row 2.
    const where =
      typeof raw.__src === "string" ? raw.__src : `Row ${idx + 2}`;
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
        errors.push(`${where}, '${label}': ${expected}, got ${gotText}`);
      }
      return;
    }
    const dup = seen.get(parsed.data.id);
    if (dup !== undefined) {
      errors.push(
        // "…on row 2" for a flat file, "…on 'EBS VIC - FY26' row 9" for the
        // model — the sheet name keeps its capitals, a bare row number doesn't.
        `${where}, 'ID': '${parsed.data.id}' also appears on ${
          dup.startsWith("Row ") ? dup.toLowerCase() : dup
        } — IDs must be unique`
      );
      return;
    }
    seen.set(parsed.data.id, where);
    employees.push(parsed.data);
  });

  if (errors.length) return { ok: false, errors: errors.slice(0, 50) };
  return { ok: true, employees };
}

export interface ParsedFile {
  rows: Record<string, unknown>[];
  /**
   * employee id → the sheet's own frozen bonus figure, from the model
   * workbook's "Locked Amount" column. Always empty for a flat file/CSV —
   * that format has no equivalent concept, and this is never asked of it.
   */
  lockedAmounts: Record<string, number>;
  /**
   * Pool caps read from the model workbook's own parameter cells. Undefined
   * for a flat file/CSV (never had this concept) — candidateDataset() falls
   * back to carrying the current dataset's caps over when this is absent.
   */
  caps?: { vCap: number; nCap: number; gCap: number };
}

/** Parse an uploaded file (xlsx or csv) into header-keyed raw rows. */
export async function parseImportFile(
  filename: string,
  buf: Buffer
): Promise<ParsedFile> {
  if (/\.(xlsx|xlsm)$/i.test(filename)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);

    // The EBS model is the file finance actually keeps, so it is read on its
    // own terms (lib/import-model.ts) rather than being rejected for not
    // looking like a flat export. Detection is by its per-state FY sheets, so
    // an ordinary spreadsheet can never take this path by accident.
    if (isModelWorkbook(wb)) {
      const { rows, lockedAmounts, caps } = readModelWorkbook(wb);
      return { rows, lockedAmounts, caps };
    }

    const ws = wb.worksheets[0];
    if (!ws) return { rows: [], lockedAmounts: {} };
    const headers: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
      headers[col] = String(cell.value ?? "").trim();
    });
    const rows: Record<string, unknown>[] = [];
    // A formula with no cached value used to become the literal object here,
    // which then either produced a confusing "expected a number, got
    // '[object Object]'" on a numeric column, or — worse — was silently
    // stringified into a text column with no error at all. Collected across
    // the whole sheet and refused up front, the same as the model importer
    // (lib/xlsx-cells.ts): a file that half-imports garbage is worse than one
    // that names every affected cell and asks for a re-save. The two fault
    // kinds are counted separately (not recovered from message text
    // afterwards) because they need different advice: an uncomputed formula
    // is fixed by a full recalculation before saving, but a formula that
    // already calculated to #VALUE!/#N/A stays broken no matter how many
    // times it's saved — confirmed against a real re-saved workbook that hit
    // exactly this.
    const formulaErrors: string[] = [];
    let uncomputedCount = 0;
    let formulaFaultCount = 0;
    ws.eachRow((row, rowNo) => {
      if (rowNo === 1) return;
      const obj: Record<string, unknown> = {};
      let hasValue = false;
      headers.forEach((h, col) => {
        if (!h) return;
        const v = cellValue(row.getCell(col));
        if (v === UNCOMPUTED) {
          formulaErrors.push(
            `Row ${rowNo}, '${h}': the spreadsheet has a formula here with ${UNCOMPUTED_HINT}.`
          );
          uncomputedCount++;
          return;
        }
        if (isFormulaFault(v)) {
          formulaErrors.push(`Row ${rowNo}, '${h}': ${formulaFaultHint(v.code)}.`);
          formulaFaultCount++;
          return;
        }
        if (v !== null && v !== "") hasValue = true;
        obj[h] = v ?? "";
      });
      if (hasValue) rows.push(obj);
    });
    if (formulaErrors.length) {
      const summary: string[] = [];
      if (formulaFaultCount > 0) summary.push(formulaFaultSummary(formulaFaultCount));
      if (uncomputedCount > 0) summary.push(uncomputedSummary(uncomputedCount));
      throw new ImportError([...summary, ...formulaErrors]);
    }
    return { rows, lockedAmounts: {} };
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
  return { rows: result.data, lockedAmounts: {} };
}

export interface ImportPreview {
  rowCount: number;
  added: string[];
  removed: string[];
  /** removed employees who have manager-entered edits — needs confirmation */
  removedWithData: string[];
}

/**
 * Shape imported employees into a dataset. The permanent exclude list always
 * carries over from the current dataset (never comes from a spreadsheet),
 * and anyone on it is dropped here — before the added/removed diff is even
 * computed — so a future import can never quietly bring an excluded person
 * back just because the spreadsheet still lists them.
 *
 * Pool caps: the model workbook reads its own ("VIC/NSW Pool Cap") cells
 * (lib/import-model.ts) and is authoritative for them, the same as every
 * other figure it carries — so when `caps` is supplied, it replaces
 * whatever's currently stored. A flat file/CSV has no such concept, so caps
 * still carry over from the current dataset for that path (`caps` absent).
 *
 * Home state on a split person is the one thing an import does NOT overwrite,
 * per preserveSplitHomeState below.
 */
export function candidateDataset(
  current: Dataset,
  employees: Employee[],
  caps?: { vCap: number; nCap: number; gCap: number }
): Dataset {
  const excluded = new Set(current.excludedIds);
  const kept = preserveSplitHomeState(
    current.emp,
    employees.filter((e) => !excluded.has(e.id))
  );
  return {
    emp: kept,
    vCap: caps?.vCap ?? current.vCap,
    nCap: caps?.nCap ?? current.nCap,
    gCap: caps?.gCap ?? current.gCap,
    excludedIds: current.excludedIds,
    ...deriveFacets(kept),
  };
}

/**
 * Keep an admin's home-state decision for people whose cost splits across both
 * pools. The model workbook has no state column — lib/import-model.ts INFERS
 * state from the split, so anyone fractional comes back as SHARED. That is a
 * guess about a funding fact, and it is wrong for the VIC staff who do a
 * portion of NSW work: they belong on the VIC tab and in the VIC pool card
 * with their cost still divided.
 *
 * So when someone is already flagged VIC or NSW with a fractional split and
 * the sheet still splits them, their state survives the import. Everything
 * else stays the workbook's call:
 *
 *  - the split itself is always the sheet's, percentages and all, so a
 *    92/8 moving to 85/15 lands as VIC 85/15 rather than reverting to SHARED;
 *  - a split collapsing to a clean 1/0 IS a real move, so the inferred state
 *    wins there;
 *  - new people always take the inferred state — there is no decision to keep;
 *  - anyone an admin has deliberately flagged SHARED is untouched.
 *
 * One consequence worth knowing: a flat file that explicitly writes State =
 * SHARED for a person flagged VIC-with-a-split is overridden back to VIC. The
 * app's own XLSX export writes their real state, so an export round trip is
 * unaffected; re-flagging them Shared is an edit-modal action.
 */
function preserveSplitHomeState(current: Employee[], incoming: Employee[]): Employee[] {
  const byId = new Map(current.map((e) => [e.id, e]));
  return incoming.map((e) => {
    const cur = byId.get(e.id);
    const keep =
      cur &&
      e.st === "SHARED" &&
      cur.st !== "SHARED" &&
      isSplit(cur.vp) &&
      isSplit(e.vp);
    return keep ? { ...e, st: cur.st } : e;
  });
}

/**
 * The sheet's "Locked Amount" cells that may become lock overrides: only ids
 * present in the candidate roster whose row is actually lockable (isLockable,
 * the same rule /api/state's Gate 2 enforces on every save). A model workbook
 * carries Locked Amounts for site managers and out-of-pool rows too; letting
 * those through created locks the UI can't show or clear, which the next
 * ordinary save then stripped and logged as a pile of "Unlocked" history
 * entries nobody asked for.
 */
export function filterImportedLocks(
  emp: Employee[],
  lockedAmounts: Record<string, number>
): [string, number][] {
  const lockable = new Set(
    emp.filter((e) => isLockable(rowRule(e))).map((e) => e.id)
  );
  return Object.entries(lockedAmounts).filter(([id]) => lockable.has(id));
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
