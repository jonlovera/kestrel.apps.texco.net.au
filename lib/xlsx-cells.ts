/**
 * Reading an ExcelJS cell down to a primitive, distinguishing "empty" from
 * "a formula with no cached result" — the fact that makes formula handling
 * possible at all.
 *
 * ExcelJS (the only import library used here; SheetJS carries unpatched
 * advisories) can read a formula's cached result, but it cannot evaluate a
 * formula itself. A workbook saved by anything other than Excel — or one with
 * a stale cache — carries a formula object with no `result`, and reading that
 * as empty or coercing it to a string silently produces wrong data: a blank
 * salary, or literally the text "[object Object]" stored as someone's
 * surname. This module exists so both import paths refuse that case loudly,
 * the same way and with the same wording, instead of each getting it wrong
 * slightly differently.
 *
 * Originally lived only in lib/import-model.ts (the real EBS workbook
 * reader); lib/import-parse.ts (the flat one-sheet contract) shares it now
 * rather than reimplementing a second, weaker version of the same check.
 */
import type ExcelJS from "exceljs";

/** Wording shared by every per-cell refusal and the guidance line above it. */
export const UNCOMPUTED_HINT = "no calculated value";

/** A cell that is a formula the file carries no computed result for. */
export const UNCOMPUTED = Symbol("uncomputed");

/** Read a cell down to a primitive, distinguishing "empty" from "uncomputed". */
export function cellValue(
  cell: ExcelJS.Cell
): string | number | null | typeof UNCOMPUTED {
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

/**
 * The one line to show when uncomputed cells were found, prepended above the
 * per-cell detail — a list of cell references doesn't by itself say what to
 * do about them.
 */
export function uncomputedSummary(count: number): string {
  return `${count} figure${count > 1 ? "s are" : " is"} stored in the spreadsheet as a formula that hasn't been calculated, so ${count > 1 ? "they" : "it"} can't be read. Open the file in Excel, save it, and upload it again — Excel writes the calculated values as it saves. Nothing has been changed in the meantime.`;
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
