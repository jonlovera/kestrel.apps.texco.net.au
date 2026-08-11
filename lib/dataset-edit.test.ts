/**
 * Tests for the remaining dataset edits: After IPM, and the Shared Services
 * VIC/NSW split. The load-bearing assertion is negative: the patch schema
 * accepts nothing else, so a client cannot reach package, bonus %, a name, or
 * who exists — those come from the spreadsheet, because a typo in one
 * cascades through every figure. Note the old `{op:"split", vp, np}` shape
 * below stays refused on purpose — the split is reopened under the existing
 * `{op:"field", field:"vp"|"np"}` vocabulary, not that one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Dataset, Employee } from "./schema";
import { applyDatasetPatch, deriveFacets, DatasetPatchSchema } from "./dataset-edit";
import { applyOverrides, computeScalesAndBonuses } from "./calc";

const real = JSON.parse(
  readFileSync(join(__dirname, "..", "data", "bonus.json"), "utf-8")
) as Dataset;

const ACTOR = "admin@texco.net.au";
const TS = "2026-08-10T00:00:00.000Z";

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

const apply = (data: Dataset, patch: Parameters<typeof applyDatasetPatch>[1]) =>
  applyDatasetPatch(data, patch, ACTOR, TS);

const patch = (id: string, value: number) =>
  ({ op: "field", id, field: "bipm", value }) as const;

describe("After IPM is the only editable dataset field", () => {
  const base = dataset([emp()]);

  it("changes the figure and records the before/after", () => {
    const res = apply(base, patch("TEST1", 25_000));
    if (!res.ok) throw new Error(res.errors.join("; "));
    expect(res.dataset.emp[0].bipm).toBe(25_000);
    expect(res.history).toHaveLength(1);
    expect(res.history[0].kind).toBe("dataset");
    expect(res.history[0].summary).toBe(
      "Set After IPM for Jane Smith: $20,000 → $25,000"
    );
    expect(res.history[0].from).toBe(20_000);
    expect(res.history[0].to).toBe(25_000);
  });

  it("does not mutate the input dataset", () => {
    apply(base, patch("TEST1", 999));
    expect(base.emp[0].bipm).toBe(20_000);
  });

  it("leaves every other field of the row alone", () => {
    const res = apply(base, patch("TEST1", 25_000));
    if (!res.ok) throw new Error();
    const { bipm: _ignored, ...rest } = res.dataset.emp[0];
    void _ignored;
    const { bipm: _also, ...before } = base.emp[0];
    void _also;
    expect(rest).toEqual(before);
  });

  it("a no-op edit records no history", () => {
    const res = apply(base, patch("TEST1", 20_000));
    if (!res.ok) throw new Error();
    expect(res.history).toHaveLength(0);
  });

  it("rejects a negative figure", () => {
    expect(DatasetPatchSchema.safeParse(patch("TEST1", -1)).success).toBe(false);
  });

  it("rejects an unknown employee", () => {
    const res = apply(base, patch("NOPE", 1));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.errors[0]).toContain("NOPE");
  });
});

describe("the locked-down fields are unreachable through this API", () => {
  const cases: [string, unknown][] = [
    ["package", { op: "field", id: "TEST1", field: "pkg", value: 1 }],
    ["bonus %", { op: "field", id: "TEST1", field: "bp", value: 0.5 }],
    ["FY25 bonus", { op: "field", id: "TEST1", field: "f25", value: 1 }],
    ["site-manager flag", { op: "field", id: "TEST1", field: "sm", value: 1 }],
    ["employee id", { op: "field", id: "TEST1", field: "id", value: 1 }],
    ["a name", { op: "text", id: "TEST1", field: "gn", value: "Bob" }],
    ["a department", { op: "text", id: "TEST1", field: "dept", value: "Legal" }],
    ["the state", { op: "state", id: "TEST1", st: "NSW" }],
    ["the pool split", { op: "split", id: "TEST1", vp: 0.5, np: 0.5 }],
    ["adding a person", { op: "add", employee: emp({ id: "NEW" }) }],
    ["removing a person", { op: "remove", id: "TEST1" }],
  ];

  for (const [what, body] of cases) {
    it(`refuses ${what}`, () => {
      expect(DatasetPatchSchema.safeParse(body).success).toBe(false);
    });
  }
});

describe("the Shared Services split", () => {
  const shared = dataset([
    emp({ id: "S1", st: "SHARED", vp: 0.6, np: 0.4 }),
  ]);
  const vicOnly = dataset([emp({ id: "V1", st: "VIC", vp: 1, np: 0 })]);

  it("setting one side derives the other, so they always sum to 100%", () => {
    const res = apply(shared, { op: "field", id: "S1", field: "vp", value: 0.7 });
    if (!res.ok) throw new Error(res.errors.join("; "));
    expect(res.dataset.emp[0].vp).toBe(0.7);
    expect(res.dataset.emp[0].np).toBeCloseTo(0.3, 10);
  });

  it("setting the other side works the same way, symmetrically", () => {
    const res = apply(shared, { op: "field", id: "S1", field: "np", value: 0.25 });
    if (!res.ok) throw new Error(res.errors.join("; "));
    expect(res.dataset.emp[0].np).toBe(0.25);
    expect(res.dataset.emp[0].vp).toBeCloseTo(0.75, 10);
  });

  it("avoids float residue from 1 - value", () => {
    const res = apply(shared, { op: "field", id: "S1", field: "vp", value: 0.3 });
    if (!res.ok) throw new Error(res.errors.join("; "));
    // naive 1 - 0.3 in floating point is 0.7000000000000001
    expect(res.dataset.emp[0].np).toBe(0.7);
  });

  it("refuses a split on a VIC or NSW employee — there is nothing to reallocate", () => {
    const res = apply(vicOnly, { op: "field", id: "V1", field: "vp", value: 0.5 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.errors[0]).toContain("Shared Services");
  });

  it("rejects a value outside 0–1", () => {
    expect(
      DatasetPatchSchema.safeParse({ op: "field", id: "S1", field: "vp", value: 1.5 }).success
    ).toBe(false);
    expect(
      DatasetPatchSchema.safeParse({ op: "field", id: "S1", field: "np", value: -0.1 }).success
    ).toBe(false);
  });

  it("a no-op edit records no history", () => {
    const res = apply(shared, { op: "field", id: "S1", field: "vp", value: 0.6 });
    if (!res.ok) throw new Error();
    expect(res.history).toHaveLength(0);
  });

  it("records the before/after, naming which side follows automatically", () => {
    const res = apply(shared, { op: "field", id: "S1", field: "vp", value: 0.8 });
    if (!res.ok) throw new Error();
    expect(res.history[0].field).toBe("vp");
    expect(res.history[0].from).toBe(0.6);
    expect(res.history[0].to).toBe(0.8);
    expect(res.history[0].summary).toContain("NSW");
  });

  it("does not mutate the input dataset", () => {
    apply(shared, { op: "field", id: "S1", field: "vp", value: 0.99 });
    expect(shared.emp[0].vp).toBe(0.6);
    expect(shared.emp[0].np).toBe(0.4);
  });

});

describe("the change flows through the real calc engine", () => {
  it("doubling After IPM doubles that person's bonus", () => {
    const target = real.emp.find((e) => !e.sm && e.st === "VIC" && e.bipm > 0)!;
    const bonusOf = (data: Dataset) => {
      const emps = applyOverrides(data.emp, {});
      computeScalesAndBonuses(emps, data);
      return emps.find((e) => e.id === target.id)!.bipmCalc;
    };
    const before = bonusOf(real);
    const res = apply(real, patch(target.id, target.bipm * 2));
    if (!res.ok) throw new Error(res.errors.join("; "));
    expect(bonusOf(res.dataset)).toBeCloseTo(before * 2, 6);
  });

  it("a site manager's fixed figure moves with it, still unscaled", () => {
    // guards the walkthrough rule: site managers don't pro-rata against the pool
    const sm = real.emp.find((e) => e.sm && e.bipm > 0)!;
    const res = apply(real, patch(sm.id, sm.bipm * 1.5));
    if (!res.ok) throw new Error();
    const emps = applyOverrides(res.dataset.emp, {});
    computeScalesAndBonuses(emps, res.dataset);
    const after = emps.find((e) => e.id === sm.id)!;
    expect(after.finalBonus).toBeCloseTo(sm.bipm * 1.5, 6);
  });
});
