/**
 * Discretionary headroom and grant impact.
 *
 * The fixture is small enough to check by hand: one pool (VIC, cap 1000), two
 * unlocked rows demanding 1000 between them, so the scale is exactly 1 and the
 * pool starts exactly spent. Under the pool-funded model that is NOT a reason a
 * grant is impossible — the money comes out of the other unlocked bonuses — so
 * the headroom here is real, and it is what these tests pin.
 */
import { describe, it, expect } from "vitest";
import type { Dataset, Employee, Overrides } from "./schema";
import { applyOverrides, computeScalesAndBonuses } from "./calc";
import {
  DA_POLICY,
  clampDa,
  daGrants,
  daHeadroom,
  daImpact,
} from "./da-impact";

function emp(over: Partial<Employee> & { id: string }): Employee {
  return {
    sn: "Surname",
    gn: "Given",
    pos: "Role",
    dept: "Dept",
    mgr: "Mgr",
    cat: "Employee",
    st: "VIC",
    vp: 1,
    np: 0,
    pkg: 4000,
    bp: 0.1,
    ipm: 1,
    bipm: 400,
    da: 0,
    f25: 0,
    sm: 0,
    ...over,
  };
}

/** A, B and C split a VIC pool of 1200 that they demand exactly. */
const data: Dataset = {
  emp: [
    emp({ id: "A", gn: "Ann", sn: "Alpha", bipm: 400, pkg: 4000 }),
    emp({ id: "B", gn: "Ben", sn: "Beta", bipm: 400, pkg: 4000 }),
    emp({ id: "C", gn: "Cal", sn: "Gamma", bipm: 400, pkg: 4000 }),
  ],
  vCap: 1200,
  nCap: 1000,
  gCap: 2200,
  cats: ["Employee"],
  depts: ["Dept"],
  mgrs: ["Mgr"],
  excludedIds: [],
};

function pooled(doc: Overrides = {}) {
  const rows = applyOverrides(data.emp, doc);
  const pool = computeScalesAndBonuses(rows, data);
  return { rows, pool };
}

