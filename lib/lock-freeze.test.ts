/**
 * Pricing a grant that arrives in the same save as a lock.
 *
 * The freeze tests that used to live here are gone with the functions they
 * covered (freezeNewLocks, preserveUnlockPayouts): a lock no longer captures or
 * restores an amount, so there is nothing to assert about the figure it records.
 * The property that replaced them — toggling a lock moves no money at all — is
 * pinned in lib/calc.test.ts, next to the engine that guarantees it.
 *
 * Fixture: one VIC pool, cap 1500 against 1200 of demand, so the scale clamps
 * at 1 and every figure below is exact.
 */
import { describe, it, expect } from "vitest";
import type { Dataset, Employee, Overrides } from "./schema";
import { applyOverrides, computeScalesAndBonuses } from "./calc";
import { daHeadroom } from "./da-impact";
import { rowsForGrantJudgement } from "./lock-freeze";

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

describe("rowsForGrantJudgement", () => {
  /** The ceiling /api/state's headroom gate would hold `id` to. */
  function ceiling(next: Overrides, previous: Overrides, id = "A") {
    const rows = rowsForGrantJudgement(data, next, previous, id);
    return daHeadroom(rows.find((e) => e.id === id)!, rows, data);
  }

  it("grant and lock in one save keeps the row's real headroom", () => {
    // The regression: A is granted 300 and locked in the same click. Judged
    // with its own new lock applied, daHeadroom answers 0 — the pool has room,
    // but a locked row has nothing left to grant — and the save was refused
    // with "at most $0 can be granted". Releasing the new lock for the
    // measurement gives the figure the cap actually allows.
    const next: Overrides = { A: { daEdit: 300, locked: true } };
    expect(ceiling(next, {})).toBe(300);

    // what the gate saw before the fix, kept here so the two are visibly
    // different rather than taken on trust
    const asSaved = applyOverrides(data.emp, next);
    computeScalesAndBonuses(asSaved, data);
    expect(daHeadroom(asSaved.find((e) => e.id === "A")!, asSaved, data)).toBe(0);
  });

  it("accepts the grant the two-step dance used to be needed for", () => {
    // Unlock, save the grant, lock, save again — the workaround. One save now
    // reaches the same ceiling, so the same grant passes the gate.
    const twoStep = ceiling({ A: { daEdit: 300 } }, {});
    const oneSave = ceiling({ A: { daEdit: 300, locked: true } }, {});
    expect(oneSave).toBe(twoStep);
  });

  it("still refuses a top-up on a row locked in an earlier save", () => {
    // Not the same thing: that payout is a settled figure, and granting on top
    // of it would pay money the lock was supposed to have closed off.
    const previous: Overrides = { A: { locked: true, lockedFinal: 900 } };
    const next: Overrides = { A: { daEdit: 300, locked: true, lockedFinal: 900 } };
    expect(ceiling(next, previous)).toBe(0);
  });

  it("measures against other rows' frozen finals, not what they would earn", () => {
    // B is locked at 500 from an earlier save while the engine would pay it
    // 400 today. The pool holds the frozen 500, so A's room is 200, not 300.
    const previous: Overrides = { B: { locked: true, lockedFinal: 500 } };
    const next: Overrides = {
      A: { daEdit: 100, locked: true },
      B: { locked: true, lockedFinal: 500 },
    };
    expect(ceiling(next, previous)).toBe(200);
  });

  it("leaves an unlocked grant judged exactly as before", () => {
    const next: Overrides = { A: { daEdit: 300 } };
    const rows = rowsForGrantJudgement(data, next, {}, "A");
    const plain = applyOverrides(data.emp, next);
    computeScalesAndBonuses(plain, data);
    expect(rows.map((e) => e.finalBonus)).toEqual(plain.map((e) => e.finalBonus));
  });
});
