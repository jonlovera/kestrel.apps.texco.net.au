/**
 * Tests for the dataset edits: After IPM, the Shared Services VIC/NSW split,
 * moving someone between pools, and adding a new person. The load-bearing
 * assertion is still negative: the patch schema accepts nothing else, so a
 * client cannot reach package, bonus % or a name on an EXISTING row — those
 * come from the spreadsheet, because a typo in one cascades through every
 * figure. Note the old `{op:"split", vp, np}` shape below stays refused on
 * purpose — the split is reopened under the existing
 * `{op:"field", field:"vp"|"np"}` vocabulary, not that one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Dataset, Employee } from "./schema";
import {
  applyDatasetPatch,
  deriveFacets,
  excludedRoster,
  DatasetPatchSchema,
} from "./dataset-edit";
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

const dataset = (emps: Employee[], excludedIds: string[] = []): Dataset => ({
  emp: emps,
  vCap: 1_000_000,
  nCap: 500_000,
  gCap: 1_500_000,
  excludedIds,
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
    // the state used to be on this list; it is now deliberately editable
    // through {op:"state"} — see "moving someone between pools" below.
    // Adding a person was on this list too and is now deliberately reopened
    // through {op:"add"} — see "adding a person" below.
    ["an unknown state", { op: "state", id: "TEST1", st: "QLD" }],
    ["the pool split", { op: "split", id: "TEST1", vp: 0.5, np: 0.5 }],
    ["adding with a malformed employee", { op: "add", employee: { id: "NEW" } }],
    ["removing a person", { op: "remove", id: "TEST1" }],
  ];

  for (const [what, body] of cases) {
    it(`refuses ${what}`, () => {
      expect(DatasetPatchSchema.safeParse(body).success).toBe(false);
    });
  }
});

describe("moving someone between pools ({op:'state'})", () => {
  const vicOnly = dataset([emp({ id: "V1", st: "VIC", vp: 1, np: 0 })]);
  const shared = dataset([emp({ id: "S1", st: "SHARED", vp: 0.6, np: 0.4 })]);

  it("VIC → NSW flips the whole-pool split and records the move", () => {
    const res = apply(vicOnly, { op: "state", id: "V1", st: "NSW" });
    if (!res.ok) throw new Error(res.errors.join());
    const moved = res.dataset.emp[0];
    expect(moved.st).toBe("NSW");
    expect(moved.vp).toBe(0);
    expect(moved.np).toBe(1);
    expect(res.history[0].summary).toBe("Moved Jane Smith from VIC to NSW");
    expect(res.history[0]).toMatchObject({ kind: "dataset", empId: "V1", field: "st", from: "VIC", to: "NSW" });
  });

  it("→ Shared Services takes an explicit VIC share and derives NSW", () => {
    const res = apply(vicOnly, { op: "state", id: "V1", st: "SHARED", vp: 0.7 });
    if (!res.ok) throw new Error(res.errors.join());
    const moved = res.dataset.emp[0];
    expect(moved.st).toBe("SHARED");
    expect(moved.vp).toBe(0.7);
    expect(moved.np).toBe(0.3);
    expect(res.history[0].summary).toBe(
      "Moved Jane Smith from VIC to Shared Services (70.0% VIC / 30.0% NSW)"
    );
  });

  it("→ Shared Services without a share fails in plain English", () => {
    const res = apply(vicOnly, { op: "state", id: "V1", st: "SHARED" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors[0]).toBe(
      "Moving someone to Shared Services needs a VIC % for the split."
    );
  });

  it("Shared → NSW collapses the split onto one pool", () => {
    const res = apply(shared, { op: "state", id: "S1", st: "NSW" });
    if (!res.ok) throw new Error(res.errors.join());
    expect(res.dataset.emp[0]).toMatchObject({ st: "NSW", vp: 0, np: 1 });
    expect(res.history[0].summary).toBe("Moved Jane Smith from Shared Services to NSW");
  });

  it("re-stating a Shared person with a new split reads as a split change", () => {
    const res = apply(shared, { op: "state", id: "S1", st: "SHARED", vp: 0.8 });
    if (!res.ok) throw new Error(res.errors.join());
    expect(res.dataset.emp[0]).toMatchObject({ st: "SHARED", vp: 0.8, np: 0.2 });
    expect(res.history[0].summary).toBe(
      "Set VIC % for Jane Smith: 60.0% → 80.0% (NSW % follows automatically)"
    );
  });

  it("same state and split is a no-op with no history", () => {
    const res = apply(shared, { op: "state", id: "S1", st: "SHARED", vp: 0.6 });
    if (!res.ok) throw new Error(res.errors.join());
    expect(res.dataset).toBe(shared);
    expect(res.history).toEqual([]);
  });

  // The real case this op was reopened for: the VIC staff who do a portion of
  // NSW work were flagged Shared Services, which put them on the Shared tab
  // and in the Shared Services pool card. They belong to VIC; only their
  // funding divides.
  it("Shared → VIC can KEEP the split, and the history says so", () => {
    const split = dataset([emp({ id: "P1", st: "SHARED", vp: 0.92, np: 0.08 })]);
    const res = apply(split, { op: "state", id: "P1", st: "VIC", vp: 0.92 });
    if (!res.ok) throw new Error(res.errors.join());
    expect(res.dataset.emp[0]).toMatchObject({ st: "VIC", vp: 0.92, np: 0.08 });
    expect(res.history[0].summary).toBe(
      "Moved Jane Smith from Shared Services to VIC (92.0% VIC / 8.0% NSW)"
    );
  });

  it("→ VIC without a share still collapses onto the whole pool", () => {
    const res = apply(shared, { op: "state", id: "S1", st: "VIC" });
    if (!res.ok) throw new Error(res.errors.join());
    expect(res.dataset.emp[0]).toMatchObject({ st: "VIC", vp: 1, np: 0 });
    // no split to name, so the summary stays the plain move sentence
    expect(res.history[0].summary).toBe("Moved Jane Smith from Shared Services to VIC");
  });

  it("→ NSW takes a split too, deriving the VIC remainder", () => {
    const res = apply(vicOnly, { op: "state", id: "V1", st: "NSW", vp: 0.2 });
    if (!res.ok) throw new Error(res.errors.join());
    expect(res.dataset.emp[0]).toMatchObject({ st: "NSW", vp: 0.2, np: 0.8 });
    expect(res.history[0].summary).toBe(
      "Moved Jane Smith from VIC to NSW (20.0% VIC / 80.0% NSW)"
    );
  });

  it("changing only a VIC person's split reads as a split change", () => {
    const split = dataset([emp({ id: "P1", st: "VIC", vp: 0.92, np: 0.08 })]);
    const res = apply(split, { op: "state", id: "P1", st: "VIC", vp: 0.85 });
    if (!res.ok) throw new Error(res.errors.join());
    expect(res.dataset.emp[0]).toMatchObject({ st: "VIC", vp: 0.85, np: 0.15 });
    expect(res.history[0].summary).toBe(
      "Set VIC % for Jane Smith: 92.0% → 85.0% (NSW % follows automatically)"
    );
  });

  it("re-sending a VIC person's existing split is a no-op", () => {
    const split = dataset([emp({ id: "P1", st: "VIC", vp: 0.92, np: 0.08 })]);
    const res = apply(split, { op: "state", id: "P1", st: "VIC", vp: 0.92 });
    if (!res.ok) throw new Error(res.errors.join());
    expect(res.dataset).toBe(split);
    expect(res.history).toEqual([]);
  });

  it("avoids float residue in the derived share", () => {
    const res = apply(vicOnly, { op: "state", id: "V1", st: "SHARED", vp: 0.3 });
    if (!res.ok) throw new Error(res.errors.join());
    expect(res.dataset.emp[0].np).toBe(0.7);
  });

  it("does not mutate the input dataset", () => {
    apply(vicOnly, { op: "state", id: "V1", st: "NSW" });
    expect(vicOnly.emp[0].st).toBe("VIC");
    expect(vicOnly.emp[0].vp).toBe(1);
  });

  it("rejects an unknown employee", () => {
    const res = apply(vicOnly, { op: "state", id: "NOPE", st: "NSW" });
    expect(res.ok).toBe(false);
  });

  it("schema rejects an out-of-range share", () => {
    expect(
      DatasetPatchSchema.safeParse({ op: "state", id: "V1", st: "SHARED", vp: 1.5 }).success
    ).toBe(false);
  });
});

describe("the VIC/NSW funding split", () => {
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

  it("sets a split on a VIC employee — they can fund a slice of NSW work", () => {
    const res = apply(vicOnly, { op: "field", id: "V1", field: "vp", value: 0.92 });
    if (!res.ok) throw new Error(res.errors.join("; "));
    // stays VIC: the split says which caps fund them, not who they are
    expect(res.dataset.emp[0]).toMatchObject({ st: "VIC", vp: 0.92, np: 0.08 });
  });

  it("sets a split on an NSW employee too, deriving the VIC side", () => {
    const nswOnly = dataset([emp({ id: "N1", st: "NSW", vp: 0, np: 1 })]);
    const res = apply(nswOnly, { op: "field", id: "N1", field: "np", value: 0.85 });
    if (!res.ok) throw new Error(res.errors.join("; "));
    expect(res.dataset.emp[0]).toMatchObject({ st: "NSW", vp: 0.15, np: 0.85 });
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

describe("permanent exclusion", () => {
  const base = dataset([emp({ id: "E1" }), emp({ id: "E2", gn: "Bob" })]);

  it("removes the employee from emp immediately", () => {
    const res = apply(base, { op: "exclude", id: "E1" });
    if (!res.ok) throw new Error(res.errors.join("; "));
    expect(res.dataset.emp.map((e) => e.id)).toEqual(["E2"]);
  });

  it("adds the id to excludedIds", () => {
    const res = apply(base, { op: "exclude", id: "E1" });
    if (!res.ok) throw new Error();
    expect(res.dataset.excludedIds).toEqual(["E1"]);
  });

  it("names who was excluded in the history entry", () => {
    const res = apply(base, { op: "exclude", id: "E1" });
    if (!res.ok) throw new Error();
    expect(res.history).toHaveLength(1);
    expect(res.history[0].summary).toContain("Jane Smith");
    expect(res.history[0].empId).toBe("E1");
  });

  it("does not mutate the input dataset", () => {
    apply(base, { op: "exclude", id: "E1" });
    expect(base.emp.map((e) => e.id)).toEqual(["E1", "E2"]);
    expect(base.excludedIds).toEqual([]);
  });

  it("excluding someone already excluded is a no-op", () => {
    const already = dataset([emp({ id: "E2" })], ["E1"]);
    const res = apply(already, { op: "exclude", id: "E1" });
    if (!res.ok) throw new Error();
    expect(res.history).toHaveLength(0);
    expect(res.dataset).toBe(already);
  });

  it("rejects excluding an unknown employee", () => {
    const res = apply(base, { op: "exclude", id: "NOPE" });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.errors[0]).toContain("NOPE");
  });

  it("un-excluding removes the id from excludedIds, but does not restore the row", () => {
    const excluded = dataset([emp({ id: "E2" })], ["E1"]);
    const res = apply(excluded, { op: "unexclude", id: "E1" });
    if (!res.ok) throw new Error();
    expect(res.dataset.excludedIds).toEqual([]);
    expect(res.dataset.emp.map((e) => e.id)).toEqual(["E2"]);
    expect(res.history).toHaveLength(1);
  });

  it("un-excluding someone not on the list is a no-op", () => {
    const res = apply(base, { op: "unexclude", id: "E1" });
    if (!res.ok) throw new Error();
    expect(res.history).toHaveLength(0);
    expect(res.dataset).toBe(base);
  });

  it("rejects an empty id for either op", () => {
    expect(DatasetPatchSchema.safeParse({ op: "exclude", id: "" }).success).toBe(false);
    expect(DatasetPatchSchema.safeParse({ op: "unexclude", id: "" }).success).toBe(false);
  });

  it("looks up the display name from the exclude history entry", () => {
    const res = apply(base, { op: "exclude", id: "E1" });
    if (!res.ok) throw new Error();
    const roster = excludedRoster(res.dataset.excludedIds, res.history);
    expect(roster).toEqual([{ id: "E1", name: "Jane Smith" }]);
  });

  it("falls back to the bare id when no history entry names them", () => {
    expect(excludedRoster(["GHOST"], [])).toEqual([{ id: "GHOST", name: "GHOST" }]);
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

/**
 * Adding a person ({op:"add"}) — deliberately reopened. The invariants: ids
 * are normalised and unique (including against the excluded list, where the
 * next import would silently drop the person), the split is derived from the
 * state rather than trusted, the filter facets pick up any new values, and a
 * new starter added with the suggested After IPM (pkg x bp x ipm) carries a
 * company modifier of exactly 1 through the real engine.
 */