describe("daHeadroom", () => {
  it("is the whole of the other unlocked bonuses, not the unspent cap", () => {
    const { rows, pool } = pooled();
    // the pool is exactly spent, so there is no unspent cap at all…
    expect(rows.reduce((s, e) => s + e.finalBonus, 0)).toBeCloseTo(1200, 8);
    // …yet A can still be granted what B and C hold between them
    expect(daHeadroom(rows.find((e) => e.id === "A")!, pool)).toBe(800);
  });

  it("stops exactly where the other unlocked bonuses reach $0", () => {
    const { rows, pool } = pooled();
    const headroom = daHeadroom(rows.find((e) => e.id === "A")!, pool);
    const at = pooled({ A: { daEdit: headroom } });
    const others = at.rows.filter((e) => e.id !== "A");
    expect(Math.min(...others.map((e) => e.finalBonus))).toBeCloseTo(0, 6);
    expect(at.pool.vicScale).toBeCloseTo(0, 6);
    // and the pool cap still holds, which is the reform's own guarantee
    expect(at.rows.reduce((s, e) => s + e.finalBonus, 0)).toBeLessThanOrEqual(
      data.vCap + 0.01
    );
  });

  it("excludes locked bonuses — they cannot be reduced", () => {
    const { rows, pool } = pooled({ C: { locked: true, lockedFinal: 400 } });
    // C's 400 is frozen, so only B's 400 is available to fund a grant to A
    expect(daHeadroom(rows.find((e) => e.id === "A")!, pool)).toBe(400);
  });

  it("excludes a site manager's fixed bonus", () => {
    const smData: Dataset = {
      ...data,
      emp: [data.emp[0], data.emp[1], emp({ id: "C", bipm: 400, sm: 1 })],
    };
    const rows = applyOverrides(smData.emp, {});
    const pool = computeScalesAndBonuses(rows, smData);
    // C's 400 is fixed and unscalable, so again only B's 400 funds a grant
    expect(daHeadroom(rows.find((e) => e.id === "A")!, pool)).toBe(400);
  });

  it("a site manager can receive a grant, and the others pay for it (24 Aug 2026)", () => {
    const smData: Dataset = {
      ...data,
      emp: [data.emp[0], data.emp[1], emp({ id: "C", bipm: 400, sm: 1 })],
    };
    const rows = applyOverrides(smData.emp, {});
    const pool = computeScalesAndBonuses(rows, smData);
    // C's own fixed 400 is a given; the room is everything A and B draw
    expect(daHeadroom(rows.find((e) => e.id === "C")!, pool)).toBe(800);
    const impact = daImpact(smData.emp, smData, {}, { C: { daEdit: 100 } });
    expect(impact.grants).toHaveLength(1);
    expect(impact.grants[0].amount).toBeCloseTo(100, 6);
    // A and B fund it between them, dollar for dollar
    expect(impact.reducedCount).toBe(2);
    expect(impact.totalReduction).toBeCloseTo(100, 6);
  });

  it("is bounded by whichever pool runs out first for a split row", () => {
    const splitData: Dataset = {
      ...data,
      emp: [
        emp({ id: "A", vp: 0.5, np: 0.5, bipm: 400 }),
        emp({ id: "B", vp: 1, np: 0, bipm: 400 }),
        emp({ id: "C", vp: 0, np: 1, bipm: 400 }),
      ],
      vCap: 600,
      nCap: 6000,
    };
    const rows = applyOverrides(splitData.emp, {});
    const pool = computeScalesAndBonuses(rows, splitData);
    const headroom = daHeadroom(rows.find((e) => e.id === "A")!, pool);
    // the thin VIC side binds, not the roomy NSW one
    const at = applyOverrides(splitData.emp, { A: { daEdit: headroom } });
    computeScalesAndBonuses(at, splitData);
    expect(at.find((e) => e.id === "B")!.finalBonus).toBeCloseTo(0, 4);
    expect(at.find((e) => e.id === "C")!.finalBonus).toBeGreaterThan(0);
  });

  it("leaves both policy knobs unset, so neither changes the ceiling yet", () => {
    expect(DA_POLICY.approvalThreshold).toBeNull();
    expect(DA_POLICY.minBonusFloor).toBeNull();
  });
});

describe("clampDa", () => {
  it("passes an amount inside the ceiling through untouched", () => {
    expect(clampDa(500, 0, 800)).toEqual({ value: 500, clamped: false });
  });

  it("holds an amount above the ceiling at the ceiling", () => {
    expect(clampDa(2000, 0, 800)).toEqual({ value: 800, clamped: true });
  });

  it("floors to whole dollars so the held figure cannot exceed the ceiling", () => {
    expect(clampDa(2000, 0, 800.9)).toEqual({ value: 800, clamped: true });
  });

  it("never holds back a decrease, even with no room left", () => {
    expect(clampDa(100, 900, -50)).toEqual({ value: 100, clamped: false });
    expect(clampDa(-500, 0, 0)).toEqual({ value: -500, clamped: false });
  });

  it("holds at the stored amount rather than reducing it when there is no room", () => {
    expect(clampDa(1000, 900, -50)).toEqual({ value: 900, clamped: true });
  });

  it("tolerates sub-cent noise rather than reporting a clamp", () => {
    expect(clampDa(800.005, 0, 800)).toEqual({ value: 800.005, clamped: false });
  });

  it("leaves a row that draws from no pool unbounded", () => {
    expect(clampDa(9_999, 0, Infinity)).toEqual({ value: 9_999, clamped: false });
  });
});

