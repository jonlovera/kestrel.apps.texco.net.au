/**
 * Reading the FY26 EBS Model workbook directly.
 *
 * The flat one-sheet-of-17-columns format (lib/import-parse.ts) is still the
 * documented contract, but the file finance actually maintains is the model
 * itself. It used to be three sheets, one per state; finance has since
 * consolidated everyone into a single "EBS Group - FY26" tab and no longer
 * maintains the old ones, so that's the only shape this reads now — an old
 * three-sheet file is refused, not silently handled by a path that no longer
 * exists (see findGroupSheet's doc comment for what "refused" looks like).
 *
 * Consolidating into one sheet removed a real source of bugs: the three old
 * sheets could — and did — disagree with each other on column position and
 * on each Shared employee's VIC/NSW split. Every employee row here carries
 * its own `VIC %` / `NSW %` directly, so state is derived from that alone,
 * with nothing to reconcile across sheets.
 *
 * Two things about this sheet are not obvious from its columns alone, and
 * getting either wrong pays someone the wrong bonus — both were confirmed
 * against real numbers, not assumed:
 *
 * 1. "PACKAGE" IS AMBIGUOUS ON PURPOSE. The sheet carries both a
 *    "Total FY26 Salary Package" and an "Eligible Salary", and they
 *    genuinely differ (a real employee: $250,000 total, $234,000 eligible).
 *    Kestrel's `pkg` — the figure that drives the whole bonus calculation —
 *    reads from Eligible Salary, because that is what the sheet's own
 *    "Bonus Potential" is actually computed from (`Eligible Salary × Bonus %`,
 *    exactly, checked on every sampled row). Total Package is imported
 *    separately as `totalPkg`, informational only.
 *
 * 2. FORMULAS ARE OFTEN UNCOMPUTED, OR CALCULATED TO A GENUINE ERROR. A
 *    workbook saved with its calculation mode set to Manual carries formulas
 *    with no cached result at all; a formula can also have calculated
 *    perfectly well to a real Excel error (#VALUE!, #N/A) that no amount of
 *    re-saving fixes. Both are hard refusals (lib/xlsx-cells.ts), with
 *    different advice for each — confirmed against a real re-saved file that
 *    had both at once.
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

const norm = (h: string) => h.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Locate the Group sheet and the year it describes.
 *
 * Anchored at both ends so "EBS Group - FY26 SM Scenario" — a what-if
 * variant sitting in the same workbook — is never mistaken for the real
 * data. If more than one year is present (last year's sheet wasn't deleted),
 * the latest wins, the same principle as before: next year's model imports
 * without a code change, and last year's is never picked up by accident.
 */
export function findGroupSheet(
  wb: ExcelJS.Workbook
): { sheet: ExcelJS.Worksheet; year: number } | null {
  const found: { year: number; sheet: ExcelJS.Worksheet }[] = [];
  wb.eachSheet((sheet) => {
    const m = /^EBS\s+Group\s*-\s*FY(\d{2})\s*$/i.exec(sheet.name.trim());
    if (m) found.push({ year: Number(m[1]), sheet });
  });
  if (found.length === 0) return null;
  const latest = found.reduce((a, b) => (b.year > a.year ? b : a));
  return latest;
}

