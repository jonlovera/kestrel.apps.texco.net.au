import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import {
  isModelWorkbook,
  readModelWorkbook,
  findGroupSheet,
  GROUP_COLUMNS,
  ModelReadError,
} from "./import-model";
import { rowsToEmployees } from "./import-parse";

/**
 * These fixtures reproduce the real, consolidated "EBS Group - FY26" tab's
 * shape on purpose: headers on row 15 (with embedded newlines, as the real
 * file has), a "EBS Group - FY26 SM Scenario" sheet sitting alongside it that
 * must never be mistaken for the real data, and a TOTALS row terminating the
 * table. Confirmed against the actual workbook rather than assumed.
 */

type Row = Record<number, string | number | { formula: string } | { result: { error: string } }>;

const HEADERS: Record<number, string> = {
  3: "Employee ID",
  4: "Surname",
  5: "Given Names",
  10: "Position",
  11: "Department",
  12: "Manager",
  13: "Category",
  14: "VIC %",
  15: "NSW %",
  16: "Total FY26\nSalary Package",
  17: "Eligibility\n%",
  18: "Eligible\nSalary",
  19: "FY26\nBonus %",
  23: "IPM %",
  24: "Bonus after\nIPM",
  28: "Under Cap Discretionary \nAdjustment",
  33: "FY25 Bonus\nAward",
};

function addGroupSheet(
  wb: ExcelJS.Workbook,
  name: string,
  headers: Record<number, string>,
  rows: Row[]
) {
  const ws = wb.addWorksheet(name);
  ws.getCell("A1").value = "TEXCO — FY26 EMPLOYEE BONUS SCHEME";
  ws.getCell("C5").value = "VIC Pool Cap";
  ws.getCell("D5").value = 1450259.6;
  ws.getCell("E5").value = "NSW Pool Cap";
  ws.getCell("F5").value = 987654.32;
  for (const [col, text] of Object.entries(headers)) {
    ws.getRow(15).getCell(Number(col)).value = text;
  }
  rows.forEach((row, i) => {
    for (const [col, value] of Object.entries(row)) {
      ws.getRow(16 + i).getCell(Number(col)).value = value as ExcelJS.CellValue;
    }
  });
  return ws;
}

const vicRow = (id: string, over: Row = {}): Row => ({
  3: id, 4: "Young", 5: "Benjamin", 10: "Estimator", 11: "Legal", 12: "MB",
  13: "Employee", 14: 1, 15: 0, 16: 160000, 17: 0.9, 18: 160000, 19: 0.15,
  23: 0.9, 24: 21600, 28: 0, 33: 20250, ...over,
});

const nswRow = (id: string, over: Row = {}): Row => ({
  3: id, 4: "Han", 5: "Thanh", 10: "Site Manager", 11: "Delivery", 12: "MB",
  13: "Employee", 14: 0, 15: 1, 16: 250000, 17: 1, 18: 250000, 19: 0.095,
  23: 0.9, 24: 21375, 28: 0, 33: 22990, ...over,
});

const sharedRow = (id: string, over: Row = {}): Row => ({
  3: id, 4: "Bidychak", 5: "Alan", 10: "GC", 11: "Legal", 12: "MB",
  13: "Management", 14: 0.61, 15: 0.39, 16: 300000, 17: 1, 18: 300000,
  19: 0.2, 23: 0.9, 24: 54000, 28: 0, 33: 50336, ...over,
});

function groupWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("Claude Log").getCell("A1").value = "Turn #";
  const ws = addGroupSheet(wb, "EBS Group - FY26", HEADERS, [
    vicRow("AAA"),
    nswRow("BBB"),
    sharedRow("CCC"),
  ]);
  ws.getRow(19).getCell(3).value = "TOTALS";
  return { wb, ws };
}

