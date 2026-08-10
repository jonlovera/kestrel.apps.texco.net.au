/**
 * Reading the FY26 EBS Model workbook directly.
 *
 * The flat one-sheet-of-17-columns format (lib/import-parse.ts) is still the
 * documented contract, but the file finance actually maintains is the model
 * itself: 27 sheets, one table per state, headers on row 8, and every figure
 * arrived at by XLOOKUP across the other sheets. The brief is that the
 * spreadsheet stays the source of truth, so the importer reads that rather
 * than asking anyone to maintain a second, parallel export that would drift.
 *
 * Three things about the real file drove the design here:
 *
 * 1. THE SHEETS DISAGREE WITH EACH OTHER. Shared has no "Write Back" column,
 *    so everything past it sits one to the left; NSW labels its package column
 *    "FY25 …" where the other two say "FY26 …". Columns are therefore resolved
 *    per sheet by matching header text, never by position — a fixed-index read
 *    silently pulls "Difference between FY25 and FY24" into the FY25 bonus
 *    field on the Shared sheet, which is exactly the bug this comment exists
 *    to prevent.
 *
 * 2. THE YEAR MATTERS IN SOME HEADERS AND NOT OTHERS. "FY25 Bonus %" and
 *    "FY26 Bonus %" sit side by side, so that match is anchored to the target
 *    year. Only one "Salary Package vs Bonus Eligibility" column exists per
 *    sheet, so its year prefix — which is mistyped on NSW — is ignored.
 *
 * 3. FORMULAS ARE OFTEN UNCOMPUTED. A workbook saved by anything other than
 *    Excel carries formulas with no cached result, and no JavaScript library
 *    can evaluate an XLOOKUP chain. In the file this was built against, 50 of
 *    159 rows had at least one such cell. Reading those as 0 would quietly
 *    zero real people's salary packages and prior-year bonuses, so an
 *    uncomputed cell is a hard refusal that names the employee and tells the
 *    user to open the file in Excel and save it. Never a silent default.
 */
import ExcelJS from "exceljs";

/** Wording shared by the per-cell refusal and the guidance line above it. */
const UNCOMPUTED_HINT = "no calculated value";

/** A cell that is a formula the file carries no computed result for. */
const UNCOMPUTED = Symbol("uncomputed");

/** Read a cell down to a primitive, distinguishing "empty" from "uncomputed". */
function cellValue(cell: ExcelJS.Cell): string | number | null | typeof UNCOMPUTED {
  const v = cell.value;
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  const o = v as {
    result?: unknown;
    text?: string;
    richText?: { text: string }[];
    formula?: string;
    sharedFormula?: string;
    error?: string;
  };
  if (o.richText) return o.richText.map((r) => r.text).join("");
  if (o.error) return UNCOMPUTED;
  if (o.result !== undefined) {
    const r = o.result as unknown;
    if (r && typeof r === "object" && "error" in (r as object)) return UNCOMPUTED;
    return r as string | number | null;
  }
  if (o.text !== undefined) return o.text;
  // A formula (or a member of a shared-formula group) with no cached value.
  if (o.formula !== undefined || o.sharedFormula !== undefined) return UNCOMPUTED;
  return null;
}

/** Header text, whitespace-collapsed, for comparison. */
function headerText(cell: ExcelJS.Cell): string {
  const v = cellValue(cell);
  if (v === UNCOMPUTED || v === null) return "";
  return String(v).replace(/\s+/g, " ").trim();
}

export interface StateSheet {
  sheet: ExcelJS.Worksheet;
  /** VIC | NSW | SHARED */
  state: "VIC" | "NSW" | "SHARED";
}

/**
 * Locate the per-state FY sheets and the year they describe.
 *
 * FY25 sheets sit in the same workbook as FY26, so the latest year present is
 * chosen deliberately rather than by sheet order — next year's model imports
 * without a code change, and last year's is never picked up by accident.
 * "EBS Group - FY26" and "EBS Group - FY26 SM Scenario" are summaries, not
 * employee tables, and are skipped by requiring a known state name.
 */
