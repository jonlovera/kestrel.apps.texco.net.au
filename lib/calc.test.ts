import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Employee, Overrides } from "./schema";
import {
  applyOverrides,
  computeScalesAndBonuses,
  getVicAlloc,
  getNswAlloc,
  getMaxDA,
  deriveCpm,
  isDaEditable,
  rowRule,
  isLockable,
  parsePercentInput,
  parseDaInput,
  type Caps,
  type CalcEmployee,
  type PoolState,
} from "./calc";

/**
 * Hand-computable fixture:
 *   VIC pool: A (bipm 200), B (bipm 600) unlocked; C site manager fixed at 200
 *   NSW pool: D (bipm 500) unlocked
 *   SHARED:   E (bipm 200, 60/40 split) unlocked
 *   F: no pool exposure (vp = np = 0)
 * Baseline: vicScale = (1000-200)/920, nswScale = 500/580 — both pools
 * genuinely oversubscribed (demand > cap), so scale stays below 1 and these
 * bipm figures are deliberately chosen well above the old (100/300/250/100)
 * ones: since FY26's methodology caps scale at 1 (see clampScale in
 * lib/calc.ts), a fixture with scale > 1 would now just clamp to 1 and stop
 * exercising DA redistribution/locking at all.
 */
const CAPS: Caps = { vCap: 1000, nCap: 500, gCap: 1500 };

function makeEmp(over: Partial<Employee> & { id: string }): Employee {
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
    pkg: 1000,
    bp: 0.1,
    ipm: 1,
    bipm: 100,
    da: 0,
    f25: 0,
    sm: 0,
    ...over,
  };
}

const FIXTURE: Employee[] = [
  makeEmp({ id: "A", bipm: 200, pkg: 2000 }),
  makeEmp({ id: "B", bipm: 600, pkg: 6000 }),
  makeEmp({ id: "C", bipm: 200, pkg: 2000, sm: 1 }),
  makeEmp({ id: "D", st: "NSW", vp: 0, np: 1, bipm: 500, pkg: 5000 }),
  makeEmp({ id: "E", st: "SHARED", vp: 0.6, np: 0.4, bipm: 200, pkg: 2000 }),
  makeEmp({ id: "F", vp: 0, np: 0, bipm: 50, pkg: 500 }),
];

function run(overrides: Overrides = {}) {
  const emps = applyOverrides(FIXTURE, overrides);
  const pool = computeScalesAndBonuses(emps, CAPS);
  const byId = Object.fromEntries(emps.map((e) => [e.id, e]));
  return { emps, pool, byId };
}

function totalVicAlloc(emps: CalcEmployee[], pool: PoolState) {
  return emps.reduce((s, e) => s + getVicAlloc(e, pool), 0);
}
function totalNswAlloc(emps: CalcEmployee[], pool: PoolState) {
  return emps.reduce((s, e) => s + getNswAlloc(e, pool), 0);
}

describe("baseline (no edits, no locks)", () => {
  it("computes the expected scales", () => {
    const { pool } = run();
    expect(pool.vicScale).toBeCloseTo(800 / 920, 10);
    expect(pool.nswScale).toBeCloseTo(500 / 580, 10);
    expect(pool.stateVicAvail).toBe(1000);
    expect(pool.stateNswAvail).toBe(500);
  });

  it("allocations exactly fill both pool caps", () => {
    const { emps, pool } = run();
    expect(totalVicAlloc(emps, pool)).toBeCloseTo(1000, 8);
    expect(totalNswAlloc(emps, pool)).toBeCloseTo(500, 8);
  });

  it("site manager bonus is fixed at bipm, no scaling", () => {
    const { byId } = run();
    expect(byId.C.finalBonus).toBeCloseTo(200, 10);
    expect(byId.C.calcBonus).toBeCloseTo(200, 10);
  });

  it("split-state employee draws from both pools at their weights", () => {
    const { byId, pool } = run();
    expect(byId.E.finalBonus).toBeCloseTo(
      200 * 0.6 * pool.vicScale + 200 * 0.4 * pool.nswScale,
      10
    );
  });

  it("zero-weight employee gets only their DA (here 0)", () => {
    const { byId } = run();
    expect(byId.F.finalBonus).toBe(0);
  });

  it("an under-subscribed pool caps its scale at 1 and leaves the rest unpaid (FY26 methodology)", () => {
    // Everyone's demand comfortably fits inside a much bigger cap: the old
    // behaviour would have scaled B/A/E up above 100% to spend the lot;
    // now the scale clamps at exactly 1 and money is left on the table.
    const bigCaps: Caps = { vCap: 100_000, nCap: 100_000, gCap: 200_000 };
    const emps = applyOverrides(FIXTURE, {});
    const pool = computeScalesAndBonuses(emps, bigCaps);
    expect(pool.vicScale).toBe(1);
    expect(pool.nswScale).toBe(1);
    expect(totalVicAlloc(emps, pool)).toBeLessThan(bigCaps.vCap);
    expect(totalNswAlloc(emps, pool)).toBeLessThan(bigCaps.nCap);
    // nobody is paid above their own theoretical (unscaled) entitlement
    expect(emps.find((e) => e.id === "A")!.finalBonus).toBeCloseTo(200, 10);
    expect(emps.find((e) => e.id === "B")!.finalBonus).toBeCloseTo(600, 10);
  });
});

