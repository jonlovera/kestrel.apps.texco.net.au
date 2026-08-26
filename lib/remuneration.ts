/**
 * The FY27 remuneration review — who moved package, and by how much.
 *
 * Reads the master workbook HR keeps
 * ("MASTER_Texco_ Remuneration_FY27 Remuneration Reviews.xlsx") and reduces it
 * to one row per person: the package they are on now and the one the review
 * lands them on. Nothing here touches the bonus engine — a package increase is
 * not a bonus figure and must never feed lib/calc.ts.
 *
 * WHY THIS EXISTS. lib/letter-docx.ts states a person's FY27 package from
 * `emp.pkg` and always takes the template's "no increase" paragraph, because
 * until now the app held no remuneration data at all (see the comment at its
 * FY27 section). This module is that missing input. The letter is deliberately
 * NOT wired to it yet.
 *
 * NOTHING IS ADDRESSED BY COLUMN INDEX. The workbook is re-saved by hand every
 * cycle and columns move; the header row is found by its labels and every
 * column resolved off that row, the same discipline lib/letter-docx.ts applies
 * to the letter template for the same reason. A workbook that no longer carries
 * the two figures fails loudly rather than importing a sheet of zeroes.
 *
 * Pure: no I/O and no server-only imports, so the suite reads a workbook it
 * built in memory. Cell reading, and the two different formula faults it has to
 * tell apart, come from lib/xlsx-cells.ts — the same reader the employee import
 * uses, so a half-calculated workbook gets the same usable advice here as there.
 */
import { z } from "zod";
import type ExcelJS from "exceljs";
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

/**
 * Rounding slack, in dollars. Package figures are whole dollars in practice,
 * but they arrive through Excel arithmetic; a cent of float noise must not be
 * reported to somebody as a pay rise. Same value and reasoning as
 * lib/manager-pool.ts and lib/da-impact.ts.
 */
export const EPSILON = 0.01;

export const PackageRowSchema = z.object({
  /** Jobpac Employee ID — the same id lib/schema.ts's Employee carries. */
  id: z.string().min(1),
  email: z.string().optional(),
  name: z.string(),
  title: z.string().optional(),
  dept: z.string().optional(),
  /** what they are on today, per the review sheet */
  current: z.number(),
  /** what the review puts them on */
  fy27: z.number(),
  /** fy27 - current; negative is possible and is not filtered out */
  increase: z.number(),
  /** increase as a fraction of `current`, 0 when current is 0 */
  increasePct: z.number(),
  /** whether the package actually moved (|increase| > EPSILON) */
  increased: z.boolean(),
  /** the sheet's own "Insert Rem Increase" figures, kept for reconciliation */
  sheetIncrease: z.number().optional(),
  sheetIncreasePct: z.number().optional(),
  /** blank throughout the 25 Aug 2026 file; read so a later cycle has it */
  approval: z.string().optional(),
  hold: z.string().optional(),
  /**
   * Whether this id matched somebody in the bonus dataset. The review covers
   * more people than the bonus scheme does (176 against 146 in the 25 Aug 2026
   * file), and a row that matches nobody can never produce a letter — so it is
   * carried and counted rather than dropped silently.
   */
  inDataset: z.boolean(),
});
export type PackageRow = z.infer<typeof PackageRowSchema>;

export const PackageIncreaseDocSchema = z.object({
  uploadedAt: z.string(),
  uploadedBy: z.string(),
  filename: z.string(),
  rows: z.array(PackageRowSchema),
});
export type PackageIncreaseDoc = z.infer<typeof PackageIncreaseDocSchema>;

/**
 * Header labels, keyed by field. Matched case-insensitively with runs of
 * whitespace collapsed, because several of these are wrapped mid-label in the
 * real file ("FY27 Salary \nPackage", "Insert Rem Increase\n $").
 */
const LABELS = {
  id: "Jobpac Employee ID",
  email: "Email",
  gn: "First name",
  sn: "Last name",
  title: "Job title",
  dept: "Department",
  current: "Current Total Salary Package",
  fy27: "FY27 Salary Package",
  sheetIncrease: "Insert Rem Increase $",
  sheetIncreasePct: "Insert Rem Increase %",
  approval: "Director Approval",
  hold: "HOLD/RELEASE",
} as const;
type Field = keyof typeof LABELS;