describe("adding a person ({op:'add'})", () => {
  const base = dataset([emp()]);
  const newbie = emp({
    id: "JOBLO",
    gn: "Jo",
    sn: "Bloggs",
    pos: "Delivery Manager",
    dept: "New Frontier",
    mgr: "Someone New",
    pkg: 150_000,
    bp: 0.1,
    ipm: 1,
    bipm: 15_000,
    f25: 0,
  });
  const add = (employee: Employee) => apply(base, { op: "add", employee });

  it("appends the person and derives the facets, with the history sentence", () => {
    const res = add(newbie);
    if (!res.ok) throw new Error(res.errors.join("; "));
    expect(res.dataset.emp).toHaveLength(2);
    expect(res.dataset.emp[1].id).toBe("JOBLO");
    // a brand-new department and manager reach the filter lists
    expect(res.dataset.depts).toContain("New Frontier");
    expect(res.dataset.mgrs).toContain("Someone New");
    expect(res.history).toHaveLength(1);
    expect(res.history[0].summary).toBe(
      "Added Jo Bloggs (Delivery Manager, New Frontier, VIC) with a package of $150,000"
    );
    expect(res.history[0].empId).toBe("JOBLO");
  });

  it("does not mutate the input dataset", () => {
    add(newbie);
    expect(base.emp).toHaveLength(1);
  });

  it("normalises the id to trimmed uppercase", () => {
    const res = add(emp({ ...newbie, id: " joblo " }));
    if (!res.ok) throw new Error(res.errors.join("; "));
    expect(res.dataset.emp[1].id).toBe("JOBLO");
  });

  it("refuses a malformed id, naming the convention", () => {
    const res = add(emp({ ...newbie, id: "J0-BL0" }));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.errors[0]).toContain("'ID'");
    expect(res.errors[0]).toContain("2 to 6 letters or digits");
  });

  it("refuses a duplicate id, naming who holds it", () => {
    const res = add(emp({ ...newbie, id: "TEST1" }));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.errors[0]).toBe("Employee id 'TEST1' already exists (Jane Smith).");
  });

  it("refuses an id on the excluded list, pointing at the un-exclude path", () => {
    // the old handler missed this: the add would succeed and the very next
    // import would silently drop the person via candidateDataset's filter
    const excl = dataset([emp()], ["JOBLO"]);
    const res = apply(excl, { op: "add", employee: newbie });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.errors[0]).toContain("permanently-excluded list");
    expect(res.errors[0]).toContain("Un-exclude");
  });

  it("derives np from the sent vp for every state — a lying np cannot land", () => {
    // the sent vp IS the VIC share, whatever the state; np always follows it,
    // so the two account for the whole of the new starter's exposure
    for (const st of ["VIC", "NSW", "SHARED"] as const) {
      const res = add(emp({ ...newbie, st, vp: 0.3, np: 0 }));
      if (!res.ok) throw new Error(res.errors.join("; "));
      expect(res.dataset.emp[1]).toMatchObject({ st, vp: 0.3, np: 0.7 });
      expect(res.dataset.emp[1].vp + res.dataset.emp[1].np).toBe(1);
    }
  });

  it("a whole-pool new starter keeps a clean 1/0, with no split in the history", () => {
    const res = add(emp({ ...newbie, st: "VIC", vp: 1, np: 0 }));
    if (!res.ok) throw new Error(res.errors.join("; "));
    expect(res.dataset.emp[1]).toMatchObject({ st: "VIC", vp: 1, np: 0 });
    expect(res.history[0].summary).not.toContain("VIC / ");
  });

  it("names the split in the history when a new starter has one", () => {
    const res = add(emp({ ...newbie, st: "VIC", vp: 0.9, np: 0.1 }));
    if (!res.ok) throw new Error(res.errors.join("; "));
    expect(res.history[0].summary).toContain("90.0% VIC / 10.0% NSW");
  });

  it("surfaces a labelled validation error for a bad figure", () => {
    const res = add(emp({ ...newbie, pkg: -1 }));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.errors[0]).toContain("'Package'");
  });

  it("a new starter with the suggested After IPM lands a company modifier of exactly 1", () => {
    const suggested = 150_000 * 0.1 * 1; // pkg x bp x ipm
    const res = apply(real, {
      op: "add",
      employee: emp({ ...newbie, bipm: suggested }),
    });
    if (!res.ok) throw new Error(res.errors.join("; "));
    const emps = applyOverrides(res.dataset.emp, {});
    computeScalesAndBonuses(emps, res.dataset);
    const added = emps.find((e) => e.id === "JOBLO")!;
    expect(added.cpm).toBeCloseTo(1, 12);
    // and they pro-rate against the pool like any other unlocked VIC row,
    // rather than getting the unscaled entitlement
    expect(added.calcBonus).toBeGreaterThan(0);
    expect(added.calcBonus).toBeLessThanOrEqual(suggested);
  });
});
