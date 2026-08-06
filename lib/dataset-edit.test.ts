/**
 * Inline dataset-edit tests. The load-bearing assertions: a patch is
 * all-or-nothing, the pool-weight invariant every source row holds cannot be
 * broken, and removing someone takes their overrides with them.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Dataset, Employee, Overrides } from "./schema";
import {
  applyDatasetPatch,
  deriveFacets,
  EDITABLE_DATASET_FIELDS,
  DatasetPatchSchema,
} from "./dataset-edit";
import { applyOverrides, computeScalesAndBonuses } from "./calc";

const real = JSON.parse(
  readFileSync(join(__dirname, "..", "data", "bonus.json"), "utf-8")
) as Dataset;

const ACTOR = "admin@texco.net.au";
const TS = "2026-08-06T00:00:00.000Z";

const emp = (over: Partial<Employee> = {}): Employee => ({
  id: "TEST1",
  sn: "Smith",
  gn: "Jane",
  pos: "Engineer",
  dept: "Construction Delivery",
  mgr: "Brock Ellett",
  cat: "Employee",
  st: "VIC",
  vp: 1,
  np: 0,
  pkg: 200_000,
  bp: 0.1,
  ipm: 1,
  bipm: 20_000,
  da: 0,
  f25: 15_000,
  sm: 0,
  ...over,
});

const dataset = (emps: Employee[]): Dataset => ({
  emp: emps,
  vCap: 1_000_000,
  nCap: 500_000,
  gCap: 1_500_000,
  ...deriveFacets(emps),
});

const apply = (
  data: Dataset,
  patch: Parameters<typeof applyDatasetPatch>[1],
  overrides: Overrides = {}
) => applyDatasetPatch(data, patch, overrides, ACTOR, TS);

describe("field edits", () => {
  const base = dataset([emp()]);

  it("changes the value and records a history entry", () => {
    const res = apply(base, { op: "field", id: "TEST1", field: "f25", value: 18_000 });
    if (!res.ok) throw new Error(res.errors.join("; "));
    expect(res.dataset.emp[0].f25).toBe(18_000);
    expect(res.history).toHaveLength(1);
    expect(res.history[0].kind).toBe("dataset");
    expect(res.history[0].summary).toBe(
      "Set FY25 bonus for Jane Smith: $15,000 → $18,000"
    );
    expect(res.history[0].from).toBe(15_000);
    expect(res.history[0].to).toBe(18_000);
  });

  it("does not mutate the input dataset", () => {
    apply(base, { op: "field", id: "TEST1", field: "pkg", value: 999 });
    expect(base.emp[0].pkg).toBe(200_000);
  });

  it("a no-op edit changes the value but records no history", () => {
    const res = apply(base, { op: "field", id: "TEST1", field: "f25", value: 15_000 });
    if (!res.ok) throw new Error();
    expect(res.history).toHaveLength(0);
  });

  it("the site-manager flag reads as yes/no in history", () => {
    const res = apply(base, { op: "field", id: "TEST1", field: "sm", value: 1 });
    if (!res.ok) throw new Error();
    expect(res.history[0].summary).toBe("Set Site manager for Jane Smith: no → yes");
    expect(res.dataset.emp[0].sm).toBe(1);
  });

  it("rejects a negative package, changing nothing", () => {
    const res = apply(base, { op: "field", id: "TEST1", field: "pkg", value: -1 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.errors[0]).toContain("Package");
  });

  it("rejects a site-manager flag that isn't 0 or 1", () => {
    const res = apply(base, { op: "field", id: "TEST1", field: "sm", value: 2 });
    expect(res.ok).toBe(false);
  });

  it("rejects an unknown employee id", () => {
    const res = apply(base, { op: "field", id: "NOPE", field: "pkg", value: 1 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.errors[0]).toContain("NOPE");
  });

  it("only the four intended fields are cell-editable", () => {
    expect([...EDITABLE_DATASET_FIELDS]).toEqual(["pkg", "bipm", "f25", "sm"]);
  });

  it("the schema rejects a field outside that list", () => {
    const parsed = DatasetPatchSchema.safeParse({
      op: "field",
      id: "TEST1",
      field: "pos",
      value: 1,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("identity text edits", () => {
  const base = dataset([emp()]);

  it("renames and records the before/after in history", () => {
    const res = apply(base, { op: "text", id: "TEST1", field: "pos", value: "Senior Engineer" });
    if (!res.ok) throw new Error(res.errors.join("; "));
    expect(res.dataset.emp[0].pos).toBe("Senior Engineer");
    expect(res.history[0].summary).toBe(
      'Set Position for Jane Smith: "Engineer" → "Senior Engineer"'
    );
  });

  it("trims surrounding whitespace", () => {
    const res = apply(base, { op: "text", id: "TEST1", field: "sn", value: "  Smyth  " });
    if (!res.ok) throw new Error();
    expect(res.dataset.emp[0].sn).toBe("Smyth");
  });

  it("rejects an empty or whitespace-only value", () => {
    for (const value of ["", "   "]) {
      const res = apply(base, { op: "text", id: "TEST1", field: "dept", value });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error();
      expect(res.errors[0]).toBe("'Department' can't be empty.");
    }
  });

  it("rejects an over-length value", () => {
    const res = apply(base, { op: "text", id: "TEST1", field: "pos", value: "x".repeat(61) });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.errors[0]).toContain("too long");
  });

  it("a no-op rename records no history and leaves the dataset alone", () => {
    const res = apply(base, { op: "text", id: "TEST1", field: "pos", value: "Engineer" });
    if (!res.ok) throw new Error();
    expect(res.history).toHaveLength(0);
    expect(res.dataset).toBe(base);
  });

  it("renaming a department re-derives the filter lists", () => {
    const two = dataset([emp(), emp({ id: "TEST2", gn: "Bob", dept: "Legal" })]);
    const res = apply(two, { op: "text", id: "TEST2", field: "dept", value: "Legal & Risk" });
    if (!res.ok) throw new Error();
    expect(res.dataset.depts).toEqual(["Construction Delivery", "Legal & Risk"]);
  });

  it("the old group disappears once its last member leaves", () => {
    const two = dataset([emp(), emp({ id: "TEST2", gn: "Bob", dept: "Legal" })]);
    const res = apply(two, {
      op: "text",
      id: "TEST2",
      field: "dept",
      value: "Construction Delivery",
    });
    if (!res.ok) throw new Error();
    expect(res.dataset.depts).toEqual(["Construction Delivery"]);
  });

  it("changing a manager and a category re-derives those lists too", () => {
    const mgr = apply(base, { op: "text", id: "TEST1", field: "mgr", value: "Ada Manager" });
    if (!mgr.ok) throw new Error();
    expect(mgr.dataset.mgrs).toEqual(["Ada Manager"]);

    const cat = apply(base, { op: "text", id: "TEST1", field: "cat", value: "Texco Management" });
    if (!cat.ok) throw new Error();
    expect(cat.dataset.cats).toEqual(["Texco Management"]);
  });

  it("a name change does not touch the filter lists", () => {
    const res = apply(base, { op: "text", id: "TEST1", field: "gn", value: "Janet" });
    if (!res.ok) throw new Error();
    expect(res.dataset.depts).toEqual(base.depts);
    expect(res.dataset.emp[0].gn).toBe("Janet");
  });

  it("the schema refuses a field outside the editable text list", () => {
    expect(
      DatasetPatchSchema.safeParse({ op: "text", id: "TEST1", field: "id", value: "X" }).success
    ).toBe(false);
    expect(
      DatasetPatchSchema.safeParse({ op: "text", id: "TEST1", field: "st", value: "VIC" }).success
    ).toBe(false);
  });
});

describe("state changes carry the pool split", () => {
  const cases: [Employee["st"], number, number, Employee["st"], number, number][] = [
    ["VIC", 1, 0, "NSW", 0, 1],
    ["VIC", 1, 0, "SHARED", 0.5, 0.5],
    ["NSW", 0, 1, "VIC", 1, 0],
    ["NSW", 0, 1, "SHARED", 0.5, 0.5],
    ["SHARED", 0.6, 0.4, "VIC", 1, 0],
    ["SHARED", 0.6, 0.4, "NSW", 0, 1],
  ];

  for (const [from, vp, np, to, wantVp, wantNp] of cases) {
    it(`${from} → ${to} lands on a valid split`, () => {
      const base = dataset([emp({ st: from, vp, np })]);
      const res = apply(base, { op: "state", id: "TEST1", st: to });
      if (!res.ok) throw new Error(res.errors.join("; "));
      expect(res.dataset.emp[0].st).toBe(to);
      expect(res.dataset.emp[0].vp).toBe(wantVp);
      expect(res.dataset.emp[0].np).toBe(wantNp);
      expect(res.history[0].summary).toContain(`${from} → ${to}`);
    });
  }

  it("a shared row keeps its own proportions when it stays shared", () => {
    const base = dataset([emp({ st: "SHARED", vp: 0.7, np: 0.3 })]);
    const res = apply(base, { op: "state", id: "TEST1", st: "SHARED" });
    if (!res.ok) throw new Error();
    expect(res.dataset.emp[0].vp).toBe(0.7);
    expect(res.history).toHaveLength(0); // no change at all
  });

  it("someone outside both pools stays outside them", () => {
    const base = dataset([emp({ st: "SHARED", vp: 0, np: 0 })]);
    const res = apply(base, { op: "state", id: "TEST1", st: "VIC" });
    if (!res.ok) throw new Error(res.errors.join("; "));
    expect(res.dataset.emp[0].vp).toBe(0);
    expect(res.dataset.emp[0].np).toBe(0);
  });

  it("every real employee can be moved to every state", () => {
    for (const e of real.emp.slice(0, 20)) {
      for (const st of ["VIC", "NSW", "SHARED"] as const) {
        const res = applyDatasetPatch(real, { op: "state", id: e.id, st }, {}, ACTOR, TS);
        expect(res.ok, `${e.gn} ${e.sn} ${e.st} → ${st}`).toBe(true);
      }
    }
  });
});

describe("pool split", () => {
  it("moves both weights together on a shared row", () => {
    const base = dataset([emp({ st: "SHARED", vp: 0.6, np: 0.4 })]);
    const res = apply(base, { op: "split", id: "TEST1", vp: 0.75, np: 0.25 });
    if (!res.ok) throw new Error(res.errors.join("; "));
    expect(res.dataset.emp[0].vp).toBe(0.75);
    expect(res.dataset.emp[0].np).toBe(0.25);
    expect(res.history[0].summary).toBe(
      "Set pool split for Jane Smith: VIC 60% / NSW 40% → VIC 75% / NSW 25%"
    );
  });

  it("rejects a split that doesn't add up to 100%", () => {
    const base = dataset([emp({ st: "SHARED", vp: 0.6, np: 0.4 })]);
    const res = apply(base, { op: "split", id: "TEST1", vp: 0.5, np: 0.3 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.errors[0]).toContain("add up to 100%");
  });

  it("allows 0/0 — someone outside both pools", () => {
    const base = dataset([emp({ st: "SHARED", vp: 0.5, np: 0.5 })]);
    const res = apply(base, { op: "split", id: "TEST1", vp: 0, np: 0 });
    expect(res.ok).toBe(true);
  });

  it("rejects an NSW share on a VIC employee", () => {
    const base = dataset([emp({ st: "VIC" })]);
    const res = apply(base, { op: "split", id: "TEST1", vp: 0.5, np: 0.5 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.errors[0]).toContain("NSW share must be 0%");
  });

  it("rejects a VIC share on an NSW employee", () => {
    const base = dataset([emp({ st: "NSW", vp: 0, np: 1 })]);
    const res = apply(base, { op: "split", id: "TEST1", vp: 0.5, np: 0.5 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.errors[0]).toContain("VIC share must be 0%");
  });

  it("rejects an all-VIC split on a shared employee", () => {
    const base = dataset([emp({ st: "SHARED", vp: 0.6, np: 0.4 })]);
    const res = apply(base, { op: "split", id: "TEST1", vp: 1, np: 0 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.errors[0]).toContain("above 0%");
  });

  it("every row in the real dataset already satisfies the invariant", () => {
    for (const e of real.emp) {
      const res = applyDatasetPatch(
        real,
        { op: "split", id: e.id, vp: e.vp, np: e.np },
        {},
        ACTOR,
        TS
      );
      expect(res.ok, `${e.gn} ${e.sn} (${e.st}) failed the split check`).toBe(true);
    }
  });
});

describe("add", () => {
  const base = dataset([emp()]);

  it("appends the employee and re-derives the filter lists", () => {
    const res = apply(base, {
      op: "add",
      employee: emp({ id: "NEW1", gn: "Ali", sn: "Khan", dept: "Legal", mgr: "Matt Barker" }),
    });
    if (!res.ok) throw new Error(res.errors.join("; "));
    expect(res.dataset.emp).toHaveLength(2);
    expect(res.dataset.depts).toEqual(["Construction Delivery", "Legal"]);
    expect(res.dataset.mgrs).toEqual(["Brock Ellett", "Matt Barker"]);
    expect(res.history[0].summary).toContain("Added Ali Khan");
  });

  it("keeps the caps untouched", () => {
    const res = apply(base, { op: "add", employee: emp({ id: "NEW1" }) });
    if (!res.ok) throw new Error();
    expect(res.dataset.vCap).toBe(base.vCap);
    expect(res.dataset.nCap).toBe(base.nCap);
    expect(res.dataset.gCap).toBe(base.gCap);
  });

  it("rejects a duplicate id and names who holds it", () => {
    const res = apply(base, { op: "add", employee: emp({ gn: "Other" }) });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.errors[0]).toContain("already exists");
    expect(res.errors[0]).toContain("Jane Smith");
  });

  it("rejects a new employee whose split contradicts their state", () => {
    const res = apply(base, {
      op: "add",
      employee: emp({ id: "NEW1", st: "NSW", vp: 1, np: 0 }),
    });
    expect(res.ok).toBe(false);
  });
});

describe("remove", () => {
  const base = dataset([emp(), emp({ id: "TEST2", gn: "Bob", dept: "Legal" })]);

  it("drops the row and re-derives the filter lists", () => {
    const res = apply(base, { op: "remove", id: "TEST2" });
    if (!res.ok) throw new Error(res.errors.join("; "));
    expect(res.dataset.emp.map((e) => e.id)).toEqual(["TEST1"]);
    expect(res.dataset.depts).toEqual(["Construction Delivery"]);
    expect(res.history[0].summary).toBe("Removed Bob Smith");
  });

  it("takes the removed employee's overrides with them", () => {
    const overrides: Overrides = {
      TEST1: { ipmEdit: 0.9 },
      TEST2: { daEdit: 5000, locked: true, lockedFinal: 1 },
    };
    const res = apply(base, { op: "remove", id: "TEST2" }, overrides);
    if (!res.ok) throw new Error();
    expect(res.overrides).toEqual({ TEST1: { ipmEdit: 0.9 } });
    expect(res.overridesChanged).toBe(true);
    expect(res.history[0].summary).toContain("and their entered figures");
  });

  it("reports no override change when the removed employee had none", () => {
    const res = apply(base, { op: "remove", id: "TEST2" }, { TEST1: { ipmEdit: 0.9 } });
    if (!res.ok) throw new Error();
    expect(res.overridesChanged).toBe(false);
    expect(res.history[0].summary).toBe("Removed Bob Smith");
  });

  it("rejects an unknown id", () => {
    expect(apply(base, { op: "remove", id: "NOPE" }).ok).toBe(false);
  });
});

describe("a package edit carries After IPM with it", () => {
  const base = dataset([emp({ pkg: 200_000, bipm: 20_000 })]);

  it("scales After IPM by the same ratio", () => {
    const res = apply(base, { op: "field", id: "TEST1", field: "pkg", value: 220_000 });
    if (!res.ok) throw new Error(res.errors.join("; "));
    expect(res.dataset.emp[0].pkg).toBe(220_000);
    expect(res.dataset.emp[0].bipm).toBe(22_000);
    expect(res.history[0].summary).toBe(
      "Set Package for Jane Smith: $200,000 → $220,000 (After IPM followed pro rata: $20,000 → $22,000)"
    );
  });

  it("leaves After IPM alone when the old package was 0 (no ratio to apply)", () => {
    const zero = dataset([emp({ pkg: 0, bipm: 5_000 })]);
    const res = apply(zero, { op: "field", id: "TEST1", field: "pkg", value: 100_000 });
    if (!res.ok) throw new Error();
    expect(res.dataset.emp[0].bipm).toBe(5_000);
  });

  it("editing After IPM directly does not touch the package", () => {
    const res = apply(base, { op: "field", id: "TEST1", field: "bipm", value: 30_000 });
    if (!res.ok) throw new Error();
    expect(res.dataset.emp[0].pkg).toBe(200_000);
    expect(res.dataset.emp[0].bipm).toBe(30_000);
  });
});

describe("edits flow through the real calc engine", () => {
  it("a package edit alone would be a no-op — the pro-rata bipm is what moves the bonus", () => {
    const target = real.emp.find((e) => !e.sm && e.st === "VIC" && e.pkg > 0)!;
    const bonusOf = (data: Dataset) => {
      const emps = applyOverrides(data.emp, {});
      computeScalesAndBonuses(emps, data);
      return emps.find((e) => e.id === target.id)!.bipmCalc;
    };
    const before = bonusOf(real);

    // pkg alone: the engine's derived cpm cancels it out exactly
    const pkgOnly: Dataset = {
      ...real,
      emp: real.emp.map((e) => (e.id === target.id ? { ...e, pkg: e.pkg * 2 } : e)),
    };
    expect(bonusOf(pkgOnly)).toBe(before);

    // through applyDatasetPatch, bipm follows and the bonus doubles
    const res = apply(real, {
      op: "field",
      id: target.id,
      field: "pkg",
      value: target.pkg * 2,
    });
    if (!res.ok) throw new Error(res.errors.join("; "));
    expect(bonusOf(res.dataset)).toBeCloseTo(before * 2, 6);
  });

  it("removing an employee removes their bonus from the group total", () => {
    const target = real.emp.find((e) => !e.sm && e.vp + e.np > 0)!;
    const res = apply(real, { op: "remove", id: target.id });
    if (!res.ok) throw new Error();
    const emps = applyOverrides(res.dataset.emp, {});
    computeScalesAndBonuses(emps, res.dataset);
    expect(emps.find((e) => e.id === target.id)).toBeUndefined();
    expect(emps).toHaveLength(real.emp.length - 1);
  });
});