/** The three the sheet is useless without. */
const REQUIRED: Field[] = ["id", "current", "fy27"];

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** How far down to look for the header row (it is row 2 in the real file). */
const HEADER_SEARCH_ROWS = 12;

export interface HeaderMatch {
  row: number;
  cols: Partial<Record<Field, number>>;
}

/**
 * Find the header row and resolve every column off it. Returns null when this
 * sheet doesn't carry the review at all, so the caller can try the next one.
 */
export function findHeader(ws: ExcelJS.Worksheet): HeaderMatch | null {
  const wanted = new Map<string, Field>();
  for (const [field, label] of Object.entries(LABELS)) {
    wanted.set(norm(label), field as Field);
  }
  const limit = Math.min(ws.rowCount, HEADER_SEARCH_ROWS);
  for (let r = 1; r <= limit; r++) {
    const cols: Partial<Record<Field, number>> = {};
    const row = ws.getRow(r);
    for (let c = 1; c <= ws.columnCount; c++) {
      const v = cellValue(row.getCell(c));
      if (typeof v !== "string" && typeof v !== "number") continue;
      const field = wanted.get(norm(String(v)));
      // First column wins: a duplicated label later in the sheet must not
      // silently re-point a field that already resolved.
      if (field && cols[field] === undefined) cols[field] = c;
    }
    if (REQUIRED.every((f) => cols[f] !== undefined)) return { row: r, cols };
  }
  return null;
}

/** The sheet carrying the review, or null if no sheet in the book does. */
function findSheet(
  wb: ExcelJS.Workbook
): { ws: ExcelJS.Worksheet; header: HeaderMatch } | null {
  for (const ws of wb.worksheets) {
    const header = findHeader(ws);
    if (header) return { ws, header };
  }
  return null;
}