export function findStateSheets(wb: ExcelJS.Workbook): {
  sheets: StateSheet[];
  year: number;
} | null {
  const found: { state: StateSheet["state"]; year: number; sheet: ExcelJS.Worksheet }[] = [];
  wb.eachSheet((sheet) => {
    const m = /^EBS\s+(VIC|NSW|Shared)\s*-\s*FY(\d{2})\s*$/i.exec(sheet.name.trim());
    if (!m) return;
    found.push({
      state: m[1].toUpperCase() as StateSheet["state"],
      year: Number(m[2]),
      sheet,
    });
  });
  if (found.length === 0) return null;
  const year = Math.max(...found.map((f) => f.year));
  return {
    year,
    sheets: found.filter((f) => f.year === year).map(({ sheet, state }) => ({ sheet, state })),
  };
}

/** Does this workbook look like the EBS model rather than a flat export? */
export function isModelWorkbook(wb: ExcelJS.Workbook): boolean {
  return findStateSheets(wb) !== null;
}

/** Row holding the column headers, found by its "Employee ID" cell. */
function findHeaderRow(ws: ExcelJS.Worksheet): number | null {
  for (let r = 1; r <= Math.min(30, ws.rowCount); r++) {
    let hit = false;
    ws.getRow(r).eachCell({ includeEmpty: false }, (c) => {
      if (headerText(c).toLowerCase() === "employee id") hit = true;
    });
    if (hit) return r;
  }
  return null;
}

/**
 * How each Kestrel field is recognised in a model sheet.
 *
 * Each matcher is handed the header text and the target financial year, so a
 * column with a prior-year twin beside it ("FY25 Bonus %" next to "FY26 Bonus
 * %") can anchor to the right one, while a column that appears only once can
 * ignore the year entirely. `label` is what the user is shown when the column
 * is missing or unreadable, so it reads as the spreadsheet's own wording.
 */
type Matcher = { label: string; test: (h: string, fy: number) => boolean };

const norm = (h: string) => h.toLowerCase().replace(/\s+/g, " ").trim();

export const MODEL_COLUMNS: Record<string, Matcher> = {
  id: { label: "Employee ID", test: (h) => norm(h) === "employee id" },
  sn: { label: "Surname", test: (h) => norm(h) === "surname" },
  gn: { label: "Given Names", test: (h) => norm(h) === "given names" },
  pos: { label: "Position", test: (h) => norm(h) === "position" },
  dept: { label: "Department", test: (h) => norm(h) === "department" },
  mgr: { label: "Manager", test: (h) => norm(h) === "manager" },
  cat: { label: "Employee Category", test: (h) => norm(h) === "employee category" },
  // The year prefix on this one is mistyped as FY25 on the NSW sheet, and
  // there is only ever one of them, so the year is deliberately not checked.
  pkg: {
    label: "Salary Package vs Bonus Eligibility",
    test: (h) => /salary package vs bonus eligibility$/.test(norm(h)),
  },
  // Sits directly beside "FY25 Bonus %" — the year has to be checked.
  bp: { label: "FY26 Bonus %", test: (h, fy) => norm(h) === `fy${fy} bonus %` },
  ipm: { label: "IPM %", test: (h) => norm(h) === "ipm %" },
  bipm: {
    label: "FY26 Bonus after IPM",
    test: (h, fy) => norm(h) === `fy${fy} bonus after ipm`,
  },
  da: { label: "Discretionary Award", test: (h) => norm(h) === "discretionary award" },
  // The prior year's paid bonus, used for the year-on-year comparison.
  f25: {
    label: "FY25 Bonus Award",
    test: (h, fy) => norm(h) === `fy${fy - 1} bonus award`,
  },
};

