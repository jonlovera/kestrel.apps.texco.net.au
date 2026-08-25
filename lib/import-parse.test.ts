import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import {
  parseImportFile,
  rowsToEmployees,
  buildImportPreview,
  candidateDataset,
  filterImportedLocks,
  seedImportedBases,
  FIELD_LABELS,
} from "./import-parse";
import { deriveFacets } from "./dataset-edit";
import { applyOverrides, computeScalesAndBonuses } from "./calc";
import {
  DatasetSchema,
  type Dataset,
  type Employee,
  type Overrides,
} from "./schema";

const HEADERS = Object.values(FIELD_LABELS); // friendly labels
const goodRow = [
  "ABCDE", "Bidychak", "Alan", "GC", "Legal", "MB", "Texco Management",
  "SHARED", "0.6", "0.4", "$300,000", "20%", "90%", "$54,000", "0", "$50,336", "no",
];

const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
function csv(rows: string[][]): string {
  return [HEADERS.map(q).join(","), ...rows.map((r) => r.map(q).join(","))].join("\n");
}

async function fromCsv(text: string) {
  const { rows } = await parseImportFile("test.csv", Buffer.from(text));
  return rowsToEmployees(rows);
}

describe("import parsing", () => {
  it("accepts friendly headers, currency/percent strings and yes/no flags", async () => {
    const result = await fromCsv(csv([goodRow]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const e = result.employees[0];
    expect(e.pkg).toBe(300000);
    expect(e.bp).toBe(0.2);
    expect(e.ipm).toBe(0.9);
    expect(e.bipm).toBe(54000);
    expect(e.sm).toBe(0);
    expect(e.vp).toBe(0.6);
  });

  it("also accepts raw field keys as headers", async () => {
    const raw = "id,sn,gn,pos,dept,mgr,cat,st,vp,np,pkg,bp,ipm,bipm,da,f25,sm\nX1,A,B,P,D,M,C,VIC,1,0,1000,0.1,1,100,0,0,0";
    const result = await fromCsv(raw);
    expect(result.ok).toBe(true);
  });

  it("names the row and column in plain English on a bad value", async () => {
    const bad = [...goodRow];
    bad[11] = "abc"; // Bonus %
    const result = await fromCsv(csv([goodRow.map((v, i) => (i === 0 ? "ROW1X" : v)), bad]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toBe("Row 3, 'Bonus %': expected a number, got 'abc'");
  });

  it("lists missing columns by name", async () => {
    const pkgIdx = HEADERS.indexOf("Package");
    const noPkgHeaders = HEADERS.filter((_, i) => i !== pkgIdx);
    const noPkgRow = goodRow.filter((_, i) => i !== pkgIdx);
    const text = [noPkgHeaders.map(q).join(","), noPkgRow.map(q).join(",")].join("\n");
    const result = await fromCsv(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("Missing column");
    expect(result.errors[0]).toContain("'Package'");
  });

  it("rejects duplicate ids naming both rows", async () => {
    const result = await fromCsv(csv([goodRow, goodRow]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("'ABCDE' also appears on row 2");
  });

  it("rejects an empty file", async () => {
    const result = await fromCsv(HEADERS.join(","));
    expect(result.ok).toBe(false);
  });

  it("round-trips through a real xlsx workbook", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRow(HEADERS);
    ws.addRow([
      "XLSX1", "Smith", "Jane", "PM", "Delivery", "MB", "Employee",
      "VIC", 1, 0, 180000, 0.15, 0.9, 24300, 0, 20000, 0,
    ]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const { rows } = await parseImportFile("test.xlsx", buf);
    const result = rowsToEmployees(rows);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.employees[0]).toMatchObject({
      id: "XLSX1",
      pkg: 180000,
      bp: 0.15,
      st: "VIC",
      sm: 0,
    });
  });

  /**
   * Before this, an uncomputed formula here became the literal object,
   * which coerceCell then turned into the string "[object Object]" — a
   * confusing zod error on a numeric column, and on a text column, silent
   * corruption with no error raised at all. Both are now refused up front,
   * matching what the real EBS model importer already does.
   */
  it("refuses a formula with no calculated value on a numeric column", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRow(HEADERS);
    ws.addRow([
      "XLSX2", "Smith", "Jane", "PM", "Delivery", "MB", "Employee",
      "VIC", 1, 0, 180000, 0.15, 0.9, 24300, 0, 20000, 0,
    ]);
    // Package (column 11): a formula with no cached result — what a workbook
    // saved by anything other than Excel carries.
    ws.getRow(2).getCell(11).value = { formula: "A1*2" } as ExcelJS.CellValue;
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    let thrown: (Error & { errors?: string[] }) | null = null;
    try {
      await parseImportFile("test.xlsx", buf);
    } catch (e) {
      thrown = e as Error & { errors?: string[] };
    }
    expect(thrown).not.toBeNull();
    const detail = thrown!.errors?.join("\n") ?? "";
    expect(detail).toContain("Package");
    expect(detail).toContain("no calculated value");
    // the fix comes first, before naming individual cells
    expect(thrown!.message).toContain("Calculation Options");
  });

  it("refuses — rather than silently corrupting — a formula on a text column", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRow(HEADERS);
    ws.addRow([
      "XLSX3", "Smith", "Jane", "PM", "Delivery", "MB", "Employee",
      "VIC", 1, 0, 180000, 0.15, 0.9, 24300, 0, 20000, 0,
    ]);
    // Surname (column 2): the silent-corruption case — this used to become
    // the literal text "[object Object]" with no error raised at all.
    ws.getRow(2).getCell(2).value = { formula: "UPPER(B1)" } as ExcelJS.CellValue;
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    let thrown: (Error & { errors?: string[] }) | null = null;
    try {
      await parseImportFile("test.xlsx", buf);
    } catch (e) {
      thrown = e as Error & { errors?: string[] };
    }
    expect(thrown).not.toBeNull();
    const detail = thrown!.errors?.join("\n") ?? "";
    expect(detail).toContain("Surname");
    expect(detail).not.toContain("[object Object]");
  });

  /**
   * Found against a real re-saved workbook: some flagged cells had already
   * calculated fine, to a genuine Excel error, and "open it, save it" did
   * nothing for them because there was nothing left to recalculate.
   */
  it("gives different advice for a formula that already calculated to an error", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRow(HEADERS);
    ws.addRow([
      "XLSX4", "Smith", "Jane", "PM", "Delivery", "MB", "Employee",
      "VIC", 1, 0, 180000, 0.15, 0.9, 24300, 0, 20000, 0,
    ]);
    ws.getRow(2).getCell(11).value = {
      formula: "A1*2",
      result: { error: "#VALUE!" },
    } as ExcelJS.CellValue;
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    let thrown: (Error & { errors?: string[] }) | null = null;
    try {
      await parseImportFile("test.xlsx", buf);
    } catch (e) {
      thrown = e as Error & { errors?: string[] };
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toContain("Saving again won't fix");
    expect(thrown!.message).not.toContain("Calculation Options");
    expect(thrown!.errors?.join("\n")).toContain("results in #VALUE!");
  });
});

describe("import preview", () => {
  const mk = (id: string): Employee => ({
    id, sn: "S", gn: id, pos: "P", dept: "D", mgr: "M", cat: "C",
    st: "VIC", vp: 1, np: 0, pkg: 1000, bp: 0.1, ipm: 1, bipm: 100,
    da: 0, f25: 0, sm: 0,
  });

  it("reports added, removed and removed-with-entered-data by name", () => {
    const current = [mk("A"), mk("B"), mk("C")];
    const incoming = [mk("A"), mk("D")];
    const preview = buildImportPreview(current, incoming, {
      B: { daEdit: 500 },
      A: { ipmEdit: 0.8 },
    });
    expect(preview.added).toEqual(["D S"]);
    expect(preview.removed.sort()).toEqual(["B S", "C S"]);
    expect(preview.removedWithData).toEqual(["B S"]); // B has entered data, C doesn't
    expect(preview.rowCount).toBe(2);
  });
});

describe("candidateDataset", () => {
  const mk = (id: string): Employee => ({
    id, sn: "S", gn: id, pos: "P", dept: "D", mgr: "M", cat: "C",
    st: "VIC", vp: 1, np: 0, pkg: 1000, bp: 0.1, ipm: 1, bipm: 100,
    da: 0, f25: 0, sm: 0,
  });
  const current = (excludedIds: string[]): Dataset => ({
    emp: [mk("A")],
    vCap: 1,
    nCap: 1,
    gCap: 1,
    excludedIds,
    ...deriveFacets([mk("A")]),
  });

  it("drops a permanently excluded id even though the incoming file lists them", () => {
    const candidate = candidateDataset(current(["B"]), [mk("A"), mk("B")]);
    expect(candidate.emp.map((e) => e.id)).toEqual(["A"]);
  });

  it("carries excludedIds forward unchanged — only an exclude/unexclude patch touches it", () => {
    const candidate = candidateDataset(current(["B"]), [mk("A")]);
    expect(candidate.excludedIds).toEqual(["B"]);
  });

  it("carries the current caps forward when the file supplies none (flat file/CSV)", () => {
    const candidate = candidateDataset(current([]), [mk("A")]);
    expect(candidate.vCap).toBe(1);
    expect(candidate.nCap).toBe(1);
    expect(candidate.gCap).toBe(1);
  });

  it("replaces the caps with the file's own when supplied (FY26 model workbook)", () => {
    const candidate = candidateDataset(current([]), [mk("A")], {
      vCap: 1_593_574.32,
      nCap: 1_365_714.16,
      gCap: 2_959_288.48,
    });
    expect(candidate.vCap).toBe(1_593_574.32);
    expect(candidate.nCap).toBe(1_365_714.16);
    expect(candidate.gCap).toBe(2_959_288.48);
  });

  it("a dataset predating excludedIds still parses, defaulting to none excluded", () => {
    const legacy = {
      emp: [mk("A")],
      vCap: 1,
      nCap: 1,
      gCap: 1,
      ...deriveFacets([mk("A")]),
    };
    const parsed = DatasetSchema.parse(legacy);
    expect(parsed.excludedIds).toEqual([]);
  });

  // The model workbook has no state column — it INFERS state from the split,
  // so every split person comes back as SHARED. That guess must not undo an
  // admin's decision that someone is VIC staff doing a portion of NSW work.
  describe("home state on a split person", () => {
    const split = (over: Partial<Employee>): Employee => ({ ...mk("P"), ...over });
    const withCurrent = (cur: Employee, incoming: Employee) =>
      candidateDataset(
        { emp: [cur], vCap: 1, nCap: 1, gCap: 1, excludedIds: [], ...deriveFacets([cur]) },
        [incoming]
      ).emp[0];

    it("keeps a VIC flag when the sheet still splits them", () => {
      const row = withCurrent(
        split({ st: "VIC", vp: 0.92, np: 0.08 }),
        split({ st: "SHARED", vp: 0.92, np: 0.08 })
      );
      expect(row).toMatchObject({ st: "VIC", vp: 0.92, np: 0.08 });
    });

    it("keeps the flag but takes the sheet's new percentages", () => {
      // the workbook stays authoritative for the figures, the flag is ours
      const row = withCurrent(
        split({ st: "VIC", vp: 0.92, np: 0.08 }),
        split({ st: "SHARED", vp: 0.85, np: 0.15 })
      );
      expect(row).toMatchObject({ st: "VIC", vp: 0.85, np: 0.15 });
    });

    it("keeps an NSW flag the same way", () => {
      const row = withCurrent(
        split({ st: "NSW", vp: 0.3, np: 0.7 }),
        split({ st: "SHARED", vp: 0.3, np: 0.7 })
      );
      expect(row.st).toBe("NSW");
    });

    it("lets the sheet win when the split collapses — that is a real move", () => {
      const row = withCurrent(
        split({ st: "VIC", vp: 0.92, np: 0.08 }),
        split({ st: "NSW", vp: 0, np: 1 })
      );
      expect(row).toMatchObject({ st: "NSW", vp: 0, np: 1 });
    });

    it("leaves someone deliberately flagged Shared Services alone", () => {
      const row = withCurrent(
        split({ st: "SHARED", vp: 0.61, np: 0.39 }),
        split({ st: "SHARED", vp: 0.61, np: 0.39 })
      );
      expect(row.st).toBe("SHARED");
    });

    it("takes the inferred state for a new person — no decision to keep", () => {
      const cur = mk("A");
      const candidate = candidateDataset(
        { emp: [cur], vCap: 1, nCap: 1, gCap: 1, excludedIds: [], ...deriveFacets([cur]) },
        [cur, split({ id: "NEW", st: "SHARED", vp: 0.5, np: 0.5 })]
      );
      expect(candidate.emp[1]).toMatchObject({ st: "SHARED", vp: 0.5 });
    });

    it("does not touch a whole-pool person whose state is unchanged", () => {
      const row = withCurrent(mk("P"), mk("P"));
      expect(row).toMatchObject({ st: "VIC", vp: 1, np: 0 });
    });
  });
});

describe("filterImportedLocks", () => {
  const mk = (id: string, over: Partial<Employee> = {}): Employee => ({
    id, sn: "S", gn: id, pos: "P", dept: "D", mgr: "M", cat: "C",
    st: "VIC", vp: 1, np: 0, pkg: 1000, bp: 0.1, ipm: 1, bipm: 100,
    da: 0, f25: 0, sm: 0,
    ...over,
  });

  it("keeps sheet locks only for lockable rows: not site managers, out-of-pool rows or unknown ids", () => {
    const emp = [mk("NORMAL"), mk("SM", { sm: 1 }), mk("NOPOOL", { vp: 0, np: 0 })];
    const kept = filterImportedLocks(emp, {
      NORMAL: 1000,
      SM: 2000,
      NOPOOL: 3000,
      GONE: 4000, // not in the candidate roster at all
    });
    expect(kept).toEqual([["NORMAL", 1000]]);
  });

  it("keeps nothing when the sheet carries no locks", () => {
    expect(filterImportedLocks([mk("A")], {})).toEqual([]);
  });

  it("honours a sheet lock on a VIC site manager for an importer holding the grant (26 Aug 2026)", () => {
    const emp = [mk("SM", { sm: 1 }), mk("NOPOOL", { vp: 0, np: 0 })];
    expect(filterImportedLocks(emp, { SM: 2000, NOPOOL: 3000 }, { vicSiteManagers: true })).toEqual([
      ["SM", 2000],
    ]);
  });
});

/**
 * What payout each row carries out of an import. The case that matters most is
 * the middle one: a new roster moves the advisory calculation and leaves a
 * settled payout alone, because a payout is stored and only an explicit
 * redistribution rewrites it.
 */
describe("seedImportedBases", () => {
  const mk = (id: string, over: Partial<Employee> = {}): Employee => ({
    id, sn: "S", gn: id, pos: "P", dept: "D", mgr: "M", cat: "C",
    st: "VIC", vp: 1, np: 0, pkg: 4000, bp: 0.1, ipm: 1, bipm: 400,
    da: 0, f25: 0, sm: 0,
    ...over,
  });
  const roster = [mk("KEEP"), mk("NEW"), mk("SHEETLOCK")];
  const caps = { vCap: 1500, nCap: 1000, gCap: 5000 };

  /** Price the roster the way the route does before calling the seeder. */
  function priced(overrides: Overrides) {
    const rows = applyOverrides(roster, overrides);
    computeScalesAndBonuses(rows, caps);
    return rows;
  }

  it("leaves a settled payout alone — an import moves Calc, not Final", () => {
    const stored: Overrides = { KEEP: { baseAmount: 999 } };
    const out = seedImportedBases(priced(stored), stored, new Map());
    expect(out.KEEP.baseAmount).toBe(999);
  });

  it("gives a row new to the roster its entitlement", () => {
    const out = seedImportedBases(priced({}), {}, new Map());
    // the pool covers everyone here, so the scale is 1 and entitlement is bipm
    expect(out.NEW.baseAmount).toBeCloseTo(400, 8);
  });

  it("takes the sheet's locked figure as the payout, discretionary backed out", () => {
    const stored: Overrides = { SHEETLOCK: { daEdit: 250 } };
    const out = seedImportedBases(
      priced(stored),
      stored,
      new Map([["SHEETLOCK", 1000]])
    );
    // base 750 + the row's own 250 = the 1,000 the sheet stated
    expect(out.SHEETLOCK.baseAmount).toBeCloseTo(750, 8);
    expect(out.SHEETLOCK.baseAmount! + out.SHEETLOCK.daEdit!).toBeCloseTo(1000, 8);
  });

  it("the sheet's figure wins over a stored one, as every imported figure does", () => {
    const stored: Overrides = { SHEETLOCK: { baseAmount: 1 } };
    const out = seedImportedBases(
      priced(stored),
      stored,
      new Map([["SHEETLOCK", 1000]])
    );
    expect(out.SHEETLOCK.baseAmount).toBeCloseTo(1000, 8);
  });

  it("every row leaves an import with a stored payout, and none is mutated in place", () => {
    const stored: Overrides = { KEEP: { baseAmount: 999 } };
    const out = seedImportedBases(priced(stored), stored, new Map());
    for (const e of roster) expect(out[e.id].baseAmount).toBeTypeOf("number");
    expect(stored.NEW).toBeUndefined(); // the input document is untouched
  });

  it("prices nothing it was not given", () => {
    expect(seedImportedBases([], {}, new Map())).toEqual({});
  });
});