describe("discretionary adjustments are pool funded but recipient stable (owner decision, 24 Aug 2026)", () => {
  it("Calc bonus + Discretionary = Final, exactly, and the recipient's calc does not move", () => {
    const base = run();
    const adj = run({ A: { daEdit: 100 } });

    // the recipient is priced at the base scale, which never moves
    expect(adj.pool.vicScaleBase).toBeCloseTo(base.pool.vicScaleBase, 12);
    expect(adj.byId.A.calcBonus).toBeCloseTo(base.byId.A.calcBonus, 12);
    // the identity the dashboard promises: typing 100 gives exactly 100 more
    expect(adj.byId.A.finalBonus).toBeCloseTo(adj.byId.A.calcBonus + 100, 12);
    // the DA came out of the pool: the remaining rows' scale dropped
    expect(adj.pool.vicScale).toBeLessThan(base.pool.vicScale);
    // and the pool allocation still fills the cap exactly, DA included
    expect(totalVicAlloc(adj.emps, adj.pool)).toBeCloseTo(1000, 8);
  });

  it("everyone else funds the DA pro-rata, by exactly the DA amount", () => {
    const base = run();
    const adj = run({ A: { daEdit: 100 } });
    // the other unlocked VIC-exposed rows shrink...
    expect(adj.byId.B.finalBonus).toBeLessThan(base.byId.B.finalBonus);
    expect(adj.byId.E.finalBonus).toBeLessThan(base.byId.E.finalBonus);
    // ...their combined shortfall is exactly the 100 typed...
    const othersDelta = adj.emps
      .filter((e) => e.id !== "A")
      .reduce((s, e) => s + e.finalBonus, 0);
    const othersBase = base.emps
      .filter((e) => e.id !== "A")
      .reduce((s, e) => s + e.finalBonus, 0);
    expect(othersBase - othersDelta).toBeCloseTo(100, 8);
    // ...while the fixed site manager and the other state are untouched
    expect(adj.byId.C.finalBonus).toBeCloseTo(base.byId.C.finalBonus, 12);
    expect(adj.byId.D.finalBonus).toBeCloseTo(base.byId.D.finalBonus, 12);
    expect(adj.pool.nswScale).toBeCloseTo(base.pool.nswScale, 12);
  });

  it("a negative DA reduces the final below the calc and frees money to the others", () => {
    const base = run();
    const adj = run({ A: { daEdit: -50 } });
    expect(adj.byId.A.finalBonus).toBeCloseTo(base.byId.A.calcBonus - 50, 12);
    expect(adj.pool.vicScale).toBeGreaterThan(base.pool.vicScale);
    expect(adj.byId.B.finalBonus).toBeGreaterThan(base.byId.B.finalBonus);
    // the cap is still exactly filled
    expect(totalVicAlloc(adj.emps, adj.pool)).toBeCloseTo(1000, 8);
  });

  it("total payout no longer moves with DA while the pool stays oversubscribed", () => {
    const base = run();
    // both DAs land in VIC, which stays oversubscribed either way (a negative
    // DA in a pool at the scale ceiling would legitimately underspend it)
    const adj = run({ A: { daEdit: 100 }, B: { daEdit: -40 } });
    const totalBase = base.emps.reduce((s, e) => s + e.finalBonus, 0);
    const totalAdj = adj.emps.reduce((s, e) => s + e.finalBonus, 0);
    // both DAs are absorbed inside the capped pool, so the group total is
    // unchanged (the old on-top model drifted by the net DA here)
    expect(totalAdj).toBeCloseTo(totalBase, 8);
    expect(totalVicAlloc(adj.emps, adj.pool)).toBeCloseTo(1000, 8);
    expect(totalNswAlloc(adj.emps, adj.pool)).toBeCloseTo(500, 8);
  });

  it("a second DA leaves the first recipient's figures exactly where they were", () => {
    const one = run({ A: { daEdit: 100 } });
    const two = run({ A: { daEdit: 100 }, E: { daEdit: 30 } });
    expect(two.byId.A.calcBonus).toBeCloseTo(one.byId.A.calcBonus, 12);
    expect(two.byId.A.finalBonus).toBeCloseTo(one.byId.A.finalBonus, 12);
    expect(two.byId.E.finalBonus).toBeCloseTo(two.byId.E.calcBonus + 30, 12);
    // only the non-DA rows fund it
    expect(two.byId.B.finalBonus).toBeLessThan(one.byId.B.finalBonus);
  });

  it("a zero-weight employee's final is exactly their DA and no pool funds it", () => {
    const base = run();
    const adj = run({ F: { daEdit: 500 } });
    expect(adj.byId.F.calcBonus).toBe(0);
    expect(adj.byId.F.finalBonus).toBe(500);
    // F draws from no pool, so nobody else moves (F's DA sits outside both
    // pools; /api/state refuses storing DA on such rows anyway)
    expect(adj.pool.vicScale).toBeCloseTo(base.pool.vicScale, 12);
    expect(adj.pool.nswScale).toBeCloseTo(base.pool.nswScale, 12);
  });

  it("with all DA at zero the two scales are the same value, bit for bit", () => {
    const { pool } = run();
    expect(pool.vicScale).toBe(pool.vicScaleBase);
    expect(pool.nswScale).toBe(pool.nswScaleBase);
  });
});

/**
 * The acceptance case the business owner stated, in their own numbers:
 * 5,429 typed against a 24,571 calc bonus is $30,000, and it is still
 * $30,000 after someone else's discretionary amount lands. The 24 August
 * 2026 pool-funded reform preserves this exactly through recipient
 * stability: a DA row is priced at the base scale, which its own DA and
 * other people's DAs never move.
 *
 * Its own fixture, because the figures have to be exact rather than close:
 * bp = 1 makes cpm exactly 1 (deriveCpm), and a cap far above demand clamps
 * the scale to exactly 1, so calcBonus IS 24,571 with no float slack for the
 * assertions to hide behind.
 */
