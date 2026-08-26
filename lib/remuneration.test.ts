import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import {
  readRemunerationWorkbook,
  resolveLetterPackage,
  findHeader,
  summarise,
  PackageIncreaseDocSchema,
} from "./remuneration";
import { ImportError } from "./xlsx-cells";

/**
 * The real workbook's labels, in the real file's order. Tests that care about
 * order shuffle this deliberately — nothing may be addressed by index.
 */
const LABELS = [
  "Email",
  "Jobpac Employee ID",
  "First name",
  "Last name",
  "Job title",
  "Department",
  "Current Total Salary Package",
  "FY27 Salary Package",
  "Insert Rem Increase $",
  "Director Approval",
  "HOLD/RELEASE",
];

type Row = Record<string, unknown>;

/**
 * Build a one-sheet workbook with the header on `headerRow`, matching the real
 * file's shape (its header is row 2, not row 1, with a banner above it).
 */
function book(
  rows: Row[],
  opts: { labels?: string[]; headerRow?: number } = {}
): ExcelJS.Workbook {
  const labels = opts.labels ?? LABELS;
  const headerRow = opts.headerRow ?? 2;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("FY27 Remuneration Reviews");
  ws.getRow(1).getCell(7).value = "Remuneration Package Breakdown";
  labels.forEach((l, i) => {
    ws.getRow(headerRow).getCell(i + 1).value = l;
  });
  rows.forEach((r, i) => {
    const row = ws.getRow(headerRow + 1 + i);
    labels.forEach((l, c) => {
      if (r[l] !== undefined) row.getCell(c + 1).value = r[l] as ExcelJS.CellValue;
    });
  });
  return wb;
}

const person = (over: Row = {}): Row => ({
  Email: "rporter@texco.net.au",
  "Jobpac Employee ID": "RIPOR",
  "First name": "Richard",
  "Last name": "Porter",
  "Job title": "Head of Design",
  Department: "New Business",
  "Current Total Salary Package": 295000,
  "FY27 Salary Package": 315000,
  ...over,
});

describe("findHeader", () => {
  it("finds the header below a banner row", () => {
    const ws = book([person()]).worksheets[0];
    const h = findHeader(ws);
    expect(h?.row).toBe(2);
    expect(h?.cols.current).toBe(7);
    expect(h?.cols.fy27).toBe(8);
  });

  it("resolves columns wherever they sit", () => {
    const shuffled = [...LABELS].reverse();
    const ws = book([person()], { labels: shuffled }).worksheets[0];
    const h = findHeader(ws);
    expect(h).not.toBeNull();
    expect(shuffled[h!.cols.current! - 1]).toBe("Current Total Salary Package");
    expect(shuffled[h!.cols.fy27! - 1]).toBe("FY27 Salary Package");
  });

  it("tolerates the wrapping Excel puts in these labels", () => {
    const wrapped = LABELS.map((l) =>
      l === "FY27 Salary Package" ? "FY27 Salary \nPackage" : l
    );
    expect(findHeader(book([person()], { labels: wrapped }).worksheets[0])).not.toBeNull();
  });

  it("is null for a sheet that carries none of it", () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Melbourne Benchmarking");
    ws.getRow(1).getCell(1).value = "Role";
    ws.getRow(1).getCell(2).value = "Median";
    expect(findHeader(ws)).toBeNull();
  });
});

describe("readRemunerationWorkbook", () => {
  it("reads a package increase", () => {
    const [r] = readRemunerationWorkbook(book([person()]), new Set(["RIPOR"]));
    expect(r).toMatchObject({
      id: "RIPOR",
      name: "Richard Porter",
      title: "Head of Design",
      current: 295000,
      fy27: 315000,
      increase: 20000,
      increased: true,
      inDataset: true,
    });
    expect(r.increasePct).toBeCloseTo(20000 / 295000, 10);
  });

  it("marks an unchanged package as no increase", () => {
    const [r] = readRemunerationWorkbook(
      book([person({ "FY27 Salary Package": 295000 })])
    );
    expect(r.increased).toBe(false);
    expect(r.increase).toBe(0);
  });

  it("treats a sub-cent difference as unchanged", () => {
    const [r] = readRemunerationWorkbook(
      book([person({ "FY27 Salary Package": 295000.001 })])
    );
    expect(r.increased).toBe(false);
  });

  it("keeps a decrease, and does not call it an increase-free row", () => {
    const [r] = readRemunerationWorkbook(
      book([person({ "FY27 Salary Package": 285000 })])
    );
    expect(r.increase).toBe(-10000);
    expect(r.increased).toBe(true);
  });

  it("marks someone off the bonus roster", () => {
    const [r] = readRemunerationWorkbook(book([person()]), new Set(["OTHER"]));
    expect(r.inDataset).toBe(false);
  });

  it("skips rows with neither an id nor an email", () => {
    const blank: Row = { "Current Total Salary Package": 1, "FY27 Salary Package": 2 };
    const rows = readRemunerationWorkbook(book([person(), blank, person({
      "Jobpac Employee ID": "LAHIL",
      Email: "lhill@texco.net.au",
      "First name": "Lachlan",
      "Last name": "Hill",
    })]));
    expect(rows.map((r) => r.id)).toEqual(["RIPOR", "LAHIL"]);
  });

  it("skips a person whose review has no figures yet", () => {
    const pending = person({
      "Jobpac Employee ID": "NEWBI",
      "Current Total Salary Package": undefined,
      "FY27 Salary Package": undefined,
    });
    const rows = readRemunerationWorkbook(book([person(), pending]));
    expect(rows).toHaveLength(1);
  });

  it("reads money written as text", () => {
    const [r] = readRemunerationWorkbook(
      book([person({ "Current Total Salary Package": "$295,000" })])
    );
    expect(r.current).toBe(295000);
  });

  it("refuses a workbook that isn't the review", () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Sheet1").getRow(1).getCell(1).value = "Name";
    expect(() => readRemunerationWorkbook(wb)).toThrow(ImportError);
  });

  it("refuses a review with no usable rows", () => {
    expect(() => readRemunerationWorkbook(book([]))).toThrow(ImportError);
  });
});