/** Does this workbook look like the EBS model rather than a flat export? */
export function isModelWorkbook(wb: ExcelJS.Workbook): boolean {
  return findGroupSheet(wb) !== null;
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
 * How each Kestrel field is recognised in the Group sheet, resolved by
 * header text and never by position — Excel column letters are not a
 * contract, and the sheet already carries embedded newlines in some headers
 * ("Total FY26\nSalary Package") that `norm` collapses along with everything
 * else.
 *
 * `optional` marks a column that, if absent, costs the workbook nothing: it
 * is left out of `missing` entirely (so an older or differently-laid-out
 * sheet without it still imports everything else) and simply isn't populated
 * on any row, the same as an optional flat-file column.
 */
type Matcher = { label: string; test: (h: string) => boolean; optional?: boolean };

export const GROUP_COLUMNS: Record<string, Matcher> = {
  id: { label: "Employee ID", test: (h) => norm(h) === "employee id" },
  sn: { label: "Surname", test: (h) => norm(h) === "surname" },
  gn: { label: "Given Names", test: (h) => norm(h) === "given names" },
  pos: { label: "Position", test: (h) => norm(h) === "position" },
  dept: { label: "Department", test: (h) => norm(h) === "department" },
  mgr: { label: "Manager", test: (h) => norm(h) === "manager" },
  cat: { label: "Category", test: (h) => norm(h) === "category" },
  vp: { label: "VIC %", test: (h) => norm(h) === "vic %" },
  np: { label: "NSW %", test: (h) => norm(h) === "nsw %" },
  // The figure that actually drives the bonus calculation — see the module
  // comment. Not the same as "Total FY26 Salary Package" (totalPkg below),
  // and the two are read independently rather than one derived from the
  // other because they aren't related by a clean formula in the sheet.
  pkg: { label: "Eligible Salary", test: (h) => norm(h) === "eligible salary" },
  // Informational only — never used in the calc, which works off `pkg`.
  totalPkg: {
    label: "Total FY26 Salary Package",
    test: (h) => norm(h) === "total fy26 salary package",
  },
  bp: { label: "FY26 Bonus %", test: (h) => norm(h) === "fy26 bonus %" },
  ipm: { label: "IPM %", test: (h) => norm(h) === "ipm %" },
  bipm: { label: "Bonus after IPM", test: (h) => norm(h) === "bonus after ipm" },
  // The routine case: an adjustment within the normal pool ceiling. "Exceed
  // Cap Discretionary Adjustment" is a separate, presumably rare escalation
  // and is deliberately not folded in here.
  da: {
    label: "Under Cap Discretionary Adjustment",
    test: (h) => norm(h) === "under cap discretionary adjustment",
  },
  f25: { label: "FY25 Bonus Award", test: (h) => norm(h) === "fy25 bonus award" },
  // Informational only, and genuinely new: never imported before this. Marked
  // optional because it isn't essential to the payout calculation — an older
  // sheet, or one without this column for any other reason, should still
  // import everything else.
  elig: {
    label: "Eligibility %",
    test: (h) => norm(h) === "eligibility %",
    optional: true,
  },
};

/** Resolve every field to a column index. */
function mapColumns(
  ws: ExcelJS.Worksheet,
  headerRow: number
): { cols: Record<string, number>; missing: string[] } {
  const headers: { col: number; text: string }[] = [];
  ws.getRow(headerRow).eachCell({ includeEmpty: false }, (c, col) => {
    const t = headerText(c);
    if (t) headers.push({ col, text: t });
  });
  const cols: Record<string, number> = {};
  const missing: string[] = [];
  for (const [field, m] of Object.entries(GROUP_COLUMNS)) {
    const hit = headers.find((h) => m.test(h.text));
    if (hit) cols[field] = hit.col;
    else if (!m.optional) missing.push(m.label);
  }
  return { cols, missing };
}

export interface ModelReadResult {
  rows: Record<string, unknown>[];
  year: number;
  sheetsRead: string[];
}

const REQUIRED_FIELDS = [
  "sn", "gn", "pos", "dept", "mgr", "cat", "vp", "np", "pkg", "totalPkg",
  "bp", "ipm", "bipm", "da", "f25",
];

/**
 * Read the Group sheet into the same header-keyed rows a flat file produces,
 * so validation stays in one place (rowsToEmployees).
 *
 * Throws with every fault listed rather than returning partial data — an
 * import that half-worked on salary figures is worse than one that refused.
 */
export function readModelWorkbook(wb: ExcelJS.Workbook): ModelReadResult {
  const located = findGroupSheet(wb);
  if (!located) {
    throw new ModelReadError([
      "No 'EBS Group - FY26' sheet found. This importer reads the consolidated Group tab only — an older workbook laid out as separate VIC/NSW/Shared sheets is no longer supported.",
    ]);
  }
  const { sheet: ws, year } = located;

  const errors: string[] = [];
  const rows: Record<string, unknown>[] = [];
  const seen = new Map<string, number>();
  // Counted as they're found rather than recovered by matching message text
  // afterwards — a genuine #VALUE! and "no calculated value" need different
  // advice, and detecting that by substring is a needless way to get it wrong.
  let uncomputedCount = 0;
  let formulaFaultCount = 0;

  const headerRow = findHeaderRow(ws);
  if (headerRow === null) {
    throw new ModelReadError([`'${ws.name}': couldn't find the header row — no 'Employee ID' column.`]);
  }
  const { cols, missing } = mapColumns(ws, headerRow);
  if (missing.length) {
    throw new ModelReadError([
      `'${ws.name}' is missing ${missing.length > 1 ? "columns" : "a column"}: ${missing
        .map((m) => `'${m}'`)
        .join(", ")}.`,
    ]);
  }

  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const rawId = cellValue(row.getCell(cols.id));
    // Blank rows have no employee id, and the sheet's own totals row is
    // terminated with the literal text "TOTALS" in the id column, not a
    // blank one — confirmed against the real file, which carries summed
    // figures in that row's other columns. Reading it as an employee would
    // either fail validation confusingly or, worse, import fabricated totals
    // as a real person's data.
    if (
      rawId === null ||
      rawId === UNCOMPUTED ||
      isFormulaFault(rawId) ||
      String(rawId).trim() === "" ||
      String(rawId).trim().toUpperCase() === "TOTALS"
    ) {
      continue;
    }
    const id = String(rawId).trim();

    // Keyed by Kestrel's own field names, which the shared header resolver
    // accepts alongside the friendly labels — so validation, error wording
    // and the preview stay identical to a flat import.
    // __src is ignored by the header resolver; it exists so a validation
    // failure can point at the sheet and row the reader actually read.
    const rec: Record<string, unknown> = { id, __src: `'${ws.name}' row ${r}` };
    let rowFailed = false;

    for (const field of REQUIRED_FIELDS) {
      const value = cellValue(row.getCell(cols[field]));
      if (value === UNCOMPUTED) {
        errors.push(
          `'${ws.name}' row ${r} (${id}), '${GROUP_COLUMNS[field].label}': the spreadsheet has a formula here with ${UNCOMPUTED_HINT}.`
        );
        uncomputedCount++;
        rowFailed = true;
        continue;
      }
      if (isFormulaFault(value)) {
        errors.push(
          `'${ws.name}' row ${r} (${id}), '${GROUP_COLUMNS[field].label}': ${formulaFaultHint(value.code)}.`
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
          `'${ws.name}' row ${r} (${id}), '${GROUP_COLUMNS.elig.label}': the spreadsheet has a formula here with ${UNCOMPUTED_HINT}.`
        );
        uncomputedCount++;
        rowFailed = true;
      } else if (isFormulaFault(eligValue)) {
        errors.push(
          `'${ws.name}' row ${r} (${id}), '${GROUP_COLUMNS.elig.label}': ${formulaFaultHint(eligValue.code)}.`
        );
        formulaFaultCount++;
        rowFailed = true;
      } else if (eligValue !== null && eligValue !== "") {
        rec.elig = eligValue;
      }
    }

    // State comes straight from each employee's own split — no cross-sheet
    // ratio to reconcile, unlike the old three-sheet reader. A tolerance
    // rather than exact equality: VIC/NSW-only staff show a clean 1/0 in the
    // real file, but there's no guarantee every sheet writes a literal 1
    // rather than a formula that resolves to 0.999999999999 — and a false
    // SHARED there would misroute part of a real person's bonus to a pool
    // they aren't actually in.
    const vp = typeof rec.vp === "number" ? rec.vp : 0;
    const np = typeof rec.np === "number" ? rec.np : 0;
    rec.st = vp >= 0.999 ? "VIC" : np >= 0.999 ? "NSW" : "SHARED";

    // The sheet has its own Site Manager column, but in practice it's a
    // formula that's often uncomputed where Position is always readable —
    // the position-text flag is the whole of the rule, so it stays.
    rec.sm = norm(String(rec.pos ?? "")) === "site manager" ? 1 : 0;

    const dup = seen.get(id);
    if (dup) {
      errors.push(`'${id}' appears on both row ${dup} and row ${r} of '${ws.name}' — employee IDs must be unique.`);
      rowFailed = true;
    } else {
      seen.set(id, r);
    }

    if (!rowFailed) rows.push(rec);
  }

  if (errors.length) {
    // Each fault kind has one cause and one fix, and neither is obvious from
    // a list of cell references — say it once, at the top, before the
    // detail. Formula errors go first: recalculating (the uncomputed fix)
    // does nothing for them, so leading with the fix that won't work here
    // would send someone re-saving the file for no reason.
    // unshift twice, in reverse priority — the last one prepended ends up first.
    if (uncomputedCount > 0) errors.unshift(uncomputedSummary(uncomputedCount));
    if (formulaFaultCount > 0) errors.unshift(formulaFaultSummary(formulaFaultCount));
    throw new ModelReadError(errors);
  }
  if (rows.length === 0) {
    throw new ModelReadError([`'${ws.name}' contains no employee rows.`]);
  }
  return { rows, year, sheetsRead: [ws.name] };
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