describe("EBS Group workbook", () => {
  it("is recognised, and a flat export is not", () => {
    expect(isModelWorkbook(groupWorkbook().wb)).toBe(true);
    const flat = new ExcelJS.Workbook();
    flat.addWorksheet("Sheet1").getRow(1).values = ["ID", "Surname"];
    expect(isModelWorkbook(flat)).toBe(false);
  });

  it("reads every employee row and stops at TOTALS", () => {
    const { rows, year, sheetsRead } = readModelWorkbook(groupWorkbook().wb);
    expect(year).toBe(26);
    expect(sheetsRead).toEqual(["EBS Group - FY26"]);
    expect(rows.map((r) => r.id).sort()).toEqual(["AAA", "BBB", "CCC"]);
  });

  it("derives state purely from each employee's own VIC %/NSW % split", () => {
    const { rows } = readModelWorkbook(groupWorkbook().wb);
    const parsed = rowsToEmployees(rows);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.employees.find((e) => e.id === "AAA")!.st).toBe("VIC");
    expect(parsed.employees.find((e) => e.id === "BBB")!.st).toBe("NSW");
    const shared = parsed.employees.find((e) => e.id === "CCC")!;
    expect(shared.st).toBe("SHARED");
    expect(shared.vp).toBeCloseTo(0.61, 5);
    expect(shared.np).toBeCloseTo(0.39, 5);
  });

  it("tolerates a near-1 split rather than misrouting someone to SHARED", () => {
    // A formula could resolve to 0.9999999999999998 rather than a literal 1 —
    // exact equality would wrongly call this person Shared Services.
    const { wb } = groupWorkbook();
    const ws = wb.getWorksheet("EBS Group - FY26")!;
    ws.getRow(16).getCell(14).value = 0.9999999999999998;
    ws.getRow(16).getCell(15).value = 0;
    const { rows } = readModelWorkbook(wb);
    const parsed = rowsToEmployees(rows);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.employees.find((e) => e.id === "AAA")!.st).toBe("VIC");
  });

  /**
   * The exact case that decided the mapping: "Eligible Salary" is what the
   * calc actually runs on, and it can genuinely differ from "Total FY26
   * Salary Package" on the same person (a real employee: $250,000 total,
   * $234,000 eligible).
   */
  it("pkg comes from Eligible Salary, totalPkg from Total Package, and they can differ", () => {
    const { wb } = groupWorkbook();
    const ws = wb.getWorksheet("EBS Group - FY26")!;
    ws.getRow(16).getCell(16).value = 250000; // Total FY26 Salary Package
    ws.getRow(16).getCell(18).value = 234000; // Eligible Salary
    const { rows } = readModelWorkbook(wb);
    const parsed = rowsToEmployees(rows);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const emp = parsed.employees.find((e) => e.id === "AAA")!;
    expect(emp.pkg).toBe(234000);
    expect(emp.totalPkg).toBe(250000);
  });

  it("imports Discretionary from Under Cap only", () => {
    const { wb } = groupWorkbook();
    const ws = wb.getWorksheet("EBS Group - FY26")!;
    ws.getRow(15 + 1).getCell(28).value = 500; // Under Cap Discretionary Adjustment
    // Exceed Cap isn't part of the header fixture at all — proving its
    // absence doesn't block the import, since it's never read.
    const { rows } = readModelWorkbook(wb);
    const parsed = rowsToEmployees(rows);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.employees.find((e) => e.id === "AAA")!.da).toBe(500);
  });

  it("flags a site manager from the position, since the sheet's own column is unreliable", () => {
    const { rows } = readModelWorkbook(groupWorkbook().wb);
    const parsed = rowsToEmployees(rows);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.employees.find((e) => e.id === "BBB")!.sm).toBe(1);
    expect(parsed.employees.find((e) => e.id === "AAA")!.sm).toBe(0);
  });

  it("matches a Position containing 'Site Manager', not just an exact title", () => {
    // Mirrors the sheet's own AS-column formula, SEARCH("Site Manager",
    // Position) — a case-insensitive substring, not an exact match. A title
    // variation must flag here the same way it flags in Excel, or that
    // person gets pro-rated against the pool instead of paid their fixed,
    // unscaled figure.
    const wb = new ExcelJS.Workbook();
    const ws = addGroupSheet(wb, "EBS Group - FY26", HEADERS, [
      vicRow("AAA"),
      vicRow("DDD", { 10: "Senior Site Manager" }),
      vicRow("EEE", { 10: "site manager (acting)" }),
    ]);
    ws.getRow(19).getCell(3).value = "TOTALS";
    const { rows } = readModelWorkbook(wb);
    const parsed = rowsToEmployees(rows);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.employees.find((e) => e.id === "AAA")!.sm).toBe(0);
    expect(parsed.employees.find((e) => e.id === "DDD")!.sm).toBe(1);
    expect(parsed.employees.find((e) => e.id === "EEE")!.sm).toBe(1);
  });

  it("imports Locked Amount as a frozen bonus, never as an Employee field", () => {
    const { wb, ws } = groupWorkbook();
    ws.getRow(15).getCell(30).value = "Locked Amount";
    ws.getRow(16).getCell(30).value = 23520; // AAA
    const { rows, lockedAmounts } = readModelWorkbook(wb);
    expect(lockedAmounts).toEqual({ AAA: 23520 });
    const parsed = rowsToEmployees(rows);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const aaa = parsed.employees.find((e) => e.id === "AAA") as unknown as Record<
      string,
      unknown
    >;
    expect(aaa.lockedAmount).toBeUndefined();
  });

  it("a blank Locked Amount cell means nobody is locked", () => {
    const { wb, ws } = groupWorkbook();
    ws.getRow(15).getCell(30).value = "Locked Amount";
    const { lockedAmounts } = readModelWorkbook(wb);
    expect(lockedAmounts).toEqual({});
  });

  it("omitting the Locked Amount column entirely still imports everything else", () => {
    const { rows, lockedAmounts } = readModelWorkbook(groupWorkbook().wb);
    expect(lockedAmounts).toEqual({});
    expect(rows.length).toBe(3);
  });

  it("refuses an uncomputed formula in Locked Amount, the same as any other cell", () => {
    // The bug this closes was a silent drop, not a loud one — a fault here
    // must fail the whole import rather than quietly importing everyone as
    // unlocked.
    const { wb, ws } = groupWorkbook();
    ws.getRow(15).getCell(30).value = "Locked Amount";
    ws.getRow(16).getCell(30).value = { formula: "A1*2" } as ExcelJS.CellValue;
    let thrown: ModelReadError | null = null;
    try {
      readModelWorkbook(wb);
    } catch (e) {
      thrown = e as ModelReadError;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.errors.join("\n")).toContain("Locked Amount");
  });

  it("never mistakes 'EBS Group - FY26 SM Scenario' for the real data", () => {
    const { wb } = groupWorkbook();
    // The scenario tab sits alongside the real one in the actual workbook.
    addGroupSheet(wb, "EBS Group - FY26 SM Scenario", HEADERS, [vicRow("ZZZ")]);
    const { rows, sheetsRead } = readModelWorkbook(wb);
    expect(sheetsRead).toEqual(["EBS Group - FY26"]);
    expect(rows.map((r) => r.id)).not.toContain("ZZZ");
  });

  it("picks the latest financial year when an FY25 Group sheet is still present", () => {
    const { wb } = groupWorkbook();
    addGroupSheet(wb, "EBS Group - FY25", HEADERS, [vicRow("OLD")]);
    const located = findGroupSheet(wb)!;
    expect(located.year).toBe(26);
    const { rows } = readModelWorkbook(wb);
    expect(rows.map((r) => r.id)).not.toContain("OLD");
  });

  it("refuses an old-format workbook (no Group tab) rather than reading it another way", () => {
    const wb = new ExcelJS.Workbook();
    const legacyHeaders: Record<number, string> = {
      2: "Employee ID", 3: "Surname", 4: "Given Names", 28: "Salary Package vs Bonus Eligibility",
    };
    const ws = wb.addWorksheet("EBS VIC - FY26");
    for (const [col, text] of Object.entries(legacyHeaders)) {
      ws.getRow(8).getCell(Number(col)).value = text;
    }
    ws.getRow(9).getCell(2).value = "AAA";
    expect(isModelWorkbook(wb)).toBe(false);
    expect(() => readModelWorkbook(wb)).toThrow(/no longer supported/);
  });

  it("names a missing column instead of importing a blank one", () => {
    const wb = new ExcelJS.Workbook();
    const headers = { ...HEADERS };
    delete headers[23]; // IPM %
    addGroupSheet(wb, "EBS Group - FY26", headers, [vicRow("AAA")]);
    expect(() => readModelWorkbook(wb)).toThrow(/'IPM %'/);
  });

  it("does not require Eligibility % — the one optional column", () => {
    const wb = new ExcelJS.Workbook();
    const headers = { ...HEADERS };
    delete headers[17]; // Eligibility %
    addGroupSheet(wb, "EBS Group - FY26", headers, [vicRow("AAA", { 17: undefined as unknown as number })]);
    const { rows } = readModelWorkbook(wb);
    const parsed = rowsToEmployees(rows);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.employees[0].elig).toBeUndefined();
  });

  /**
   * Found against a real file: someone not eligible for a bonus this cycle
   * (Eligible Salary $0) can carry a negative Eligibility % — the sheet's own
   * proration formula isn't floored at zero for them. `elig` is informational
   * only, never computed against, so this must not block the import.
   */
  it("accepts a negative Eligibility %, for someone not eligible this cycle", () => {
    const { wb } = groupWorkbook();
    const ws = wb.getWorksheet("EBS Group - FY26")!;
    ws.getRow(16).getCell(17).value = -0.2438356164383562; // Eligibility %
    ws.getRow(16).getCell(18).value = 0; // Eligible Salary
    const { rows } = readModelWorkbook(wb);
    const parsed = rowsToEmployees(rows);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.employees.find((e) => e.id === "AAA")!.elig).toBeCloseTo(-0.2438, 4);
  });

  it("refuses a formula with no calculated value rather than importing a zero", () => {
    const { wb } = groupWorkbook();
    const ws = wb.getWorksheet("EBS Group - FY26")!;
    // What a workbook with its calculation mode set to Manual carries: a
    // formula, no cached result.
    ws.getRow(16).getCell(33).value = {
      formula: "IFNA(XLOOKUP(C16,'Bonus Payments report'!K:K,'Bonus Payments report'!D:D),0)",
    } as ExcelJS.CellValue;
    let thrown: ModelReadError | null = null;
    try {
      readModelWorkbook(wb);
    } catch (e) {
      thrown = e as ModelReadError;
    }
    expect(thrown).toBeInstanceOf(ModelReadError);
    expect(thrown!.errors[0]).toContain("Calculation Options");
    const detail = thrown!.errors.find((m) => m.includes("AAA"))!;
    expect(detail).toContain("FY25 Bonus Award");
    expect(detail).toContain("no calculated value");
  });

  it("gives different advice for a formula that calculated to a genuine Excel error", () => {
    const { wb } = groupWorkbook();
    const ws = wb.getWorksheet("EBS Group - FY26")!;
    ws.getRow(16).getCell(18).value = {
      formula: "AB16",
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
    const detail = thrown!.errors.find((m) => m.includes("AAA"))!;
    expect(detail).toContain("results in #VALUE!");
  });

  it("skips the TOTALS row rather than reading it as an employee", () => {
    const { rows } = readModelWorkbook(groupWorkbook().wb);
    expect(rows.some((r) => r.id === "TOTALS")).toBe(false);
    expect(rows).toHaveLength(3);
  });

  it("rejects duplicate ids naming both rows", () => {
    const { wb } = groupWorkbook();
    const ws = wb.getWorksheet("EBS Group - FY26")!;
    ws.getRow(17).getCell(3).value = "AAA"; // BBB's row, reusing AAA's id
    expect(() => readModelWorkbook(wb)).toThrow(/row 16 and row 17/);
  });

  it("GROUP_COLUMNS resolves every field Kestrel needs, by header text alone", () => {
    // A structural guard against a fixed-index read creeping back in.
    for (const field of ["id", "sn", "gn", "pos", "dept", "mgr", "cat", "vp", "np", "pkg", "totalPkg", "bp", "ipm", "bipm", "da", "f25", "elig"]) {
      expect(GROUP_COLUMNS[field]).toBeDefined();
    }
  });

  describe("pool caps (FY26: the workbook is now authoritative for these)", () => {
    it("reads VIC/NSW Pool Cap and derives the group cap as their sum", () => {
      const { caps } = readModelWorkbook(groupWorkbook().wb);
      expect(caps.vCap).toBe(1450259.6);
      expect(caps.nCap).toBe(987654.32);
      expect(caps.gCap).toBeCloseTo(1450259.6 + 987654.32, 6);
    });

    it("prefers an explicit 'TOTAL GROUP POOL CAP' label over the derived sum", () => {
      const { wb } = groupWorkbook();
      const ws = wb.getWorksheet("EBS Group - FY26")!;
      ws.getCell("C6").value = "TOTAL GROUP POOL CAP";
      ws.getCell("D6").value = 2_500_000;
      const { caps } = readModelWorkbook(wb);
      expect(caps.gCap).toBe(2_500_000);
    });

    it("refuses to import when the VIC Pool Cap figure can't be found", () => {
      const { wb } = groupWorkbook();
      const ws = wb.getWorksheet("EBS Group - FY26")!;
      ws.getCell("C5").value = null;
      expect(() => readModelWorkbook(wb)).toThrow(/VIC Pool Cap/);
    });

    it("refuses to import when the NSW Pool Cap figure can't be found", () => {
      const { wb } = groupWorkbook();
      const ws = wb.getWorksheet("EBS Group - FY26")!;
      ws.getCell("E5").value = null;
      expect(() => readModelWorkbook(wb)).toThrow(/NSW Pool Cap/);
    });

    it("resolves the label by text even when restated at a different column", () => {
      // The real workbook restates "VIC Pool Cap" a second time, further
      // right, as the first row of its own waterfall table — the label
      // scan must find a match wherever it sits, not at a fixed column.
      const { wb } = groupWorkbook();
      const ws = wb.getWorksheet("EBS Group - FY26")!;
      ws.getCell("H11").value = "VIC Pool Cap";
      ws.getCell("I11").value = 1450259.6; // same figure, restated
      const { caps } = readModelWorkbook(wb);
      expect(caps.vCap).toBe(1450259.6);
    });
  });
});