describe("daGrants", () => {
  it("reports nothing for an unchanged document", () => {
    expect(daGrants(data.emp, data, {}, {})).toEqual([]);
    expect(daGrants(data.emp, data, { A: { daEdit: 300 } }, { A: { daEdit: 300 } })).toEqual([]);
  });

  it("names the row, the movement and the ceiling that applied", () => {
    const grants = daGrants(data.emp, data, {}, { A: { daEdit: 300 } });
    expect(grants).toEqual([
      { empId: "A", name: "Ann Alpha", from: 0, to: 300, amount: 300, headroom: 800 },
    ]);
  });

  it("measures the ceiling before the change, not after", () => {
    // from 300 to 500: the headroom recorded is the one that bounded the
    // decision, which is the pre-change figure
    const grants = daGrants(data.emp, data, { A: { daEdit: 300 } }, { A: { daEdit: 500 } });
    expect(grants[0].from).toBe(300);
    expect(grants[0].amount).toBe(200);
    expect(grants[0].headroom).toBe(daHeadroom(
      pooled({ A: { daEdit: 300 } }).rows.find((e) => e.id === "A")!,
      pooled({ A: { daEdit: 300 } }).pool
    ));
  });

  it("reports a reduction as a negative amount", () => {
    const grants = daGrants(data.emp, data, { A: { daEdit: 300 } }, { A: { daEdit: 100 } });
    expect(grants[0].amount).toBe(-200);
  });

  it("reports every changed row", () => {
    const grants = daGrants(data.emp, data, {}, { A: { daEdit: 100 }, B: { daEdit: 50 } });
    expect(grants.map((g) => g.empId).sort()).toEqual(["A", "B"]);
  });

  it("ignores sub-cent drift", () => {
    expect(daGrants(data.emp, data, { A: { daEdit: 300 } }, { A: { daEdit: 300.005 } })).toEqual([]);
  });
});

describe("daImpact", () => {
  it("counts who pays, how much on average, and the worst single hit", () => {
    // A is granted 300; B and C fund it between them, 150 each
    const impact = daImpact(data.emp, data, {}, { A: { daEdit: 300 } });
    expect(impact.granted).toBe(300);
    expect(impact.reducedCount).toBe(2);
    expect(impact.totalReduction).toBeCloseTo(300, 6);
    expect(impact.averageReduction).toBeCloseTo(150, 6);
    expect(impact.largestReduction).toBeCloseTo(150, 6);
  });

  it("excludes the recipient from the reduction figures", () => {
    const impact = daImpact(data.emp, data, {}, { A: { daEdit: 300 } });
    // three rows, one recipient, two payers — the recipient is not collateral
    expect(impact.reducedCount).toBe(2);
    expect(impact.grants).toHaveLength(1);
  });

  it("counts locked bonuses as unaffected and keeps them out of the reductions", () => {
    const impact = daImpact(
      data.emp,
      data,
      { C: { locked: true, lockedFinal: 400 } },
      { C: { locked: true, lockedFinal: 400 }, A: { daEdit: 300 } }
    );
    expect(impact.lockedUnaffected).toBe(1);
    // only B is left to fund it, so B alone takes the whole 300
    expect(impact.reducedCount).toBe(1);
    expect(impact.largestReduction).toBeCloseTo(300, 6);
  });

  it("reports a clean sheet for an unchanged document", () => {
    const impact = daImpact(data.emp, data, {}, {});
    expect(impact.grants).toEqual([]);
    expect(impact.granted).toBe(0);
    expect(impact.reducedCount).toBe(0);
    expect(impact.averageReduction).toBe(0);
    expect(impact.largestReduction).toBe(0);
  });

  it("reports nobody reduced when a grant is given back", () => {
    const impact = daImpact(data.emp, data, { A: { daEdit: 300 } }, { A: { daEdit: 0 } });
    expect(impact.granted).toBe(-300);
    expect(impact.reducedCount).toBe(0);
  });

  it("adds up across several grants in one save", () => {
    const impact = daImpact(data.emp, data, {}, { A: { daEdit: 100 }, B: { daEdit: 100 } });
    expect(impact.granted).toBe(200);
    // C is the only row left to fund both
    expect(impact.reducedCount).toBe(1);
    expect(impact.totalReduction).toBeCloseTo(200, 6);
  });
});
