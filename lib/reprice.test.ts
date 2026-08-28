/**
 * An IPM edit re-prices that ONE row (27 Aug 2026), against the STORED Scale
 * Factor. A site manager's fixed bonus carries no scale and is re-priced
 * whether or not one is stored; everybody else moves only once there is an
 * authoritative scale to move them against.
 */
import { describe, it, expect } from "vitest";
import type { Employee, Overrides } from "./schema";
import { applyOverrides, computeScalesAndBonuses } from "./calc";
import { repriceOnIpm } from "./reprice";

function emp(over: Partial<Employee> & { id: string }): Employee {
  return {
    sn: "S", gn: over.id, pos: "P", dept: "D", mgr: "M", cat: "C",
    st: "VIC", vp: 1, np: 0, pkg: 2000, bp: 0.1, ipm: 1, bipm: 200, da: 0, f25: 0, sm: 0,
    ...over,
  };
}
// preIpm = bipm / ipm = 200 for every fixture row, so the fixed bonus is 200 × IPM
const S = emp({ id: "S", sm: 1 }); // VIC site manager
const N = emp({ id: "N", sm: 1, st: "NSW", vp: 0, np: 1 }); // NSW site manager
const A = emp({ id: "A" }); // pooled, not a site manager
const B = emp({ id: "B" }); // a second pooled row, to prove nobody else moves
const EMPS = [S, N, A, B];

/** No scale has ever been stored — the state the scheme ships in. */
const CAPS = { vCap: 10_000, nCap: 10_000, gCap: 20_000 };
/** After a Recalculate has pinned one. */
const PINNED = { ...CAPS, vicScale: 0.5, nswScale: 1 };

describe("repriceOnIpm — site managers (no scale involved)", () => {
  it("an IPM change on an unlocked site manager writes the new fixed bonus as the base", () => {
    const next: Overrides = { S: { ipmEdit: 0.8 } };
    const { overrides, changes } = repriceOnIpm(EMPS, {}, next, CAPS);
    expect(overrides.S).toEqual({ ipmEdit: 0.8, baseAmount: 160 });
    expect(changes).toEqual([
      { empId: "S", name: "S S", from: 200, to: 160, ipmFrom: 1, ipmTo: 0.8, fixedBonus: true },
    ]);
    // and that base is what the engine then pays, with any amount on top
    const rows = applyOverrides(EMPS, { ...overrides, S: { ...overrides.S, daEdit: 25 } });
    computeScalesAndBonuses(rows, CAPS);
    expect(rows.find((e) => e.id === "S")!.finalBonus).toBeCloseTo(185, 10);
  });

  it("reads the stored base as the 'from' figure", () => {
    const previous: Overrides = { S: { ipmEdit: 0.9, baseAmount: 180 } };
    const { changes } = repriceOnIpm(EMPS, previous, { S: { ipmEdit: 0.5, baseAmount: 180 } }, CAPS);
    expect(changes).toEqual([
      { empId: "S", name: "S S", from: 180, to: 100, ipmFrom: 0.9, ipmTo: 0.5, fixedBonus: true },
    ]);
  });

  it("an NSW site manager is re-priced the same way", () => {
    const { overrides, changes } = repriceOnIpm(EMPS, {}, { N: { ipmEdit: 0.5 } }, CAPS);
    expect(overrides.N?.baseAmount).toBe(100);
    expect(changes.map((c) => c.empId)).toEqual(["N"]);
  });

  it("a site manager's fixed bonus ignores the stored scale entirely", () => {
    const { overrides } = repriceOnIpm(EMPS, {}, { S: { ipmEdit: 0.8 } }, PINNED);
    // 200 × 0.8, NOT 200 × 0.8 × 0.5 — their bonus carries no scale
    expect(overrides.S?.baseAmount).toBe(160);
  });
});

describe("repriceOnIpm — the first-run guard", () => {
  it("with NO stored scale, a pooled row's IPM change re-prices nothing", () => {
    const previous: Overrides = { A: { baseAmount: 150 } };
    const next: Overrides = { A: { baseAmount: 150, ipmEdit: 0.2 } };
    const { overrides, changes } = repriceOnIpm(EMPS, previous, next, CAPS);
    expect(overrides).toEqual(next);
    expect(changes).toEqual([]);
  });

  it("the advisory derivation is never substituted for a stored scale", () => {
    // These caps make the derived scale clamp to 1, so a re-price off it would
    // be plainly visible as baseAmount 40. It must not happen.
    const { overrides } = repriceOnIpm(EMPS, {}, { A: { ipmEdit: 0.2 } }, CAPS);
    expect(overrides.A?.baseAmount).toBeUndefined();
  });

  it("a site manager is still re-priced when no scale is stored", () => {
    const { overrides } = repriceOnIpm(EMPS, {}, { S: { ipmEdit: 0.8 }, A: { ipmEdit: 0.2 } }, CAPS);
    expect(overrides.S?.baseAmount).toBe(160);
    expect(overrides.A?.baseAmount).toBeUndefined();
  });
});

