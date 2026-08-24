/**
 * The frozen figure a lock records.
 *
 * The regression these pin: a lead's lock froze the figure their last what-if
 * returned, and that preview is debounced — so a lock clicked while a
 * discretionary amount was still in flight froze the total from before it, and
 * the row paid the stale figure for good. The server now computes the figure
 * itself; the client's number is ignored for any lock that is new in the save.
 *
 * Fixture: one VIC pool, cap 1500 against 1200 of demand, so the scale clamps
 * at 1 and every figure below is exact.
 */
import { describe, it, expect } from "vitest";
import type { Dataset, Employee, Overrides } from "./schema";
import { applyOverrides, computeScalesAndBonuses } from "./calc";
import { freezeNewLocks } from "./lock-freeze";

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

const data: Dataset = {
  emp: [emp({ id: "A" }), emp({ id: "B" }), emp({ id: "C" })],
  vCap: 1500,
  nCap: 1000,
  gCap: 5000,
  cats: ["Employee"],
  depts: ["Dept"],
  mgrs: ["Mgr"],
  excludedIds: [],
};

/** What the engine actually pays A for a given document — the figure to expect. */
function paid(doc: Overrides, id = "A") {
  const emps = applyOverrides(data.emp, doc);
  computeScalesAndBonuses(emps, data);
  return emps.find((e) => e.id === id)!.finalBonus;
}

describe("freezeNewLocks", () => {
  it("freezes a new lock at the payout, discretionary amount included", () => {
    const next: Overrides = { A: { daEdit: 500, locked: true } };
    expect(freezeNewLocks(data, next, {})).toEqual(["A"]);
    // 400 of scaled bonus plus the 500 granted
    expect(next.A.lockedFinal).toBeCloseTo(900, 8);
    expect(next.A.lockedFinal).toBeCloseTo(paid({ A: { daEdit: 500 } }), 8);
  });

  it("overwrites a stale figure the client sent — the actual regression", () => {
    // What a lead's browser sends when the lock beats the debounced preview:
    // locked with the pre-grant total, while the grant is in the same document.
    const next: Overrides = { A: { daEdit: 500, locked: true, lockedFinal: 400 } };
    freezeNewLocks(data, next, {});
    expect(next.A.lockedFinal).toBeCloseTo(900, 8);
  });

  it("computes one that is missing entirely, rather than paying $0", () => {
    // applyOverrides reads `locked ? lockedFinal ?? 0 : 0`, so an absent figure
    // is a $0 payout — the whole bonus gone, not just the grant.
    const next: Overrides = { A: { daEdit: 500, locked: true } };
    freezeNewLocks(data, next, {});
    expect(next.A.lockedFinal).not.toBe(0);
    expect(paid(next)).toBeCloseTo(900, 8);
  });

  it("leaves a row locked in an earlier save exactly as stored", () => {
    // A historical record: 300 is not what the engine would pay today, and that
    // is the point — recomputing it would silently repay the row.
    const previous: Overrides = { A: { locked: true, lockedFinal: 300 } };
    const next: Overrides = { A: { locked: true, lockedFinal: 300 } };
    expect(freezeNewLocks(data, next, previous)).toEqual([]);
    expect(next.A.lockedFinal).toBe(300);
  });

  it("re-freezes a row that was unlocked and locked again", () => {
    // `previous` has it unlocked, so this lock is new and gets today's figure
    const previous: Overrides = { A: { locked: false } };
    const next: Overrides = { A: { daEdit: 500, locked: true, lockedFinal: 1 } };
    expect(freezeNewLocks(data, next, previous)).toEqual(["A"]);
    expect(next.A.lockedFinal).toBeCloseTo(900, 8);
  });

  it("ignores unlocked rows, whatever they carry", () => {
    const next: Overrides = { A: { daEdit: 500 }, B: { lockedFinal: 123 } };
    expect(freezeNewLocks(data, next, {})).toEqual([]);
    expect(next.A.lockedFinal).toBeUndefined();
    expect(next.B.lockedFinal).toBe(123);
  });

  it("prices each new lock against the document being saved, not one at a time", () => {
    // B and C locked in the same save: each is frozen with the OTHER's lock
    // applied, which is what the pool will actually look like afterwards.
    const next: Overrides = {
      B: { locked: true },
      C: { locked: true },
    };
    expect(freezeNewLocks(data, next, {}).sort()).toEqual(["B", "C"]);
    expect(next.B.lockedFinal).toBeCloseTo(400, 8);
    expect(next.C.lockedFinal).toBeCloseTo(400, 8);
  });

  it("skips an id that is not in the roster", () => {
    const next: Overrides = { GHOST: { locked: true } };
    expect(freezeNewLocks(data, next, {})).toEqual([]);
    expect(next.GHOST.lockedFinal).toBeUndefined();
  });
});
