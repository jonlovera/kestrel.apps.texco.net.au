/**
 * Reading an ExcelJS cell down to a primitive, distinguishing "empty" from
 * two different kinds of unreadable formula — the fact that makes formula
 * handling possible at all.
 *
 * ExcelJS (the only import library used here; SheetJS carries unpatched
 * advisories) can read a formula's cached result, but it cannot evaluate a
 * formula itself. That leaves two distinct faults, confirmed against a real
 * re-saved workbook rather than assumed, and they need different advice:
 *
 *  - UNCOMPUTED: the formula carries no cached result at all — not even a
 *    stale one. The near-universal cause is the workbook's calculation mode
 *    being set to Manual, so an ordinary Ctrl+S never asked Excel to compute
 *    anything; "open it and save it" only fixes this one if a full
 *    recalculation (Ctrl+Alt+F9, or switching to Automatic) happens first.
 *  - FormulaFault: the formula WAS calculated, and calculated to a genuine
 *    Excel error (#VALUE!, #N/A, #REF!, …). Re-saving, however many times,
 *    changes nothing — the formula itself, or something it references, is
 *    broken, and only editing it in Excel fixes it.
 *
 * Treating these as the same thing (as this module used to) tells someone
 * with a genuine #VALUE! to "open it and save it", which does nothing and
 * looks like the importer is stuck. Reading these as empty, or coercing them
 * to a string, is worse: a blank salary, or literally the text
 * "[object Object]" stored as someone's surname.
 *
 * Originally lived only in lib/import-model.ts (the real EBS workbook
 * reader); lib/import-parse.ts (the flat one-sheet contract) shares it now
 * rather than reimplementing a second, weaker version of the same check.
 */
import type ExcelJS from "exceljs";

/** Wording shared by every "no cached result" refusal and its summary line. */
export const UNCOMPUTED_HINT = "no calculated value";

/** A cell that is a formula the file carries no computed result for at all. */
export const UNCOMPUTED = Symbol("uncomputed");

/** A cell that WAS calculated, to a genuine Excel error (#VALUE!, #N/A, …). */
export class FormulaFault {
  constructor(readonly code: string) {}
}
export function isFormulaFault(v: unknown): v is FormulaFault {
  return v instanceof FormulaFault;
}

/** Read a cell down to a primitive, or one of the two faults above. */
export function cellValue(
  cell: ExcelJS.Cell
): string | number | null | typeof UNCOMPUTED | FormulaFault {
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
  if (o.error) return new FormulaFault(o.error);
  if (o.result !== undefined) {
    const r = o.result as unknown;
    if (r && typeof r === "object" && "error" in (r as object)) {
      return new FormulaFault(String((r as { error: unknown }).error));
    }
    return r as string | number | null;
  }
  if (o.text !== undefined) return o.text;
  // A formula (or a member of a shared-formula group) with no cached value.
  if (o.formula !== undefined || o.sharedFormula !== undefined) return UNCOMPUTED;
  return null;
}

/**
 * The one line to show when uncomputed cells were found, prepended above the
 * per-cell detail — a list of cell references doesn't by itself say what to
 * do about them.
 */
export function uncomputedSummary(count: number): string {
  return `${count} figure${count > 1 ? "s are" : " is"} stored in the spreadsheet as a formula that hasn't been calculated, so ${count > 1 ? "they" : "it"} can't be read. This is almost always the workbook's calculation mode set to Manual, which means an ordinary save never asked Excel to compute anything. In Excel: Formulas → Calculation Options → Automatic, then press Ctrl+Alt+F9 to force a full recalculation, then save and upload again. Nothing has been changed in the meantime.`;
}

/** The per-cell line for a formula that calculated to a genuine Excel error. */
export function formulaFaultHint(code: string): string {
  return `this formula results in ${code}`;
}

/**
 * The summary line for genuine formula errors — deliberately not "recalculate
 * and try again", because that does nothing here: the formula (or something
 * it looks up) is broken and stays broken no matter how many times it's
 * saved.
 */
export function formulaFaultSummary(count: number): string {
  return `${count} figure${count > 1 ? "s" : ""} in the spreadsheet ${count > 1 ? "calculate" : "calculates"} to an error (${count > 1 ? "e.g. " : ""}#VALUE!, #N/A) rather than a usable value. Saving again won't fix ${count > 1 ? "these" : "this"} — the formula itself, or something it looks up, needs correcting directly in Excel.`;
}

/**
 * Carries every fault so the UI can list them, not just the first.
 *
 * Shared by both import paths (the real EBS model workbook and the flat
 * one-sheet contract) — a formula with no cached value is the same problem
 * either way, and it can occur many times in one file.
 */
export class ImportError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(errors[0] ?? "The file couldn't be read.");
    this.name = "ImportError";
    // Cap the list: 159 rows × a broken column is not a readable error page.
    this.errors =
      errors.length > 25
        ? [...errors.slice(0, 25), `…and ${errors.length - 25} more.`]
        : errors;
  }
}