describe("the stated discretionary case: 24,571 + 5,429 = 30,000", () => {
  const EXACT: Employee[] = [
    makeEmp({ id: "P", pkg: 24_571, bp: 1, ipm: 1, bipm: 24_571 }),
    makeEmp({ id: "Q", pkg: 40_000, bp: 1, ipm: 1, bipm: 40_000 }),
  ];
  const ROOMY: Caps = { vCap: 500_000, nCap: 500_000, gCap: 1_000_000 };

  function exact(overrides: Overrides = {}) {
    const emps = applyOverrides(EXACT, overrides);
    const pool = computeScalesAndBonuses(emps, ROOMY);
    return { pool, byId: Object.fromEntries(emps.map((e) => [e.id, e])) };
  }

  it("the calc bonus is exactly 24,571 before any adjustment", () => {
    const { pool, byId } = exact();
    expect(pool.vicScale).toBe(1);
    expect(byId.P.calcBonus).toBe(24_571);
    expect(byId.P.finalBonus).toBe(24_571);
  });

  it("typing 5,429 produces exactly 30,000", () => {
    const { byId } = exact({ P: { daEdit: 5_429 } });
    expect(byId.P.finalBonus).toBe(30_000);
    // the calc bonus underneath it has not been touched to make room
    expect(byId.P.calcBonus).toBe(24_571);
  });

  it("and it stays at exactly 30,000 when another adjustment lands later", () => {
    const before = exact({ P: { daEdit: 5_429 } });
    const after = exact({ P: { daEdit: 5_429 }, Q: { daEdit: 12_000 } });

    expect(after.byId.P.finalBonus).toBe(30_000);
    expect(after.byId.P.calcBonus).toBe(before.byId.P.calcBonus);
    // DA rows are priced at the base scale, and the pool is roomy enough
    // that the remaining rows' scale stays clamped at 1 as well
    expect(after.pool.vicScale).toBe(before.pool.vicScale);
    expect(after.pool.nswScale).toBe(before.pool.nswScale);
    // Q got theirs on top too, without borrowing from P
    expect(after.byId.Q.finalBonus).toBe(52_000);
  });

  it("a negative adjustment elsewhere still leaves the 30,000 alone", () => {
    const { byId } = exact({ P: { daEdit: 5_429 }, Q: { daEdit: -7_500 } });
    expect(byId.P.finalBonus).toBe(30_000);
    expect(byId.Q.finalBonus).toBe(32_500);
  });
});

describe("locked positions are excluded from re-proration", () => {
  // Lock B at its baseline final (521.739…) as the prototype's lock button does.
  // B is pure-VIC (vp=1, np=0), so its raw-vp/np split and the FY26
  // no-locks-scale-weighted split agree exactly here — the two only diverge
  // for a *blended* locked employee (see the "blended locked employee" tests
  // further down).
  const bFinal = 600 * (800 / 920);

  it("a locked employee's final is frozen while others re-prorate", () => {
    const adj = run({
      B: { locked: true, lockedFinal: bFinal },
      A: { daEdit: 100 },
    });
    expect(adj.byId.B.finalBonus).toBeCloseTo(bFinal, 10);
    // locked B moves into the locked aggregate: the base scale spans the
    // remaining 320 bipm (A + E's VIC share)...
    const base = (1000 - 200 - bFinal) / 320;
    expect(adj.pool.vicScaleBase).toBeCloseTo(base, 10);
    // ...A's whole draw (base-scaled bonus plus DA) then comes off the top,
    // leaving E's VIC share (120 bipm) to absorb the rest
    expect(adj.pool.vicScale).toBeCloseTo(
      (1000 - 200 - bFinal - (200 * base + 100)) / 120,
      10
    );
    expect(adj.byId.A.finalBonus).toBeCloseTo(200 * base + 100, 10);
    expect(totalVicAlloc(adj.emps, adj.pool)).toBeCloseTo(1000, 8);
  });

  it("locked row still shows a live calcBonus but keeps frozen finalBonus", () => {
    // Locked at a figure deliberately different from B's natural share, so
    // the live calc and the frozen final must disagree. (Locking B at exactly
    // its baseline share would leave the remaining scale unchanged and the
    // two would coincide — DA no longer moves the scale to break that tie.)
    const adj = run({ B: { locked: true, lockedFinal: 400 } });
    expect(adj.byId.B.finalBonus).toBe(400);
    expect(adj.byId.B.calcBonus).not.toBeCloseTo(400, 4);
  });

  it("unlocking releases the bonus back into the pool", () => {
    const relocked = run({ A: { daEdit: 100 } }); // as if B was unlocked again
    expect(relocked.pool.vicScaleBase).toBeCloseTo(800 / 920, 10);
  });

  it("a DA left on a row that is then locked is inert: the frozen final already holds it", () => {
    // B locked at a frozen figure that (say) included a DA at lock time,
    // with the stale daEdit still stored in the override: the locked branch
    // deducts the frozen final once and the DA accumulators must ignore it.
    const adj = run({ B: { locked: true, lockedFinal: 500, daEdit: 100 } });
    expect(adj.pool.poolAgg.daDrawVp).toBe(0);
    expect(adj.byId.B.finalBonus).toBe(500);
    // scale derives from the frozen 500 alone, over A + E's VIC share
    expect(adj.pool.vicScale).toBeCloseTo((1000 - 200 - 500) / 320, 10);
  });
});