/** Resolve every field to a column index for one sheet. */
function mapColumns(
  ws: ExcelJS.Worksheet,
  headerRow: number,
  fy: number
): { cols: Record<string, number>; missing: string[] } {
  const headers: { col: number; text: string }[] = [];
  ws.getRow(headerRow).eachCell({ includeEmpty: false }, (c, col) => {
    const t = headerText(c);
    if (t) headers.push({ col, text: t });
  });
  const cols: Record<string, number> = {};
  const missing: string[] = [];
  for (const [field, m] of Object.entries(MODEL_COLUMNS)) {
    const hit = headers.find((h) => m.test(h.text, fy));
    if (hit) cols[field] = hit.col;
    else missing.push(m.label.replace(/FY\d\d/, `FY${field === "f25" ? fy - 1 : fy}`));
  }
  return { cols, missing };
}

/**
 * The VIC/NSW split for shared staff.
 *
 * The model keeps one workbook-level ratio in the two cells immediately above
 * the "VIC" and "NSW" headers on the Shared sheet, and applies it to everyone;
 * the columns beneath are that ratio already turned into dollars. The ratio is
 * read from those two cells, then checked against each employee's dollar split
 * so a genuine per-person exception is caught rather than averaged away.
 */
function readSharedSplit(
  ws: ExcelJS.Worksheet,
  headerRow: number
): { vp: number; np: number; vicCol: number; nswCol: number } | null {
  let vicCol = 0;
  let nswCol = 0;
  ws.getRow(headerRow).eachCell({ includeEmpty: false }, (c, col) => {
    const t = norm(headerText(c));
    if (t === "vic") vicCol = col;
    if (t === "nsw") nswCol = col;
  });
  if (!vicCol || !nswCol) return null;
  const v = cellValue(ws.getRow(headerRow - 1).getCell(vicCol));
  const n = cellValue(ws.getRow(headerRow - 1).getCell(nswCol));
  if (typeof v !== "number" || typeof n !== "number") return null;
  const total = v + n;
  if (total <= 0) return null;
  return { vp: v / total, np: n / total, vicCol, nswCol };
}

export interface ModelReadResult {
  rows: Record<string, unknown>[];
  year: number;
  sheetsRead: string[];
}

/**
 * Read the model into the same header-keyed rows a flat file produces, so
 * validation stays in one place (rowsToEmployees).
 *
 * Throws with every fault listed rather than returning partial data — an
 * import that half-worked on salary figures is worse than one that refused.
 */
