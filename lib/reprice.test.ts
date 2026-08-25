/**
 * A site manager's IPM re-prices their fixed bonus (26 Aug 2026). Everyone
 * else's payout stays the stored figure whatever their IPM does.
 */
import { describe, it, expect } from "vitest";
import type { Employee, Overrides } from "./schema";
import { applyOverrides, computeScalesAndBonuses } from "./calc";
import { repriceSiteManagers } from "./reprice";

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
const EMPS = [S, N, A];
const CAPS = { vCap: 10_000, nCap: 10_000, gCap: 20_000 };

describe("repriceSiteManagers", () => {
  it("an IPM change on an unlocked site manager writes the new fixed bonus as the base", () => {
    const next: Overrides = { S: { ipmEdit: 0.8 } };
    const { overrides, changes } = repriceSiteManagers(EMPS, {}, next);
    expect(overrides.S).toEqual({ ipmEdit: 0.8, baseAmount: 160 });
    expect(changes).toEqual([
      { empId: "S", name: "S S", from: 200, to: 160, ipmFrom: 1, ipmTo: 0.8 },
    ]);
    // and that base is what the engine then pays, with any amount on top
    const rows = applyOverrides(EMPS, { ...overrides, S: { ...overrides.S, daEdit: 25 } });
    computeScalesAndBonuses(rows, CAPS);
    expect(rows.find((e) => e.id === "S")!.finalBonus).toBeCloseTo(185, 10);
  });

  it("reads the stored base as the 'from' figure", () => {
    const previous: Overrides = { S: { ipmEdit: 0.9, baseAmount: 180 } };
    const { changes } = repriceSiteManagers(EMPS, previous, { S: { ipmEdit: 0.5, baseAmount: 180 } });
    expect(changes).toEqual([{ empId: "S", name: "S S", from: 180, to: 100, ipmFrom: 0.9, ipmTo: 0.5 }]);
  });

  it("an NSW site manager is re-priced the same way", () => {
    const { overrides, changes } = repriceSiteManagers(EMPS, {}, { N: { ipmEdit: 0.5 } });
    expect(overrides.N?.baseAmount).toBe(100);
    expect(changes.map((c) => c.empId)).toEqual(["N"]);
  });

  it("a LOCKED site manager is frozen: no re-price", () => {
    const next: Overrides = { S: { locked: true, ipmEdit: 0.5, baseAmount: 200 } };
    const { overrides, changes } = repriceSiteManagers(EMPS, { S: { locked: true, baseAmount: 200 } }, next);
    expect(overrides).toEqual(next);
    expect(changes).toEqual([]);
  });

  it("an unlock and an IPM change in the same save does re-price", () => {
    const previous: Overrides = { S: { locked: true, baseAmount: 200 } };
    const next: Overrides = { S: { locked: false, ipmEdit: 0.5, baseAmount: 200 } };
    const { overrides, changes } = repriceSiteManagers(EMPS, previous, next);
    expect(overrides.S?.baseAmount).toBe(100);
    expect(changes[0]).toMatchObject({ from: 200, to: 100 });
  });

  it("never re-prices a pooled non-site-manager, whose payout is the stored figure", () => {
    const previous: Overrides = { A: { baseAmount: 150 } };
    const next: Overrides = { A: { baseAmount: 150, ipmEdit: 0.2 } };
    const { overrides, changes } = repriceSiteManagers(EMPS, previous, next);
    expect(overrides).toEqual(next);
    expect(changes).toEqual([]);
  });

  it("does nothing when the IPM did not move — an amount or a lock alone is not a re-price", () => {
    const previous: Overrides = { S: { ipmEdit: 0.8, baseAmount: 160 } };
    const next: Overrides = { S: { ipmEdit: 0.8, baseAmount: 160, daEdit: 40, locked: true } };
    const { overrides, changes } = repriceSiteManagers(EMPS, previous, next);
    expect(overrides).toEqual(next);
    expect(changes).toEqual([]);
  });
});