describe("all-but-one locked", () => {
  const bFinal = 600 * (800 / 920);
  const eFinal = 200 * 0.6 * (800 / 920) + 200 * 0.4 * (500 / 580);
  const locks: Overrides = {
    B: { locked: true, lockedFinal: bFinal },
    E: { locked: true, lockedFinal: eFinal },
  };

  it("the sole unlocked employee's DA rides on top of their base-scaled share", () => {
    const adj = run({ ...locks, A: { daEdit: 100 } });
    // E is blended (vp 0.6/np 0.4) and locked: its contribution to VIC's pool
    // deduction is split via the no-locks-weighted method (FY26 fix), not raw
    // vp — so this isn't simply `eFinal * 0.6` any more. Assert against the
    // actual pool-math split via poolAgg.empLockedVp instead of re-deriving
    // it by hand, since that's exactly the quantity under test. A is the only
    // unlocked row and carries the DA, so it is priced at the BASE scale;
    // with no unlocked non-DA rows left, vicScale itself defaults to 1.
    expect(adj.pool.vicScaleBase).toBeCloseTo(
      (1000 - adj.pool.poolAgg.empLockedVp) / 200,
      8
    );
    expect(adj.byId.A.finalBonus).toBeCloseTo(
      200 * adj.pool.vicScaleBase + 100,
      8
    );
    // Note: totalVicAlloc (getVicAlloc's raw-vp/np reporting split) no longer
    // exactly equals the cap here — E's *reported* VIC allocation and its
    // *pool-consumption* VIC attribution are legitimately different figures
    // once E is a blended, locked employee (this mirrors the real FY26
    // workbook, whose own "VIC Allocation" and "Locked → VIC" columns
    // disagree for exactly this kind of row). See the dedicated
    // "blended locked employee" tests below for that distinction.
  });
});

describe("a blended (split-state) locked employee splits by the no-locks scale, not raw vp/np", () => {
  // FY26 methodology fix: confirmed against the real workbook (146/146
  // employees reconciled exactly) that a locked employee's contribution to
  // each state's pool deduction is weighted by a preliminary "no locks"
  // scale (site managers excluded, nobody else), not their raw vp/np split.
  // E is blended (0.6/0.4) — with VIC oversubscribed (scale < 1) and NSW
  // comfortably funded (scale = 1 once big enough), the two methods produce
  // visibly different splits for the same locked amount.
  it("differs from the raw vp/np split when the two states' pressure differs", () => {
    const bigNCap: Caps = { vCap: 1000, nCap: 100_000, gCap: 101_000 };
    const eFinal = 500; // an arbitrary frozen figure for this scenario
    const pool = computeScalesAndBonuses(
      applyOverrides(FIXTURE, { E: { locked: true, lockedFinal: eFinal } }),
      bigNCap
    );
    // FIXTURE's site manager (C, pure VIC) also feeds empLockedVp at its raw
    // 200 — isolate E's own contribution before comparing.
    const eVicShare = pool.poolAgg.empLockedVp - 200;
    // no-locks scale: VIC is oversubscribed (< 1), NSW is not (clamps to 1) —
    // so E's frozen amount should be weighted less toward VIC than a raw
    // 60/40 split would give it.
    const rawVicShare = eFinal * 0.6;
    expect(eVicShare).not.toBeCloseTo(rawVicShare, 0);
    expect(eVicShare).toBeLessThan(rawVicShare);
  });

  it("still splits by raw vp/np when both states put equal pressure on it", () => {
    // With vicScaleNoLocks == nswScaleNoLocks, the weighted split degenerates
    // back to raw vp/np. VIC's no-locks scale is (1000-200)/920 (C, the site
    // manager, is VIC-only); to give NSW the identical ratio with no
    // site-manager deduction of its own, its demand needs to be
    // 1000 * 920/800 = 1150 (D=1070 + E's NSW share of 80).
    const equalCaps: Caps = { vCap: 1000, nCap: 1000, gCap: 2000 };
    const symmetricFixture = FIXTURE.map((e) =>
      e.id === "D" ? { ...e, bipm: 1070 } : e
    );
    const eFinal = 500;
    const pool = computeScalesAndBonuses(
      applyOverrides(symmetricFixture, { E: { locked: true, lockedFinal: eFinal } }),
      equalCaps
    );
    const eVicShare = pool.poolAgg.empLockedVp - 200; // minus C, the site manager
    expect(eVicShare).toBeCloseTo(eFinal * 0.6, 6);
    expect(pool.poolAgg.empLockedNp).toBeCloseTo(eFinal * 0.4, 6); // C has np=0
  });
});