export function readModelWorkbook(wb: ExcelJS.Workbook): ModelReadResult {
  const located = findStateSheets(wb);
  if (!located) throw new ModelReadError(["This doesn't look like an EBS model workbook."]);
  const { sheets, year } = located;

  const errors: string[] = [];
  const rows: Record<string, unknown>[] = [];
  const sheetsRead: string[] = [];
  const seen = new Map<string, string>();

  for (const { sheet: ws, state } of sheets) {
    const headerRow = findHeaderRow(ws);
    if (headerRow === null) {
      errors.push(`'${ws.name}': couldn't find the header row — no 'Employee ID' column.`);
      continue;
    }
    const { cols, missing } = mapColumns(ws, headerRow, year);
    if (missing.length) {
      errors.push(
        `'${ws.name}' is missing ${missing.length > 1 ? "columns" : "a column"}: ${missing
          .map((m) => `'${m}'`)
          .join(", ")}.`
      );
      continue;
    }

    let split: ReturnType<typeof readSharedSplit> = null;
    if (state === "SHARED") {
      split = readSharedSplit(ws, headerRow);
      if (!split) {
        errors.push(
          `'${ws.name}': couldn't read the VIC/NSW split — expected the two share figures directly above the 'VIC' and 'NSW' headers.`
        );
        continue;
      }
    }
    sheetsRead.push(ws.name);

    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const rawId = cellValue(row.getCell(cols.id));
      // Blank rows and the totals block below the table have no employee id.
      if (rawId === null || rawId === UNCOMPUTED || String(rawId).trim() === "") continue;
      const id = String(rawId).trim();

      // Keyed by Kestrel's own field names, which the shared header resolver
      // accepts alongside the friendly labels — so validation, error wording
      // and the preview stay identical to a flat import.
      // __src is ignored by the header resolver; it exists so a validation
      // failure can point at the sheet and row the reader actually read,
      // rather than a position in a flat file that doesn't exist here.
      const rec: Record<string, unknown> = { id, st: state, __src: `'${ws.name}' row ${r}` };
      let rowFailed = false;

      for (const field of ["sn", "gn", "pos", "dept", "mgr", "cat", "pkg", "bp", "ipm", "bipm", "da", "f25"]) {
        const value = cellValue(row.getCell(cols[field]));
        if (value === UNCOMPUTED) {
          errors.push(
            `'${ws.name}' row ${r} (${id}), '${MODEL_COLUMNS[field].label}': the spreadsheet has a formula here with ${UNCOMPUTED_HINT}.`
          );
          rowFailed = true;
          continue;
        }
        // Discretionary and prior-year bonus are legitimately blank for a new
        // starter; the rest being blank is a fault zod will name.
        rec[field] =
          value === null || value === "" ? (field === "da" || field === "f25" ? 0 : "") : value;
      }

      if (split) {
        rec.vp = split.vp;
        rec.np = split.np;
        const vic = cellValue(row.getCell(split.vicCol));
        const nsw = cellValue(row.getCell(split.nswCol));
        if (typeof vic === "number" && typeof nsw === "number" && vic + nsw > 0) {
          const implied = vic / (vic + nsw);
          if (Math.abs(implied - split.vp) > 0.001) {
            errors.push(
              `'${ws.name}' row ${r} (${id}): this person's VIC/NSW split (${(implied * 100).toFixed(1)}%) doesn't match the sheet's (${(split.vp * 100).toFixed(1)}%). Kestrel applies one split to everyone shared.`
            );
            rowFailed = true;
          }
        }
      } else {
        rec.vp = state === "VIC" ? 1 : 0;
        rec.np = state === "NSW" ? 1 : 0;
      }

      // The model has no site-manager column; the position is the flag, and it
      // is the whole of the rule — site managers are paid their after-IPM
      // figure unscaled, so a wrong answer here changes what someone is paid.
      rec.sm = norm(String(rec.pos ?? "")) === "site manager" ? 1 : 0;

      const dup = seen.get(id);
      if (dup) {
        errors.push(`'${id}' appears on both '${dup}' and '${ws.name}' — employee IDs must be unique.`);
        rowFailed = true;
      } else {
        seen.set(id, ws.name);
      }

      if (!rowFailed) rows.push(rec);
    }
  }

  if (errors.length) {
    // Uncomputed formulas have one cause and one fix, and neither is obvious
    // from a list of cell references. Say it once, at the top, before the
    // detail — otherwise the reader is left with 125 identical complaints and
    // no idea what to do about them.
    const uncomputed = errors.filter((e) => e.includes(UNCOMPUTED_HINT)).length;
    if (uncomputed > 0) {
      errors.unshift(
        `${uncomputed} figure${uncomputed > 1 ? "s are" : " is"} stored in the spreadsheet as a formula that hasn't been calculated, so ${uncomputed > 1 ? "they" : "it"} can't be read. Open the file in Excel, save it, and upload it again — Excel writes the calculated values as it saves. Nothing has been changed in the meantime.`
      );
    }
    throw new ModelReadError(errors);
  }
  if (rows.length === 0) {
    throw new ModelReadError(["The model's state sheets contain no employee rows."]);
  }
  return { rows, year, sheetsRead };
}

/** Carries every fault so the UI can list them, not just the first. */
export class ModelReadError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(errors[0] ?? "The model workbook couldn't be read.");
    this.name = "ModelReadError";
    // Cap the list: 159 rows × a broken column is not a readable error page.
    this.errors =
      errors.length > 25
        ? [...errors.slice(0, 25), `…and ${errors.length - 25} more.`]
        : errors;
  }
}
