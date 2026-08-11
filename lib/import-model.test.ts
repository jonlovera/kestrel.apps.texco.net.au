import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import {
  isModelWorkbook,
  readModelWorkbook,
  findStateSheets,
  ModelReadError,
} from "./import-model";
import { rowsToEmployees } from "./import-parse";

/**
 * These fixtures reproduce the real FY26 EBS Model's awkward shape on purpose:
 * headers on row 8, a Shared sheet whose later columns sit one to the left,
 * NSW's mistyped "FY25 Salary Package…" header, and FY25 sheets alongside the
 * FY26 ones. A reader that only handles a tidy workbook passes none of this.
 */

type Row = Record<number, string | number | { formula: string }>;

/** Lay out one state sheet the way the model does: title block, headers row 8. */
function addSheet(
  wb: ExcelJS.Workbook,
  name: string,
  headers: Record<number, string>,
  rows: Row[],
  opts: { splitAbove?: { vic: number; nsw: number } } = {}
) {
  const ws = wb.addWorksheet(name);
  ws.getCell("A1").value = "FY26 Employee Bonus Scheme";
  ws.getCell("A5").value = "Pool cap";
  if (opts.splitAbove) {
    // The model keeps the workbook-level share directly above the VIC/NSW headers.
    ws.getRow(7).getCell(41).value = opts.splitAbove.vic;
    ws.getRow(7).getCell(42).value = opts.splitAbove.nsw;
  }
  for (const [col, text] of Object.entries(headers)) {
    ws.getRow(8).getCell(Number(col)).value = text;
  }
  rows.forEach((row, i) => {
    for (const [col, value] of Object.entries(row)) {
      ws.getRow(9 + i).getCell(Number(col)).value = value as ExcelJS.CellValue;
    }
  });
  return ws;
}

const VIC_HEADERS: Record<number, string> = {
  2: "Employee ID", 3: "Surname", 4: "Given Names", 10: "Position",
  11: "Department", 12: "Manager", 13: "Employee Category",
  28: "FY26 Salary Package vs Bonus Eligibility", 29: "FY25 Bonus %",
  30: "FY26 Bonus %", 33: "IPM %", 34: "FY26 Bonus after IPM",
  35: "Discretionary Award", 37: "Write Back EBS Pool Cap", 38: "FY25 Bonus Award",
};

// NSW mistypes the package header's year; the reader must not care.
const NSW_HEADERS = { ...VIC_HEADERS, 28: "FY25 Salary Package vs Bonus Eligibility" };

// Shared has no "Write Back" column, so everything past it shifts one left —
// FY25 Bonus Award lands on 37, where VIC keeps its Write Back total.
const SHARED_HEADERS: Record<number, string> = {
  ...VIC_HEADERS, 37: "FY25 Bonus Award", 38: "Difference between FY25 and FY24",
  41: "VIC", 42: "NSW",
};

const vicRow = (id: string, over: Row = {}): Row => ({
  2: id, 3: "Young", 4: "Benjamin", 10: "Estimator", 11: "Legal", 12: "MB",
  13: "Employee", 28: 160000, 29: 0.15, 30: 0.15, 33: 0.9, 34: 21600,
  35: 0, 37: 16631, 38: 20250, ...over,
});

const sharedRow = (id: string, over: Row = {}): Row => ({
  2: id, 3: "Bidychak", 4: "Alan", 10: "GC", 11: "Legal", 12: "MB",
  13: "Texco Management", 28: 300000, 29: 0.2, 30: 0.2, 33: 1, 34: 60000,
  35: 0, 37: 50336, 41: 39080.82, 42: 20919.18, ...over,
});

function modelWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("Claude Log").getCell("A1").value = "Turn #";
  addSheet(wb, "EBS Group - FY26", { 1: "VIC Pool Cap" }, []);
  addSheet(wb, "EBS VIC - FY26", VIC_HEADERS, [vicRow("AAA"), vicRow("BBB", { 10: "Site Manager" })]);
  addSheet(wb, "EBS NSW - FY26", NSW_HEADERS, [vicRow("CCC")]);
  addSheet(wb, "EBS Shared - FY26", SHARED_HEADERS, [sharedRow("DDD")], {
    splitAbove: { vic: 0.6513470681458003, nsw: 0.3486529318541997 },
  });
  return wb;
}