describe("a stored over-cap adjustment floors the others' scale at 0", () => {
  // The engine never clamps a stored DA (the UI's getMaxDA clamp is what
  // prevents typing one): a persisted figure bigger than the pool can absorb
  // simply drives the remaining rows to zero and the overshoot is surfaced
  // on the pool cards rather than silently trimmed.
  it("the others are zeroed, the recipient keeps base share + DA, the overshoot is visible", () => {
    const base = run();
    const adj = run({ A: { daEdit: 10000 } });
    expect(adj.pool.vicScale).toBe(0);
    expect(adj.byId.B.finalBonus).toBe(0);
    // the recipient is still priced at the (unmoved) base scale
    expect(adj.pool.vicScaleBase).toBeCloseTo(base.pool.vicScaleBase, 12);
    expect(adj.byId.A.finalBonus).toBeCloseTo(base.byId.A.calcBonus + 10000, 10);
    // the reported pool draw exceeds the cap by exactly what could not be
    // absorbed: A's whole draw plus the site manager, minus everyone else's 0
    const over = totalVicAlloc(adj.emps, adj.pool) - 1000;
    expect(over).toBeCloseTo(base.byId.A.calcBonus + 10000 + 200 - 1000, 8);
  });

  it("getMaxDA is the largest DA the pool can absorb", () => {
    const base = run();
    const maxDa = getMaxDA(base.byId.A, base.pool);
    // room = stateVicAvail - locked - A's own base-scaled draw, floored
    expect(maxDa).toBe(Math.floor(1000 - 200 - 200 * (800 / 920)));
    // at exactly maxDa the cap is filled and never breached
    const atMax = run({ A: { daEdit: maxDa } });
    expect(atMax.pool.vicScale).toBeGreaterThanOrEqual(0);
    expect(totalVicAlloc(atMax.emps, atMax.pool)).toBeCloseTo(1000, 6);
    // one dollar more starts overdrawing the pool
    const overMax = run({ A: { daEdit: maxDa + 1 } });
    expect(overMax.pool.vicScale).toBe(0);
    expect(totalVicAlloc(overMax.emps, overMax.pool)).toBeGreaterThan(1000);
  });

  it("getMaxDA edge cases: site managers, locked rows, both-pool rows, no-pool rows", () => {
    const base = run();
    // A site manager can take a DA (24 Aug 2026): the room is everything
    // left after their own fixed 200, i.e. what the unlocked rows would get
    expect(getMaxDA(base.byId.C, base.pool)).toBe(800); // site manager
    const locked = run({ B: { locked: true, lockedFinal: 500 } });
    expect(getMaxDA(locked.byId.B, locked.pool)).toBe(0); // locked
    // E draws from both pools: its bound is the tighter of the two rooms
    const eMax = getMaxDA(base.byId.E, base.pool);
    const vicRoom = (1000 - 200 - 120 * (800 / 920)) / 0.6;
    const nswRoom = (500 - 80 * (500 / 580)) / 0.4;
    expect(eMax).toBe(Math.floor(Math.min(vicRoom, nswRoom)));
    // F draws from no pool: no pool-derived bound at all
    expect(getMaxDA(base.byId.F, base.pool)).toBe(Infinity);
    // and when stored data already overdraws the pool, the room is negative
    const crowded = run({ A: { daEdit: 2000 } });
    expect(getMaxDA(crowded.byId.B, crowded.pool)).toBeLessThan(0);
  });
});

describe("a site manager's discretionary rides on the fixed bonus (24 Aug 2026)", () => {
  it("final = fixed bonus + DA, funded off the top of the pool", () => {
    const base = run();
    const adj = run({ C: { daEdit: 100 } });
    // the fixed bonus itself never scales; the DA sits on top of it
    expect(adj.byId.C.calcBonus).toBeCloseTo(200, 10);
    expect(adj.byId.C.finalBonus).toBeCloseTo(300, 10);
    // the pool pays: VIC's unlocked rows scale down by exactly the grant
    expect(adj.pool.vicScale).toBeCloseTo((1000 - 300) / 920, 12);
    expect(adj.pool.vicScale).toBeLessThan(base.pool.vicScale);
    // NSW untouched — C draws purely from VIC
    expect(adj.pool.nswScale).toBeCloseTo(base.pool.nswScale, 12);
    // and the cap still holds exactly
    expect(totalVicAlloc(adj.emps, adj.pool)).toBeCloseTo(1000, 6);
  });

  it("a negative DA frees pool money back to the others", () => {
    const base = run();
    const adj = run({ C: { daEdit: -50 } });
    expect(adj.byId.C.finalBonus).toBeCloseTo(150, 10);
    expect(adj.pool.vicScale).toBeGreaterThan(base.pool.vicScale);
  });

  it("at exactly getMaxDA the unlocked rows floor at $0 and the cap holds", () => {
    const base = run();
    const maxDa = getMaxDA(base.byId.C, base.pool);
    expect(maxDa).toBe(800); // everything the unlocked rows would have drawn
    const atMax = run({ C: { daEdit: maxDa } });
    expect(atMax.pool.vicScale).toBeCloseTo(0, 8);
    expect(totalVicAlloc(atMax.emps, atMax.pool)).toBeCloseTo(1000, 6);
  });
});

describe("an under-subscribed pool absorbs a DA from its own headroom first", () => {
  const bigCaps: Caps = { vCap: 100_000, nCap: 100_000, gCap: 200_000 };
  function roomy(overrides: Overrides = {}) {
    const emps = applyOverrides(FIXTURE, overrides);
    const pool = computeScalesAndBonuses(emps, bigCaps);
    const byId = Object.fromEntries(emps.map((e) => [e.id, e]));
    return { emps, pool, byId };
  }

  it("a small DA moves nobody: it comes out of the unspent remainder", () => {
    const base = roomy();
    const adj = roomy({ A: { daEdit: 100 } });
    expect(adj.pool.vicScaleBase).toBe(1);
    expect(adj.pool.vicScale).toBe(1); // still clamped: headroom absorbs it
    expect(adj.byId.A.finalBonus).toBeCloseTo(200 + 100, 10);
    expect(adj.byId.B.finalBonus).toBeCloseTo(base.byId.B.finalBonus, 12);
  });

  it("a DA bigger than the headroom starts scaling the others down", () => {
    // VIC headroom above full entitlements: 100000 - 200 (sm) - 920 = 98880
    const adj = roomy({ A: { daEdit: 99_000 } });
    expect(adj.pool.vicScaleBase).toBe(1);
    expect(adj.pool.vicScale).toBeLessThan(1);
    // the recipient still gets their full unscaled entitlement plus the DA
    expect(adj.byId.A.calcBonus).toBeCloseTo(200, 10);
    expect(adj.byId.A.finalBonus).toBeCloseTo(200 + 99_000, 8);
    expect(totalVicAlloc(adj.emps, adj.pool)).toBeCloseTo(100_000, 6);
  });
});

