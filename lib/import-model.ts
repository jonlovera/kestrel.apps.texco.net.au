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
import {
  cellValue,
  UNCOMPUTED,
  UNCOMPUTED_HINT,
  uncomputedSummary,
  isFormulaFault,
  formulaFaultHint,
  formulaFaultSummary,
  ImportError as ModelReadError,
} from "./xlsx-cells";

/** Header text, whitespace-collapsed, for comparison. */
function headerText(cell: ExcelJS.Cell): string {
  const v = cellValue(cell);
  if (v === UNCOMPUTED || v === null || isFormulaFault(v)) return "";
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
 *
 * `optional` marks a column that, if absent, costs the workbook nothing: it
 * is left out of `missing` entirely (so an older or differently-laid-out
 * sheet without it still imports everything else) and simply isn't populated
 * on any row, the same as an optional flat-file column.
 */
type Matcher = {
  label: string;
  test: (h: string, fy: number) => boolean;
  optional?: boolean;
};

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
  // Informational only, and genuinely new: never imported before this. Marked
  // optional because it isn't essential to the payout calculation, which
  // already works off `pkg` — an older sheet, or one without this column for
  // any other reason, should still import everything else.
  elig: {
    label: "Bonus Scheme Eligibility",
    test: (h) => norm(h) === "bonus scheme eligibility",
    optional: true,
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
    else if (!m.optional)
      missing.push(m.label.replace(/FY\d\d/, `FY${field === "f25" ? fy - 1 : fy}`));
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
  // Counted as they're found rather than recovered by matching message text
  // afterwards — a genuine #VALUE! and "no calculated value" need different
  // advice, and detecting that by substring is a needless way to get it wrong.
  let uncomputedCount = 0;
  let formulaFaultCount = 0;

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
      if (
        rawId === null ||
        rawId === UNCOMPUTED ||
        isFormulaFault(rawId) ||
        String(rawId).trim() === ""
      ) {
        continue;
      }
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
          uncomputedCount++;
          rowFailed = true;
          continue;
        }
        if (isFormulaFault(value)) {
          errors.push(
            `'${ws.name}' row ${r} (${id}), '${MODEL_COLUMNS[field].label}': ${formulaFaultHint(value.code)}.`
          );
          formulaFaultCount++;
          rowFailed = true;
          continue;
        }
        // Discretionary and prior-year bonus are legitimately blank for a new
        // starter; the rest being blank is a fault zod will name.
        rec[field] =
          value === null || value === "" ? (field === "da" || field === "f25" ? 0 : "") : value;
      }

      // Optional: only read when the sheet actually has the column. Left
      // unset (not even a blank string) when it doesn't, matching a flat
      // file that simply omits it — EmployeeSchema treats it as undefined.
      if (cols.elig !== undefined) {
        const eligValue = cellValue(row.getCell(cols.elig));
        if (eligValue === UNCOMPUTED) {
          errors.push(
            `'${ws.name}' row ${r} (${id}), '${MODEL_COLUMNS.elig.label}': the spreadsheet has a formula here with ${UNCOMPUTED_HINT}.`
          );
          uncomputedCount++;
          rowFailed = true;
        } else if (isFormulaFault(eligValue)) {
          errors.push(
            `'${ws.name}' row ${r} (${id}), '${MODEL_COLUMNS.elig.label}': ${formulaFaultHint(eligValue.code)}.`
          );
          formulaFaultCount++;
          rowFailed = true;
        } else if (eligValue !== null && eligValue !== "") {
          rec.elig = eligValue;
        }
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
    // Each fault kind has one cause and one fix, and neither is obvious from
    // a list of cell references — say it once, at the top, before the
    // detail. Formula errors go first: recalculating (the uncomputed fix)
    // does nothing for them, so leading with the fix that won't work here
    // would send someone re-saving the file for no reason.
    // unshift twice, in reverse priority — the last one prepended ends up first
    if (uncomputedCount > 0) errors.unshift(uncomputedSummary(uncomputedCount));
    if (formulaFaultCount > 0) errors.unshift(formulaFaultSummary(formulaFaultCount));
    throw new ModelReadError(errors);
  }
  if (rows.length === 0) {
    throw new ModelReadError(["The model's state sheets contain no employee rows."]);
  }
  return { rows, year, sheetsRead };
}

/**
 * Named for where it was born, but the class itself moved to
 * lib/xlsx-cells.ts as the generic `ImportError` — lib/import-parse.ts's flat
 * path throws the same class for its own formula-cell faults now, and giving
 * it a "Model"-specific name would have been misleading there. Re-exported
 * under this name so nothing that already catches `ModelReadError` — this
 * file's own throws, the API route, the test — needed to change.
 */
export { ModelReadError };
