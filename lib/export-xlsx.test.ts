/**
 * Export tests. The file is filed back to the HR folder as the final record,
 * so the two things that matter are that employee ID is in it and that it
 * round-trips: an export must be re-importable, or it is a report rather than
 * a working document.
 *
 * The workbook is built and then read back with the same parser the import
 * uses, which is the only honest way to test a binary format.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";
import type { Dataset, Overrides } from "./schema";
import { buildWorkbook, exportFilename } from "./export-xlsx";
import { parseImportFile, rowsToEmployees } from "./import-parse";

const data = JSON.parse(
  readFileSync(join(__dirname, "..", "data", "bonus.json"), "utf-8")
) as Dataset;

const META = {
  schemeName: "FY26 Employee Bonus Scheme",
  actor: "admin@texco.net.au",
  asOf: "2026-08-10T04:30:00.000Z",
  status: "Draft — not final",
};

const overrides: Overrides = {
  [data.emp[0].id]: { ipmEdit: 0.75 },
  [data.emp[1].id]: { daEdit: 2500 },
};

async function readBack(buffer: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  const rows: unknown[][] = [];
  ws.eachRow((row) => {
    rows.push((row.values as unknown[]).slice(1));
  });
  return { wb, ws, rows };
}

describe("the exported workbook", () => {
  it("puts the table first with headers on row 1 and nothing above them", async () => {
    // load-bearing: the import reads headers from row 1 of the first sheet, so
    // a title block here would break the round trip
    const { wb, ws, rows } = await readBack(await buildWorkbook(data, overrides, META));
    expect(wb.worksheets[0].name).toBe("Bonus scheme");
    expect(ws.getRow(1).getCell(1).value).toBe("ID");
    expect(rows.length).toBe(1 + data.emp.length); // header + people, no totals row
  });

  it("includes employee ID as the first column — HR reconcile by ID, not name", async () => {
    const { rows } = await readBack(await buildWorkbook(data, overrides, META));
    expect(rows[0][0]).toBe("ID");
    expect(String(rows[1][0])).toBe(data.emp[0].id);
  });

  it("carries the edited figures, not the source ones", async () => {
    const { rows } = await readBack(await buildWorkbook(data, overrides, META));
    const ipmCol = (rows[0] as string[]).indexOf("IPM %");
    expect(Number(rows[1][ipmCol])).toBeCloseTo(0.75, 10);
  });

  it("formats money and percentages rather than dumping raw numbers", async () => {
    const { ws } = await readBack(await buildWorkbook(data, overrides, META));
    const colOf = (name: string) => {
      let idx = 0;
      ws.getRow(1).eachCell((cell, n) => {
        if (cell.value === name) idx = n;
      });
      return idx;
    };
    expect(ws.getCell(2, colOf("Package")).numFmt).toContain("$");
    expect(ws.getCell(2, colOf("IPM %")).numFmt).toContain("%");
  });

  it("freezes the header and leaves it filterable", async () => {
    const { ws } = await readBack(await buildWorkbook(data, overrides, META));
    expect(ws.views[0].state).toBe("frozen");
    expect(ws.autoFilter).toBeTruthy();
  });
});

describe("the summary sheet", () => {
  const text = async (status?: string) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
      (await buildWorkbook(data, overrides, { ...META, status })) as unknown as ArrayBuffer
    );
    const about = wb.worksheets[1];
    const lines: string[] = [];
    about.eachRow((r) => lines.push((r.values as unknown[]).slice(1).join(" | ")));
    return { about, joined: lines.join("\n") };
  };

  it("says what the file is, when it was true and who produced it", async () => {
    const { about, joined } = await text(META.status);
    expect(about.name).toBe("Summary");
    expect(joined).toContain(META.schemeName);
    expect(joined).toContain(META.actor);
    expect(joined).toContain(META.status!);
  });

  it("carries the totals, so nobody has to re-add a column", async () => {
    const { joined } = await text();
    expect(joined).toContain("Total final bonus");
    expect(joined).toContain("Employees");
  });

  it("omits the status line when the banner is switched off", async () => {
    const { joined } = await text(undefined);
    expect(joined).not.toContain("Draft");
  });
});

describe("an export can be imported straight back", () => {
  it("round-trips through the import parser without an error", async () => {
    const buffer = await buildWorkbook(data, {}, META);
    const { rows: raw } = await parseImportFile("export.xlsx", buffer);
    expect(raw).toHaveLength(data.emp.length);

    const result = rowsToEmployees(raw);
    if ("errors" in result) throw new Error(result.errors.join("; "));
    expect(result.employees).toHaveLength(data.emp.length);

    const before = data.emp[0];
    const after = result.employees.find((e) => e.id === before.id)!;
    expect(after.sn).toBe(before.sn);
    expect(after.pkg).toBe(before.pkg);
    expect(after.st).toBe(before.st);
    expect(after.sm).toBe(before.sm);
    expect(after.vp).toBeCloseTo(before.vp, 10);
  });
});

describe("exportFilename", () => {
  it("sorts chronologically and is safe on every platform", () => {
    const name = exportFilename("FY26 Employee Bonus Scheme", "2026-08-10T04:30:00.000Z");
    expect(name).toBe("fy26-employee-bonus-scheme_2026-08-10_04-30-00.xlsx");
    expect(name).not.toMatch(/[:\\/*?"<>|]/);
  });

  it("copes with a scheme name that is all punctuation", () => {
    expect(exportFilename("!!!", "2026-08-10T04:30:00.000Z")).toMatch(/^bonus-scheme_/);
  });
});