describe("edge guards", () => {
  it("ipm = 0: cpm derives from raw bipm; ipmEdit 0 zeroes the bonus", () => {
    const e = makeEmp({ id: "Z", ipm: 0, bipm: 100 });
    const { preIpm, cpm } = deriveCpm(e);
    expect(preIpm).toBe(100);
    expect(cpm).toBeCloseTo(1, 10); // 100 / (1000*0.1)
    const emps = applyOverrides([e], {});
    computeScalesAndBonuses(emps, CAPS);
    expect(emps[0].bipmCalc).toBe(0); // pkg*bp*cpm * ipmEdit(0)
  });

  it("pkg*bp = 0: cpm falls back to 1", () => {
    const e = makeEmp({ id: "Z", pkg: 0, bipm: 100 });
    expect(deriveCpm(e).cpm).toBe(1);
  });

  it("zero unlocked bipm in a pool → scale defaults to 1", () => {
    const emps = applyOverrides(
      [makeEmp({ id: "A", st: "NSW", vp: 0, np: 1 })],
      {}
    );
    const pool = computeScalesAndBonuses(emps, CAPS);
    expect(pool.vicScale).toBe(1);
  });

  it("percent input parsing matches the prototype ('90' → 0.9, '0.9' → 0.9)", () => {
    expect(parsePercentInput("90")).toBe(0.9);
    expect(parsePercentInput("90%")).toBe(0.9);
    expect(parsePercentInput("0.9")).toBe(0.9);
    expect(parsePercentInput("abc")).toBeNull();
    // negatives are allowed: a DA may deliberately reduce a final bonus
    expect(parseDaInput("-500")).toBe(-500);
    expect(parseDaInput("$1,500")).toBe(1500);
  });
});

describe("real-data regression (data/bonus.json)", () => {
  // Originally computed with an independent Python implementation of the
  // prototype's algorithm. Re-anchored (deliberately) for the 24 August 2026
  // pool-funded DA reform: one source row (ALANT) carries da=3000, which the
  // VIC pool absorbs again, so the non-DA rows' vicScale drops a touch below
  // the base scale (0.67178... lives on as vicScaleBase), NSW has no DA row
  // and is untouched, and the group total lands exactly on gCap.
  const data = JSON.parse(
    readFileSync(join(__dirname, "..", "data", "bonus.json"), "utf-8")
  );

  it("reproduces the baseline scales and group total exactly", () => {
    const emps = applyOverrides(data.emp, {});
    const pool = computeScalesAndBonuses(emps, data);
    expect(pool.vicScale).toBeCloseTo(0.6701269613529727, 12);
    expect(pool.vicScaleBase).toBeCloseTo(0.6717823483284814, 12);
    expect(pool.nswScale).toBeCloseTo(0.7820525079336984, 12);
    expect(pool.nswScaleBase).toBe(pool.nswScale);
    const totFinal = emps.reduce((s, e) => s + e.finalBonus, 0);
    expect(totFinal).toBeCloseTo(2618822.75, 6);
    expect(totFinal).toBeCloseTo(data.gCap, 6);
    expect(totalVicAlloc(emps, pool)).toBeCloseTo(1580414.5, 6);
    expect(totalNswAlloc(emps, pool)).toBeCloseTo(1038408.25, 6);
  });
});

/**
 * WALKTHROUGH REQUIREMENT — confirmed correct with the finance owner and not
 * to be broken:
 *
 *   Site managers are FIXED, not redistributed. Their bonus is purely their
 *   actual percentage × IPM. It does not pro-rata against the pool.
 *   Everyone else pro-rates off the pool, so their figures shift as other
 *   allocations change.
 *
 * The mechanism is lib/calc.ts: a site manager's finalBonus is assigned
 * bipmCalc directly (`pkg × bpEdit × cpm × ipmEdit`) and never multiplied by
 * vicScale/nswScale, while they still consume pool via empLockedVp/Np.
 */