describe("repriceOnIpm — pooled rows against a stored scale", () => {
  it("re-prices as Potential × stored Scale × new IPM", () => {
    const { overrides, changes } = repriceOnIpm(EMPS, {}, { A: { ipmEdit: 0.4 } }, PINNED);
    // 200 (potential) × 0.5 (stored VIC scale) × 0.4 (new IPM)
    expect(overrides.A?.baseAmount).toBeCloseTo(40, 10);
    expect(changes[0]).toMatchObject({ empId: "A", to: 40, fixedBonus: false });
  });

  it("uses the STORED scale, not one derived from the caps", () => {
    // The derived VIC scale for this population clamps to 1; the stored 0.5 is
    // what must be applied. At IPM 1 the two answers are 200 and 100.
    const { overrides } = repriceOnIpm(EMPS, { A: { ipmEdit: 0.5 } }, { A: { ipmEdit: 1 } }, PINNED);
    expect(overrides.A?.baseAmount).toBeCloseTo(100, 10);
  });

  it("MOVES ONLY THAT ROW — nobody else gets a base written", () => {
    const previous: Overrides = { A: { baseAmount: 100 }, B: { baseAmount: 100 } };
    const next: Overrides = { A: { baseAmount: 100, ipmEdit: 0.4 }, B: { baseAmount: 100 } };
    const { overrides, changes } = repriceOnIpm(EMPS, previous, next, PINNED);
    expect(changes.map((c) => c.empId)).toEqual(["A"]);
    expect(overrides.B).toEqual({ baseAmount: 100 });
  });

  it("an NSW row scales at the NSW factor", () => {
    const nswRow = emp({ id: "X", st: "NSW", vp: 0, np: 1 });
    const { overrides } = repriceOnIpm([nswRow], {}, { X: { ipmEdit: 0.5 } }, PINNED);
    // NSW is pinned at 1, so 200 × 1 × 0.5
    expect(overrides.X?.baseAmount).toBeCloseTo(100, 10);
  });

  it("splits a part-split row across both pools at their own scales", () => {
    const split = emp({ id: "P", vp: 0.6, np: 0.4 });
    const { overrides } = repriceOnIpm([split], {}, { P: { ipmEdit: 0.5 } }, PINNED);
    // 200 × 0.5 × (0.6 × 0.5 + 0.4 × 1)
    expect(overrides.P?.baseAmount).toBeCloseTo(70, 10);
  });
});

describe("repriceOnIpm — who is out of reach", () => {
  it("a LOCKED row is frozen: no re-price", () => {
    const next: Overrides = { S: { locked: true, ipmEdit: 0.5, baseAmount: 200 } };
    const { overrides, changes } = repriceOnIpm(EMPS, { S: { locked: true, baseAmount: 200 } }, next, PINNED);
    expect(overrides).toEqual(next);
    expect(changes).toEqual([]);
  });

  it("a locked POOLED row is frozen too", () => {
    const next: Overrides = { A: { locked: true, ipmEdit: 0.5, baseAmount: 200 } };
    const { overrides, changes } = repriceOnIpm(EMPS, { A: { locked: true, baseAmount: 200 } }, next, PINNED);
    expect(overrides).toEqual(next);
    expect(changes).toEqual([]);
  });

  it("an ISSUED row is never re-priced, whatever its IPM says", () => {
    const issued = { amount: 999, at: "2026-08-27T00:00:00.000Z", by: "a@b.c" };
    const previous: Overrides = { A: { locked: true, issued, baseAmount: 100 } };
    const next: Overrides = { A: { locked: true, issued, baseAmount: 100, ipmEdit: 0.1 } };
    const { overrides, changes } = repriceOnIpm(EMPS, previous, next, PINNED);
    expect(overrides).toEqual(next);
    expect(changes).toEqual([]);
  });

  it("an unlock and an IPM change in the same save does re-price", () => {
    const previous: Overrides = { S: { locked: true, baseAmount: 200 } };
    const next: Overrides = { S: { locked: false, ipmEdit: 0.5, baseAmount: 200 } };
    const { overrides, changes } = repriceOnIpm(EMPS, previous, next, PINNED);
    expect(overrides.S?.baseAmount).toBe(100);
    expect(changes[0]).toMatchObject({ from: 200, to: 100 });
  });

  it("does nothing when the IPM did not move — an amount or a lock alone is not a re-price", () => {
    const previous: Overrides = { S: { ipmEdit: 0.8, baseAmount: 160 } };
    const next: Overrides = { S: { ipmEdit: 0.8, baseAmount: 160, daEdit: 40, locked: true } };
    const { overrides, changes } = repriceOnIpm(EMPS, previous, next, PINNED);
    expect(overrides).toEqual(next);
    expect(changes).toEqual([]);
  });

  it("a row drawing from no pool is not re-priced", () => {
    const none = emp({ id: "Z", vp: 0, np: 0 });
    const { overrides, changes } = repriceOnIpm([none], {}, { Z: { ipmEdit: 0.5 } }, PINNED);
    expect(overrides.Z?.baseAmount).toBeUndefined();
    expect(changes).toEqual([]);
  });
});