describe("EBS model workbook", () => {
  it("is recognised, and a flat export is not", async () => {
    expect(isModelWorkbook(modelWorkbook())).toBe(true);
    const flat = new ExcelJS.Workbook();
    flat.addWorksheet("Sheet1").getRow(1).values = ["ID", "Surname"];
    expect(isModelWorkbook(flat)).toBe(false);
  });

  it("reads all three state sheets into valid employees", () => {
    const { rows, year, sheetsRead } = readModelWorkbook(modelWorkbook());
    expect(year).toBe(26);
    expect(sheetsRead).toHaveLength(3);
    const parsed = rowsToEmployees(rows);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.employees.map((e) => e.id).sort()).toEqual(["AAA", "BBB", "CCC", "DDD"]);
    const vic = parsed.employees.find((e) => e.id === "AAA")!;
    expect(vic.st).toBe("VIC");
    expect(vic.pkg).toBe(160000);
    expect(vic.bp).toBe(0.15); // FY26 Bonus %, not the FY25 column beside it
    expect(vic.bipm).toBe(21600);
    expect(vic.f25).toBe(20250);
    expect(vic.vp).toBe(1);
    expect(vic.np).toBe(0);
  });

  it("resolves columns per sheet, so Shared's shifted layout still reads correctly", () => {
    const { rows } = readModelWorkbook(modelWorkbook());
    const parsed = rowsToEmployees(rows);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const shared = parsed.employees.find((e) => e.id === "DDD")!;
    // Column 37 is "Write Back" on VIC but "FY25 Bonus Award" on Shared. A
    // fixed-index read would have taken the year-on-year difference instead.
    expect(shared.f25).toBe(50336);
    expect(shared.st).toBe("SHARED");
    expect(shared.vp).toBeCloseTo(0.6513, 4);
    expect(shared.np).toBeCloseTo(0.3487, 4);
    expect(shared.vp + shared.np).toBeCloseTo(1, 10);
  });

  it("accepts NSW's mistyped package header", () => {
    const { rows } = readModelWorkbook(modelWorkbook());
    const parsed = rowsToEmployees(rows);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.employees.find((e) => e.id === "CCC")!.pkg).toBe(160000);
  });

  it("flags site managers from the position, since the model has no column for it", () => {
    const { rows } = readModelWorkbook(modelWorkbook());
    const parsed = rowsToEmployees(rows);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.employees.find((e) => e.id === "BBB")!.sm).toBe(1);
    expect(parsed.employees.find((e) => e.id === "AAA")!.sm).toBe(0);
  });

  it("refuses a formula with no calculated value rather than importing a zero", () => {
    const wb = modelWorkbook();
    const ws = wb.getWorksheet("EBS VIC - FY26")!;
    // What a workbook saved outside Excel looks like: formula, no cached result.
    ws.getRow(9).getCell(38).value = {
      formula: "IFNA(XLOOKUP(B9,'Bonus Payments report'!K:K,'Bonus Payments report'!D:D),0)",
    } as ExcelJS.CellValue;
    let thrown: ModelReadError | null = null;
    try {
      readModelWorkbook(wb);
    } catch (e) {
      thrown = e as ModelReadError;
    }
    expect(thrown).toBeInstanceOf(ModelReadError);
    // The fix comes first, because a list of cell references doesn't imply it.
    expect(thrown!.errors[0]).toContain("Calculation Options");
    // Then the detail: which person, which column.
    const detail = thrown!.errors.find((m) => m.includes("AAA"))!;
    expect(detail).toContain("FY25 Bonus Award");
    expect(detail).toContain("no calculated value");
  });

  /**
   * Found against a real re-saved workbook: some cells aren't uncomputed at
   * all — they calculated fine, to a genuine Excel error. Telling someone to
   * recalculate and save again does nothing for those; the wording and the
   * advice both have to be different.
   */
  it("refuses a formula that calculated to a genuine Excel error, with different advice", () => {
    const wb = modelWorkbook();
    const ws = wb.getWorksheet("EBS VIC - FY26")!;
    // What Excel itself writes when a formula errors, e.g. on a text value
    // where a number was expected somewhere in the reference chain.
    ws.getRow(9).getCell(28).value = {
      formula: "AB9",
      result: { error: "#VALUE!" },
    } as ExcelJS.CellValue;
    let thrown: ModelReadError | null = null;
    try {
      readModelWorkbook(wb);
    } catch (e) {
      thrown = e as ModelReadError;
    }
    expect(thrown).toBeInstanceOf(ModelReadError);
    expect(thrown!.errors[0]).toContain("Saving again won't fix");
    expect(thrown!.errors[0]).not.toContain("Calculation Options");
    const detail = thrown!.errors.find((m) => m.includes("AAA"))!;
    expect(detail).toContain("results in #VALUE!");
  });

  it("names both kinds of fault together when a workbook has both", () => {
    const wb = modelWorkbook();
    const ws = wb.getWorksheet("EBS VIC - FY26")!;
    ws.getRow(9).getCell(38).value = { formula: "F1" } as ExcelJS.CellValue; // uncomputed
    ws.getRow(9).getCell(28).value = {
      formula: "AB9",
      result: { error: "#N/A" },
    } as ExcelJS.CellValue; // genuine error
    let thrown: ModelReadError | null = null;
    try {
      readModelWorkbook(wb);
    } catch (e) {
      thrown = e as ModelReadError;
    }
    expect(thrown).toBeInstanceOf(ModelReadError);
    // Both summaries present, and the one that recalculating can't fix leads.
    const first = thrown!.errors[0];
    const second = thrown!.errors[1];
    expect(first).toContain("Saving again won't fix");
    expect(second).toContain("Calculation Options");
  });

  it("refuses when one shared employee's split differs from the sheet's", () => {
    const wb = new ExcelJS.Workbook();
    addSheet(wb, "EBS VIC - FY26", VIC_HEADERS, [vicRow("AAA")]);
    addSheet(wb, "EBS Shared - FY26", SHARED_HEADERS,
      [sharedRow("DDD", { 41: 30000, 42: 30000 })],
      { splitAbove: { vic: 0.6513470681458003, nsw: 0.3486529318541997 } });
    expect(() => readModelWorkbook(wb)).toThrow(/doesn't match the sheet's/);
  });

  it("picks the latest financial year when FY25 sheets are still present", () => {
    const wb = modelWorkbook();
    addSheet(wb, "EBS VIC - FY25", VIC_HEADERS, [vicRow("OLD")]);
    addSheet(wb, "EBS NSW - FY25", VIC_HEADERS, [vicRow("OLDER")]);
    const located = findStateSheets(wb)!;
    expect(located.year).toBe(26);
    const { rows } = readModelWorkbook(wb);
    expect(rows.map((r) => r.id)).not.toContain("OLD");
    expect(rows).toHaveLength(4);
  });

  describe("Eligibility %, the one optional column", () => {
    // Column 7 matches where the real workbook actually carries "Bonus
    // Scheme Eligibility" — kept distinct from the columns VIC_HEADERS
    // already occupies (2-38, 41-42).
    const withElig = { ...VIC_HEADERS, 7: "Bonus Scheme Eligibility" };

    it("imports it when the column is present", () => {
      const wb = new ExcelJS.Workbook();
      addSheet(wb, "EBS VIC - FY26", withElig, [vicRow("AAA", { 7: 0.9863 })]);
      const parsed = rowsToEmployees(readModelWorkbook(wb).rows);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.employees[0].elig).toBeCloseTo(0.9863, 4);
    });

    it("is skipped, not a failure, when the column is absent", () => {
      // modelWorkbook()'s sheets have no column 7 header at all — the
      // existing fixture, unmodified, is the proof this doesn't break a
      // sheet that predates the column existing.
      const parsed = rowsToEmployees(readModelWorkbook(modelWorkbook()).rows);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.employees.find((e) => e.id === "AAA")?.elig).toBeUndefined();
    });

    it("still refuses an uncomputed formula in it, same as any other column", () => {
      const wb = new ExcelJS.Workbook();
      addSheet(wb, "EBS VIC - FY26", withElig, [vicRow("AAA", { 7: { formula: "A1" } })]);
      let thrown: ModelReadError | null = null;
      try {
        readModelWorkbook(wb);
      } catch (e) {
        thrown = e as ModelReadError;
      }
      expect(thrown).toBeInstanceOf(ModelReadError);
      expect(thrown!.errors.join("\n")).toContain("Bonus Scheme Eligibility");
    });
  });

  it("names a missing column instead of importing a blank one", () => {
    const wb = new ExcelJS.Workbook();
    const headers = { ...VIC_HEADERS };
    delete headers[33]; // IPM %
    addSheet(wb, "EBS VIC - FY26", headers, [vicRow("AAA")]);
    expect(() => readModelWorkbook(wb)).toThrow(/'IPM %'/);
  });

  it("skips the totals block below the table", () => {
    const wb = new ExcelJS.Workbook();
    addSheet(wb, "EBS VIC - FY26", VIC_HEADERS, [
      vicRow("AAA"),
      { 3: "Total", 34: 21600 }, // no employee id
    ]);
    const { rows } = readModelWorkbook(wb);
    expect(rows).toHaveLength(1);
  });

  it("reports the sheet and row on a validation failure, not a flat-file row number", () => {
    const wb = new ExcelJS.Workbook();
    addSheet(wb, "EBS VIC - FY26", VIC_HEADERS, [vicRow("AAA", { 33: "not a number" })]);
    const parsed = rowsToEmployees(readModelWorkbook(wb).rows);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors[0]).toContain("'EBS VIC - FY26' row 9");
  });
});