describe("site managers are fixed, everyone else pro-rates (do not break)", () => {
  it("a site manager's bonus is package × bonus% × IPM%, with no scale applied", () => {
    const { byId, pool } = run();
    const c = byId.C;
    expect(c.finalBonus).toBeCloseTo(c.pkg * c.bpEdit * c.cpm * c.ipmEdit, 10);
    // and that is emphatically NOT the scaled figure the others receive
    expect(pool.vicScale).not.toBeCloseTo(1, 3);
    expect(c.finalBonus).not.toBeCloseTo(c.bipmCalc * pool.vicScale, 3);
  });

  it("editing a site manager's IPM moves their bonus proportionally, and only theirs", () => {
    const base = run();
    const half = run({ C: { ipmEdit: 0.5 } });
    expect(half.byId.C.finalBonus).toBeCloseTo(base.byId.C.finalBonus * 0.5, 10);
    // their released pool flows to the others, which is the point of the pool
    expect(half.byId.A.finalBonus).toBeGreaterThan(base.byId.A.finalBonus);
    expect(half.byId.B.finalBonus).toBeGreaterThan(base.byId.B.finalBonus);
  });

  it("editing a site manager's bonus % moves their bonus proportionally", () => {
    const base = run();
    const doubled = run({ C: { bpEdit: FIXTURE[2].bp * 2 } });
    expect(doubled.byId.C.finalBonus).toBeCloseTo(base.byId.C.finalBonus * 2, 10);
  });

  it("a site manager does NOT move when other people's allocations change", () => {
    const base = run();
    const afterOthersChange = run({
      A: { ipmEdit: 0.4 },
      B: { daEdit: 50 },
      D: { ipmEdit: 1.5 },
    });
    // everyone else in VIC shifted…
    expect(afterOthersChange.byId.A.finalBonus).not.toBeCloseTo(
      base.byId.A.finalBonus,
      6
    );
    expect(afterOthersChange.byId.B.finalBonus).not.toBeCloseTo(
      base.byId.B.finalBonus,
      6
    );
    // …the site manager did not move at all
    expect(afterOthersChange.byId.C.finalBonus).toBeCloseTo(
      base.byId.C.finalBonus,
      10
    );
  });

  it("a site manager is unaffected by the pool cap itself", () => {
    const emps = applyOverrides(FIXTURE, {});
    computeScalesAndBonuses(emps, { vCap: 100_000, nCap: 500, gCap: 100_500 });
    const rich = emps.find((e) => e.id === "C")!.finalBonus;
    const emps2 = applyOverrides(FIXTURE, {});
    computeScalesAndBonuses(emps2, { vCap: 10, nCap: 500, gCap: 510 });
    const poor = emps2.find((e) => e.id === "C")!.finalBonus;
    expect(rich).toBeCloseTo(200, 10);
    expect(poor).toBeCloseTo(200, 10);
  });

  it("a site manager still consumes pool, so the others scale around them", () => {
    const withSm = run();
    // same fixture with C no longer a site manager: C now scales like the rest
    const emps = applyOverrides(
      FIXTURE.map((e) => (e.id === "C" ? { ...e, sm: 0 as const } : e)),
      {}
    );
    const pool = computeScalesAndBonuses(emps, CAPS);
    // C's 200 came off the top before; now it competes, so the scale differs
    expect(pool.vicScale).not.toBeCloseTo(withSm.pool.vicScale, 6);
    expect(emps.find((e) => e.id === "C")!.finalBonus).not.toBeCloseTo(200, 3);
  });

  it("holds on the real dataset: every site manager equals their own figure", () => {
    const real = JSON.parse(
      readFileSync(join(__dirname, "..", "data", "bonus.json"), "utf-8")
    ) as { emp: Employee[]; vCap: number; nCap: number; gCap: number };
    const emps = applyOverrides(real.emp, {});
    computeScalesAndBonuses(emps, real);
    const sms = emps.filter((e) => e.sm);
    expect(sms.length).toBeGreaterThan(0);
    for (const e of sms) {
      expect(e.finalBonus).toBeCloseTo(e.pkg * e.bpEdit * e.cpm * e.ipmEdit, 6);
      expect(e.finalBonus).toBeCloseTo(e.bipm, 6);
    }
  });
});

describe("Potential Bonus reconciles with After IPM", () => {
  /**
   * "Potential Bonus" is the new build-up column shown before "After IPM" —
   * exposed as `preIpm`, which already includes the per-employee `cpm`
   * correction (deriveCpm). This is the guard against building it the naive
   * way instead (pkg × bp, ignoring cpm): that would visibly disagree with
   * "After IPM" for anyone whose source bipm didn't already equal
   * pkg × bp × ipm — confirmed against the real dataset to be roughly a
   * quarter of the real population.
   */
  it("preIpm × ipm reproduces bipmCalc even when cpm isn't 1", () => {
    // bipm (60000) deliberately doesn't equal pkg×bp×ipm (1000×0.1×0.9=90),
    // so cpm has real work to do here, not just the identity case.
    const e = makeEmp({ id: "Z", pkg: 1000, bp: 0.1, ipm: 0.9, bipm: 60000 });
    const { cpm } = deriveCpm(e);
    expect(cpm).not.toBeCloseTo(1, 2);

    const [emp] = applyOverrides([e], {});
    computeScalesAndBonuses([emp], CAPS);

    // The build-up column's own figure...
    const potentialBonus = emp.preIpm;
    // ...reconciles exactly with the existing "After IPM" figure once its
    // own IPM is applied — the whole point of surfacing it.
    expect(potentialBonus * emp.ipmEdit).toBeCloseTo(emp.bipmCalc, 8);
    // and matches the source bipm, since ipmEdit defaults to the source ipm
    expect(emp.bipmCalc).toBeCloseTo(60000, 6);
  });

  it("a naive pkg × bp would have disagreed with After IPM here", () => {
    // The exact failure this design avoids, stated as a test: without cpm,
    // "Potential Bonus" would be 100 (1000×0.1) and "After IPM" would be
    // 90 (100×0.9) — not the real 60000 already on screen elsewhere.
    const e = makeEmp({ id: "Z", pkg: 1000, bp: 0.1, ipm: 0.9, bipm: 60000 });
    const naivePotential = e.pkg * e.bp;
    const [emp] = applyOverrides([e], {});
    computeScalesAndBonuses([emp], CAPS);
    expect(naivePotential).not.toBeCloseTo(emp.preIpm, 2);
  });
});

/**
 * Locking a site manager used to be a no-op: the bonus loop tested `sm` before
 * `locked`, so the flag was set and the figure kept moving. C is the fixture's
 * site manager (fixed at 200, VIC); these pin the lock actually biting.
 */