/**
 * LOCKING IN THE SAME SAVE AS THE EDIT. A lock freezes the figure the person is
 * looking at, so the re-price has to run before the freeze — it did not until
 * 28 August 2026, which is how a locked row ended up paid at an IPM it no
 * longer had while its Calc bonus showed the right one.
 */
describe("repriceOnIpm — a lock arriving with the edit", () => {
  const issued = { amount: 999, at: "2026-08-28T00:00:00.000Z", by: "a@b.c" };

  it("RE-PRICES, THEN FREEZES: unlocked -> locked in one save takes the new figure", () => {
    // A was unlocked; this save carries both the new IPM and the lock
    const previous: Overrides = { A: { locked: false, baseAmount: 200 } };
    const next: Overrides = { A: { locked: true, ipmEdit: 0.4, baseAmount: 200 } };
    const { overrides, changes } = repriceOnIpm(EMPS, previous, next, PINNED);
    // 200 potential × 0.5 stored scale × 0.4 new IPM
    expect(overrides.A?.baseAmount).toBeCloseTo(40, 10);
    expect(overrides.A?.locked).toBe(true); // and it is frozen at that figure
    expect(changes[0]).toMatchObject({ empId: "A", to: 40 });
  });

  it("the same for a row with no stored lock at all before the save", () => {
    const { overrides } = repriceOnIpm(
      EMPS, {}, { A: { locked: true, ipmEdit: 0.4 } }, PINNED
    );
    expect(overrides.A?.baseAmount).toBeCloseTo(40, 10);
  });

  it("A ROW LOCKED BEFORE AND AFTER IS STILL FROZEN — the freeze still works", () => {
    const previous: Overrides = { A: { locked: true, baseAmount: 200 } };
    const next: Overrides = { A: { locked: true, ipmEdit: 0.4, baseAmount: 200 } };
    const { overrides, changes } = repriceOnIpm(EMPS, previous, next, PINNED);
    expect(overrides.A?.baseAmount).toBe(200);
    expect(changes).toEqual([]);
  });

  it("an ISSUED row is never re-priced, whatever the lock does", () => {
    for (const lock of [true, false]) {
      const previous: Overrides = { A: { locked: !lock, issued, baseAmount: 200 } };
      const next: Overrides = { A: { locked: lock, issued, ipmEdit: 0.4, baseAmount: 200 } };
      expect(repriceOnIpm(EMPS, previous, next, PINNED).changes).toEqual([]);
    }
  });

  it("a site manager locked in the same save is re-priced too", () => {
    const { overrides } = repriceOnIpm(
      EMPS, { S: { locked: false } }, { S: { locked: true, ipmEdit: 0.8 } }, CAPS
    );
    expect(overrides.S?.baseAmount).toBe(160); // 200 × 0.8, no scale
  });

  it("Michael Franklin's case, to the cent", () => {
    // Potential 38,500 at a pinned scale of 0.703. His IPM went 100% -> 90% in
    // the same save as the lock, and he was left paid the 100% figure.
    const MF = emp({ id: "MF", pkg: 385_000, bp: 0.1, ipm: 1, bipm: 38_500 });
    const caps = { vCap: 10_000_000, nCap: 10_000_000, gCap: 20_000_000, vicScale: 0.703, nswScale: 1 };
    const { overrides } = repriceOnIpm(
      [MF],
      { MF: { locked: false, baseAmount: 27_065.5 } },
      { MF: { locked: true, ipmEdit: 0.9, baseAmount: 27_065.5 } },
      caps
    );
    expect(overrides.MF?.baseAmount).toBeCloseTo(24_358.95, 2);
    expect(overrides.MF?.baseAmount).not.toBeCloseTo(27_065.5, 2);
  });
});