/** Excel's A/B/…/AA column letters, for naming a faulty cell the way Excel does. */
function colLetter(n: number): string {
  let s = "";
  let x = n;
  while (x > 0) {
    const rem = (x - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

/** A cell read as text, with blanks and unreadable formulas alike becoming "". */
function text(v: ReturnType<typeof cellValue>): string {
  if (v === null || v === UNCOMPUTED || isFormulaFault(v)) return "";
  return String(v).trim();
}

/**
 * Read the review out of a workbook.
 *
 * `knownIds` is the bonus dataset's employee ids, used only to set `inDataset`
 * — a row is never dropped for missing from it.
 *
 * Throws ImportError listing EVERY unreadable package figure rather than the
 * first: a workbook saved with calculation set to Manual leaves a whole column
 * uncomputed, and fixing that one round trip at a time is what the employee
 * importer already learned not to ask for.
 */
export function readRemunerationWorkbook(
  wb: ExcelJS.Workbook,
  knownIds: ReadonlySet<string> = new Set()
): PackageRow[] {
  const found = findSheet(wb);
  if (!found) {
    throw new ImportError([
      `This doesn't look like the FY27 remuneration review. The sheet needs a header row carrying '${LABELS.id}', '${LABELS.current}' and '${LABELS.fy27}' — none of the sheets in this file has all three.`,
    ]);
  }
  const { ws, header } = found;
  const col = header.cols;
  const at = (r: number, f: Field) => {
    const c = col[f];
    return c === undefined ? null : cellValue(ws.getRow(r).getCell(c));
  };

  const faults: string[] = [];
  let uncomputedCount = 0;
  let formulaFaultCount = 0;
  const rows: PackageRow[] = [];

  for (let r = header.row + 1; r <= ws.rowCount; r++) {
    const id = text(at(r, "id"));
    const email = text(at(r, "email"));
    // A sheet has trailing and interleaved blanks; a row with neither an id nor
    // an email is not a person.
    if (!id && !email) continue;

    // Both figures are read before either is judged, so one broken row reports
    // both of its faults in a single pass rather than over two uploads.
    const money: Partial<Record<"current" | "fy27", number>> = {};
    let broken = false;
    for (const f of ["current", "fy27"] as const) {
      const v = at(r, f);
      const where = `Row ${r}, '${LABELS[f]}' (${colLetter(col[f]!)}${r})`;
      if (v === UNCOMPUTED) {
        faults.push(`${where}: the spreadsheet has a formula here with ${UNCOMPUTED_HINT}.`);
        uncomputedCount++;
        broken = true;
        continue;
      }
      if (isFormulaFault(v)) {
        faults.push(`${where}: ${formulaFaultHint(v.code)}.`);
        formulaFaultCount++;
        broken = true;
        continue;
      }
      if (typeof v === "number") {
        money[f] = v;
        continue;
      }
      const cleaned = String(v ?? "").replace(/[$,\s]/g, "");
      if (cleaned === "") continue; // genuinely blank — handled below
      const n = Number(cleaned);
      if (Number.isNaN(n)) {
        faults.push(`${where}: expected a package figure, got '${String(v)}'.`);
        broken = true;
        continue;
      }
      money[f] = n;
    }
    if (broken) continue;
    // A person with no package figures at all is a row HR hasn't filled in yet,
    // not a fault — the sheet carries new starters ahead of their first review.
    if (money.current === undefined || money.fy27 === undefined) continue;

    const gn = text(at(r, "gn"));
    const sn = text(at(r, "sn"));
    const current = money.current;
    const fy27 = money.fy27;
    const increase = fy27 - current;
    const num = (f: Field) => {
      const v = at(r, f);
      return typeof v === "number" ? v : undefined;
    };

    rows.push({
      id: id || email,
      email: email || undefined,
      name: [gn, sn].filter(Boolean).join(" ") || (id || email),
      title: text(at(r, "title")) || undefined,
      dept: text(at(r, "dept")) || undefined,
      current,
      fy27,
      increase,
      increasePct: current > 0 ? increase / current : 0,
      increased: Math.abs(increase) > EPSILON,
      sheetIncrease: num("sheetIncrease"),
      sheetIncreasePct: num("sheetIncreasePct"),
      approval: text(at(r, "approval")) || undefined,
      hold: text(at(r, "hold")) || undefined,
      inDataset: knownIds.has(id),
    });
  }

  if (faults.length) {
    const summary: string[] = [];
    if (formulaFaultCount > 0) summary.push(formulaFaultSummary(formulaFaultCount));
    if (uncomputedCount > 0) summary.push(uncomputedSummary(uncomputedCount));
    throw new ImportError([...summary, ...faults]);
  }
  if (rows.length === 0) {
    throw new ImportError(["The review sheet has no rows with package figures."]);
  }
  return rows;
}

export interface PackageSummary {
  people: number;
  increased: number;
  unmatched: number;
  totalIncrease: number;
}

/** The counts the page and the history entry both quote, from one definition. */
export function summarise(rows: readonly PackageRow[]): PackageSummary {
  return {
    people: rows.length,
    increased: rows.filter((r) => r.increased).length,
    unmatched: rows.filter((r) => !r.inDataset).length,
    totalIncrease: rows.reduce((s, r) => s + (r.increased ? r.increase : 0), 0),
  };
}

/** What the FY27 paragraph of a letter should state, and which paragraph it is. */
export interface LetterPackage {
  salaryPackage: number;
  increased: boolean;
}

/**
 * The package a letter states, in order of authority.
 *
 *  1. THE REVIEW. `fy27` when it moved them, `current` when it held them — the
 *     figure HR actually reviewed, and the only source that can say which of the
 *     template's two paragraphs is true for this person.
 *  2. `totalPkg`, the roster's own actual package, for somebody the review has
 *     not reached. Held, never increased: an increase nobody has reviewed is not
 *     one this app may assert.
 *  3. `pkg` — Eligible Salary — last, and only when there is nothing else.
 *
 * Point 3 is the bug this ordering exists to fix (owner, 26 August 2026): the
 * letter used to state `pkg` for everybody. Eligible Salary is the bonus
 * calculation's input and is prorated for eligibility, so for anyone part-year
 * or partly ineligible it is a number they have never been paid — and the
 * letter was telling them it was their package.
 */
export function resolveLetterPackage(
  reviewed: Pick<PackageRow, "current" | "fy27" | "increased"> | undefined,
  emp: { totalPkg?: number; pkg: number }
): LetterPackage {
  if (reviewed) {
    return {
      salaryPackage: reviewed.increased ? reviewed.fy27 : reviewed.current,
      increased: reviewed.increased,
    };
  }
  return {
    salaryPackage: emp.totalPkg && emp.totalPkg > 0 ? emp.totalPkg : emp.pkg,
    increased: false,
  };
}