describe("a locked site manager really freezes (24 Aug 2026)", () => {
  it("pays the frozen figure, not the live one", () => {
    const { byId } = run({ C: { locked: true, lockedFinal: 50 } });
    expect(byId.C.finalBonus).toBeCloseTo(50, 10);
    // calcBonus still reports what they WOULD draw, as for any locked row
    expect(byId.C.calcBonus).toBeCloseTo(200, 10);
  });

  it("a discretionary amount cannot move a frozen site manager", () => {
    const { byId } = run({ C: { locked: true, lockedFinal: 50, daEdit: 500 } });
    expect(byId.C.finalBonus).toBeCloseTo(50, 10);
  });

  it("only the frozen figure comes off the pool, so the others get the rest", () => {
    const base = run();
    // Freezing C at 150 instead of their live 200 releases 50 into VIC. Not
    // lower: freeing much more would leave the pool under-subscribed, the
    // scale would clamp at 1 (FY26 methodology) and the remainder would go
    // unspent, which is a different behaviour from the redistribution here.
    const frozen = run({ C: { locked: true, lockedFinal: 150 } });
    expect(frozen.pool.vicScale).toBeGreaterThan(base.pool.vicScale);
    expect(frozen.byId.A.finalBonus).toBeGreaterThan(base.byId.A.finalBonus);
    expect(frozen.byId.B.finalBonus).toBeGreaterThan(base.byId.B.finalBonus);
    // and the pool still fills exactly, with the frozen draw counted once
    expect(totalVicAlloc(frozen.emps, frozen.pool)).toBeCloseTo(1000, 8);
  });

  it("freezing one far below their live figure under-subscribes the pool", () => {
    // the companion to the above: C frozen at 50 releases 150, more than the
    // others can absorb at scale 1, so 30 is deliberately left unspent
    const { emps, pool } = run({ C: { locked: true, lockedFinal: 50 } });
    expect(pool.vicScale).toBe(1);
    expect(totalVicAlloc(emps, pool)).toBeCloseTo(970, 8);
  });

  it("getVicAlloc/getNswAlloc price the frozen draw, not the fixed bonus", () => {
    const { byId, pool } = run({ C: { locked: true, lockedFinal: 50 } });
    expect(getVicAlloc(byId.C, pool)).toBeCloseTo(50, 10);
    expect(getNswAlloc(byId.C, pool)).toBeCloseTo(0, 10);
  });

  it("a frozen site manager has no discretionary headroom", () => {
    const { byId, pool } = run({ C: { locked: true, lockedFinal: 50 } });
    expect(getMaxDA(byId.C, pool)).toBe(0);
  });

  it("an unlocked site manager is untouched by any of this", () => {
    const base = run();
    expect(base.byId.C.finalBonus).toBeCloseTo(200, 10);
    expect(getVicAlloc(base.byId.C, base.pool)).toBeCloseTo(200, 10);
  });
});

describe("isLockable", () => {
  it("a pooled non-site-manager row is lockable", () => {
    expect(isLockable({ sm: 0, st: "SHARED", inPool: true })).toBe(true);
    expect(isLockable({ sm: 0, st: "NSW", inPool: true })).toBe(true);
  });

  it("an NSW site manager is lockable (24 Aug 2026), a VIC one is not", () => {
    expect(isLockable({ sm: 1, st: "NSW", inPool: true })).toBe(true);
    expect(isLockable({ sm: 1, st: "VIC", inPool: true })).toBe(false);
  });

  it("a row drawing from no pool is not", () => {
    expect(isLockable({ sm: 0, st: "VIC", inPool: false })).toBe(false);
  });

  it("rowRule reads pool exposure off an Employee's vp/np", () => {
    expect(rowRule({ sm: 0, st: "VIC", vp: 1, np: 0 }).inPool).toBe(true);
    expect(rowRule({ sm: 0, st: "VIC", vp: 0, np: 0 }).inPool).toBe(false);
  });
});

/**
 * The site-manager split (owner decision, 24 August 2026): NSW site managers'
 * discretionary amounts are editable, VIC ones' are not. On the real dataset
 * that is 8 rows adjustable and 16 not.
 */
describe("isDaEditable", () => {
  it("an NSW site manager's discretionary IS editable", () => {
    expect(isDaEditable({ sm: 1, st: "NSW", inPool: true })).toBe(true);
  });

  it("a VIC site manager's is NOT — the fixed bonus stays untouchable", () => {
    expect(isDaEditable({ sm: 1, st: "VIC", inPool: true })).toBe(false);
  });

  it("a Shared Services site manager's is not either — 'only NSW' read strictly", () => {
    expect(isDaEditable({ sm: 1, st: "SHARED", inPool: true })).toBe(false);
  });

  it("everyone who is not a site manager is unaffected by the split", () => {
    for (const st of ["VIC", "NSW", "SHARED"] as const) {
      expect(isDaEditable({ sm: 0, st, inPool: true })).toBe(true);
    }
  });

  it("a row drawing from no pool has nothing to fund one, site manager or not", () => {
    expect(isDaEditable({ sm: 0, st: "VIC", inPool: false })).toBe(false);
    expect(isDaEditable({ sm: 1, st: "NSW", inPool: false })).toBe(false);
  });

  it("agrees with isLockable today — both admit NSW site managers only", () => {
    // They are separate names because they answer different questions and have
    // diverged before; if you change one, check the other.
    for (const st of ["VIC", "NSW", "SHARED"] as const) {
      for (const sm of [0, 1] as const) {
        for (const inPool of [true, false]) {
          expect(isDaEditable({ sm, st, inPool })).toBe(
            isLockable({ sm, st, inPool })
          );
        }
      }
    }
  });
});
