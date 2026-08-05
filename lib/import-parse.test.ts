import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import {
  parseImportFile,
  rowsToEmployees,
  buildImportPreview,
  FIELD_LABELS,
} from "./import-parse";
import type { Employee } from "./schema";

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
  return rowsToEmployees(await parseImportFile("test.csv", Buffer.from(text)));
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
    const result = rowsToEmployees(await parseImportFile("test.xlsx", buf));
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