describe("formula faults", () => {
  /** Put a raw cell value in, the way ExcelJS represents a formula. */
  function withCell(col: number, value: ExcelJS.CellValue): ExcelJS.Workbook {
    const wb = book([person()]);
    wb.worksheets[0].getRow(3).getCell(col).value = value;
    return wb;
  }

  it("names an uncalculated formula and asks for a recalculation", () => {
    // no `result` — the shape a workbook saved on Manual calculation produces
    const wb = withCell(8, { formula: "AB3*1.05" } as ExcelJS.CellValue);
    try {
      readRemunerationWorkbook(wb);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ImportError);
      const { errors } = err as ImportError;
      expect(errors.join(" ")).toContain("no calculated value");
      expect(errors.join(" ")).toContain("Calculation Options");
      expect(errors.some((e) => e.includes("H3"))).toBe(true);
    }
  });

  it("gives a genuine Excel error different advice", () => {
    const wb = withCell(8, {
      formula: "AB3/0",
      result: { error: "#DIV/0!" },
    } as unknown as ExcelJS.CellValue);
    try {
      readRemunerationWorkbook(wb);
      expect.unreachable("should have thrown");
    } catch (err) {
      const { errors } = err as ImportError;
      expect(errors.join(" ")).toContain("#DIV/0!");
      // the whole point of telling the two apart: this one is NOT fixed by
      // recalculating and saving again
      expect(errors.join(" ")).not.toContain("Calculation Options");
    }
  });

  it("refuses unreadable text in a package column", () => {
    const wb = withCell(7, "TBC" as ExcelJS.CellValue);
    expect(() => readRemunerationWorkbook(wb)).toThrow(/expected a package figure/);
  });
});

describe("summarise", () => {
  it("counts people, increases, unmatched rows and the total", () => {
    const rows = readRemunerationWorkbook(
      book([
        person(),
        person({
          "Jobpac Employee ID": "LAHIL",
          "First name": "Lachlan",
          "Last name": "Hill",
          "FY27 Salary Package": 305000,
        }),
        person({
          "Jobpac Employee ID": "JABUL",
          "First name": "Jack",
          "Last name": "Bull",
          "Current Total Salary Package": 450000,
          "FY27 Salary Package": 450000,
        }),
      ]),
      new Set(["RIPOR", "LAHIL"])
    );
    expect(summarise(rows)).toEqual({
      people: 3,
      increased: 2,
      unmatched: 1,
      totalIncrease: 30000,
    });
  });
});

describe("the stored document", () => {
  it("round-trips through its schema", () => {
    const doc = {
      uploadedAt: new Date(0).toISOString(),
      uploadedBy: "someone@texco.net.au",
      filename: "review.xlsx",
      rows: readRemunerationWorkbook(book([person()]), new Set(["RIPOR"])),
    };
    const parsed = PackageIncreaseDocSchema.safeParse(doc);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.rows[0].fy27).toBe(315000);
  });
});

describe("resolveLetterPackage", () => {
  const emp = { totalPkg: 200000, pkg: 185000 };

  it("states the new package when the review moved someone", () => {
    expect(
      resolveLetterPackage({ current: 295000, fy27: 315000, increased: true }, emp)
    ).toEqual({ salaryPackage: 315000, increased: true });
  });

  it("states the reviewed package when they were held", () => {
    expect(
      resolveLetterPackage({ current: 295000, fy27: 295000, increased: false }, emp)
    ).toEqual({ salaryPackage: 295000, increased: false });
  });

  it("falls back to the roster's actual package, never to Eligible Salary", () => {
    // the bug: Eligible Salary is the bonus calculation's input, prorated for
    // eligibility, and for a part-year person it is a figure never paid
    expect(resolveLetterPackage(undefined, emp)).toEqual({
      salaryPackage: 200000,
      increased: false,
    });
  });

  it("uses Eligible Salary only when there is nothing else", () => {
    expect(resolveLetterPackage(undefined, { pkg: 185000 })).toEqual({
      salaryPackage: 185000,
      increased: false,
    });
    expect(resolveLetterPackage(undefined, { totalPkg: 0, pkg: 185000 })).toEqual({
      salaryPackage: 185000,
      increased: false,
    });
  });

  it("never claims an increase nobody reviewed", () => {
    expect(resolveLetterPackage(undefined, emp).increased).toBe(false);
  });
});
