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
 * exercising locking at all.
 *
 * Note gCap: 1500 is exactly vCap + nCap, and with both pools fully spent the
 * group total lands exactly on it — so the fixture starts with NO room under
 * the group cap, which is the real dataset's situation too. Tests that need
 * genuine headroom use their own roomier caps, as the real caps would have to
 * be raised for a grant to fit.
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

/**
 * Σ final over one home state, or over everyone — the figure the dashboard's
 * pool cards show, and the figure getMaxDA measures its room against. Not the
 * same as a pool's draw: E is Shared Services but draws from both pools.
 */
function cardTotal(emps: CalcEmployee[], st?: Employee["st"]) {
  return emps.reduce((s, e) => (!st || e.st === st ? s + e.finalBonus : s), 0);
}

/**
 * The same fixture with C — the site manager — relabelled NSW.
 *
 * Only an NSW site manager may carry a discretionary amount or a lock
 * (isDaEditable/isLockable, 24 Aug 2026), and since 25 Aug 2026 the engine
 * enforces that too rather than paying whatever is stored. So the tests for
 * those two rules need a row the rules admit; against VIC's C they were
 * exercising behaviour the scheme forbids.
 *
 * Only the LABEL moves. C keeps vp 1, so every VIC pool figure is unchanged and
 * the arithmetic below reads exactly as before — a state label and pool
 * exposure are separate facts here, and plenty of people draw from the pool of
 * a state they do not belong to. What does move is which card C's own bonus
 * lands on, which the grant tests assert against NSW accordingly.
 */
const FIXTURE_NSW_SM: Employee[] = FIXTURE.map((e) =>
  e.id === "C" ? { ...e, st: "NSW" as const } : e
);

function runSm(overrides: Overrides = {}) {
  const emps = applyOverrides(FIXTURE_NSW_SM, overrides);
  const pool = computeScalesAndBonuses(emps, CAPS);
  const byId = Object.fromEntries(emps.map((e) => [e.id, e]));
  return { emps, pool, byId };
}

describe("baseline (no edits, no locks)", () => {
  it("computes the expected scales", () => {
    const { pool } = run();
    expect(pool.vicScale).toBeCloseTo(800 / 920, 10);
    // NSW is pinned at 1 (25 Aug 2026, NSW_FULL_ENTITLEMENT) — it would
    // otherwise be 500/580 here, the cap over a demand that exceeds it
    expect(pool.nswScale).toBe(1);
    expect(pool.stateVicAvail).toBe(1000);
    expect(pool.stateNswAvail).toBe(500);
  });

  it("VIC fills its cap exactly; NSW overspends its own by paying in full", () => {
    const { emps, pool } = run();
    expect(totalVicAlloc(emps, pool)).toBeCloseTo(1000, 8);
    // D's 500 plus E's 80 of NSW work: the whole entitlement, cap or no cap.
    // The overshoot is exactly the part the cap could not cover, and it is
    // surfaced on the pool card rather than taken off anyone's bonus.
    expect(totalNswAlloc(emps, pool)).toBeCloseTo(580, 8);
    expect(totalNswAlloc(emps, pool) - CAPS.nCap).toBeCloseTo(80, 8);
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

describe("discretionary adjustments sit on top of the pool (owner decision, 25 Aug 2026)", () => {
  it("Calc bonus + Discretionary = Final, exactly, and no scale moves", () => {
    const base = run();
    const adj = run({ A: { daEdit: 100 } });

    // the pool calculation is untouched: a DA is not deducted from it
    expect(adj.pool.vicScale).toBeCloseTo(base.pool.vicScale, 12);
    expect(adj.byId.A.calcBonus).toBeCloseTo(base.byId.A.calcBonus, 12);
    // the identity the dashboard promises: typing 100 gives exactly 100 more
    expect(adj.byId.A.finalBonus).toBeCloseTo(adj.byId.A.calcBonus + 100, 12);
    // pool money alone still fills the cap exactly — the DA is not pool money
    expect(totalVicAlloc(adj.emps, adj.pool)).toBeCloseTo(1000, 8);
  });

  it("nobody else moves: not the other unlocked rows, not the other state", () => {
    const base = run();
    const adj = run({ A: { daEdit: 100 } });
    for (const id of ["B", "C", "D", "E", "F"]) {
      expect(adj.byId[id].finalBonus).toBeCloseTo(base.byId[id].finalBonus, 12);
    }
    expect(adj.pool.nswScale).toBeCloseTo(base.pool.nswScale, 12);
  });

  it("the pool totals move by exactly the grant — the point of the reversal", () => {
    // The owner's own complaint about the pool-funded model: "I'm changing
    // discretionary number and the total is not changing." It changes now.
    const base = run();
    const adj = run({ A: { daEdit: 100 } });
    expect(cardTotal(adj.emps, "VIC") - cardTotal(base.emps, "VIC")).toBeCloseTo(100, 8);
    expect(cardTotal(adj.emps) - cardTotal(base.emps)).toBeCloseTo(100, 8);
    expect(cardTotal(adj.emps, "NSW")).toBeCloseTo(cardTotal(base.emps, "NSW"), 12);
  });

  it("a grant lands on the recipient's HOME state total, whichever pools fund them", () => {
    // E belongs to Shared Services but draws 60/40 from the two pools. The
    // grant shows up under Shared Services, which is how the dashboard groups
    // it — and so how getMaxDA measures the room for it.
    const base = run();
    const adj = run({ E: { daEdit: 100 } });
    expect(cardTotal(adj.emps, "SHARED") - cardTotal(base.emps, "SHARED")).toBeCloseTo(100, 8);
    expect(cardTotal(adj.emps, "VIC")).toBeCloseTo(cardTotal(base.emps, "VIC"), 12);
    expect(cardTotal(adj.emps, "NSW")).toBeCloseTo(cardTotal(base.emps, "NSW"), 12);
  });

  it("a negative DA reduces the final below the calc, and the total with it", () => {
    const base = run();
    const adj = run({ A: { daEdit: -50 } });
    expect(adj.byId.A.finalBonus).toBeCloseTo(base.byId.A.calcBonus - 50, 12);
    // it frees nothing to anyone else — it just lowers the pool total
    expect(adj.pool.vicScale).toBeCloseTo(base.pool.vicScale, 12);
    expect(adj.byId.B.finalBonus).toBeCloseTo(base.byId.B.finalBonus, 12);
    expect(cardTotal(adj.emps, "VIC") - cardTotal(base.emps, "VIC")).toBeCloseTo(-50, 8);
  });

  it("total payout exceeds the pools by exactly the net DA", () => {
    const base = run();
    const adj = run({ A: { daEdit: 100 }, D: { daEdit: -40 } });
    const totalBase = base.emps.reduce((s, e) => s + e.finalBonus, 0);
    const totalAdj = adj.emps.reduce((s, e) => s + e.finalBonus, 0);
    expect(totalAdj - totalBase).toBeCloseTo(100 - 40, 10);
    // the pool draws themselves do not move with a DA (it is on top): VIC on
    // its cap, NSW on its full entitlement
    expect(totalVicAlloc(adj.emps, adj.pool)).toBeCloseTo(1000, 8);
    expect(totalNswAlloc(adj.emps, adj.pool)).toBeCloseTo(580, 8);
  });

  it("a second DA leaves the first recipient's figures exactly where they were", () => {
    const one = run({ A: { daEdit: 100 } });
    const two = run({ A: { daEdit: 100 }, E: { daEdit: 30 } });
    expect(two.byId.A.calcBonus).toBeCloseTo(one.byId.A.calcBonus, 12);
    expect(two.byId.A.finalBonus).toBeCloseTo(one.byId.A.finalBonus, 12);
    expect(two.byId.E.finalBonus).toBeCloseTo(two.byId.E.calcBonus + 30, 12);
    // and nobody funds either of them
    expect(two.byId.B.finalBonus).toBeCloseTo(one.byId.B.finalBonus, 12);
  });

  it("a zero-weight employee cannot carry one at all, stored or imported", () => {
    const base = run();
    const adj = run({ F: { daEdit: 500 } });
    expect(adj.byId.F.calcBonus).toBe(0);
    // F draws from no pool, so the scheme does not admit a discretionary
    // amount for them (isDaEditable). /api/state has always refused to store
    // one; since 25 Aug 2026 applyOverrides will not pay one already stored
    // either, so a figure stranded by a rule change cannot keep being paid.
    expect(adj.byId.F.finalBonus).toBe(0);
    expect(adj.pool.vicScale).toBeCloseTo(base.pool.vicScale, 12);
    expect(adj.pool.nswScale).toBeCloseTo(base.pool.nswScale, 12);
  });
});

/**
 * The acceptance case the business owner stated, in their own numbers:
 * 5,429 typed against a 24,571 calc bonus is $30,000, and it is still
 * $30,000 after someone else's discretionary amount lands. Trivially true
 * once a DA is on top of the pool (25 August 2026) — no DA touches any
 * scale — and kept as a test because it is the case the owner named.
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
    // no DA moves a scale, and the pool is roomy enough to clamp at 1 anyway
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
    // locked B moves into the locked aggregate: the scale spans the remaining
    // 320 bipm (A + E's VIC share). A's DA is not in it.
    const scale = (1000 - 200 - bFinal) / 320;
    expect(adj.pool.vicScale).toBeCloseTo(scale, 10);
    expect(adj.byId.A.finalBonus).toBeCloseTo(200 * scale + 100, 10);
    // pool money still fills the cap; the DA is the overshoot on top of it
    expect(totalVicAlloc(adj.emps, adj.pool)).toBeCloseTo(1000, 8);
    expect(cardTotal(adj.emps, "VIC")).toBeGreaterThan(895.65);
  });

  it("locked row still shows a live calcBonus but keeps frozen finalBonus", () => {
    // Locked at a figure deliberately different from B's natural share, so
    // the live calc and the frozen final must disagree. (Locking B at exactly
    // its baseline share would leave the scale unchanged and the two would
    // coincide — a DA cannot break that tie, since it moves no scale.)
    const adj = run({ B: { locked: true, lockedFinal: 400 } });
    expect(adj.byId.B.finalBonus).toBe(400);
    expect(adj.byId.B.calcBonus).not.toBeCloseTo(400, 4);
  });

  it("unlocking releases the bonus back into the pool", () => {
    const relocked = run({ A: { daEdit: 100 } }); // as if B was unlocked again
    expect(relocked.pool.vicScale).toBeCloseTo(800 / 920, 10);
  });

  it("a DA left on a row that is then locked is inert: the frozen final already holds it", () => {
    // B locked at a frozen figure that (say) included a DA at lock time, with
    // the stale daEdit still stored in the override. Only the frozen figure
    // counts — it is deducted once, and the stale amount is not paid again.
    const adj = run({ B: { locked: true, lockedFinal: 500, daEdit: 100 } });
    expect(adj.byId.B.finalBonus).toBe(500);
    // scale derives from the frozen 500 alone, over A + E's VIC share
    expect(adj.pool.vicScale).toBeCloseTo((1000 - 200 - 500) / 320, 10);
    // and locking is what puts a DA inside the pool: the frozen 500 comes off
    // the top whether or not part of it was once discretionary
    expect(adj.pool.poolAgg.empLockedVp).toBeCloseTo(200 + 500, 10);
  });
});

describe("all-but-one locked", () => {
  const bFinal = 600 * (800 / 920);
  const eFinal = 200 * 0.6 * (800 / 920) + 200 * 0.4 * (500 / 580);
  const locks: Overrides = {
    B: { locked: true, lockedFinal: bFinal },
    E: { locked: true, lockedFinal: eFinal },
  };

  it("the sole unlocked employee's DA rides on top of their scaled share", () => {
    const adj = run({ ...locks, A: { daEdit: 100 } });
    // E is blended (vp 0.6/np 0.4) and locked: its contribution to VIC's pool
    // deduction is split via the no-locks-weighted method (FY26 fix), not raw
    // vp — so this isn't simply `eFinal * 0.6` any more. Assert against the
    // actual pool-math split via poolAgg.empLockedVp instead of re-deriving
    // it by hand, since that's exactly the quantity under test.
    expect(adj.pool.vicScale).toBeCloseTo(
      (1000 - adj.pool.poolAgg.empLockedVp) / 200,
      8
    );
    expect(adj.byId.A.finalBonus).toBeCloseTo(
      200 * adj.pool.vicScale + 100,
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

describe("a stored over-cap adjustment overshoots the cap and shows it", () => {
  // The engine never clamps a stored DA — the editor's getMaxDA clamp and
  // /api/state's headroom gate are what prevent typing one. A figure that is
  // already stored is paid in full and the overshoot is surfaced on the pool
  // cards (they paint red) rather than silently trimmed.
  it("the recipient keeps the whole amount and nobody else is touched", () => {
    const base = run();
    const adj = run({ A: { daEdit: 10_000 } });
    expect(adj.pool.vicScale).toBeCloseTo(base.pool.vicScale, 12);
    expect(adj.byId.A.finalBonus).toBeCloseTo(base.byId.A.calcBonus + 10_000, 10);
    expect(adj.byId.B.finalBonus).toBeCloseTo(base.byId.B.finalBonus, 12);
    // pool money is still exactly the cap; the DA is the part that overshoots
    expect(totalVicAlloc(adj.emps, adj.pool)).toBeCloseTo(1000, 8);
    expect(cardTotal(adj.emps, "VIC")).toBeCloseTo(
      cardTotal(base.emps, "VIC") + 10_000,
      8
    );
  });

  it("leaves the caps with no room at all — reported negative, not pretended away", () => {
    const crowded = run({ A: { daEdit: 10_000 } });
    // everyone else is over-cap by the overshoot, which is honestly "no room"
    expect(getMaxDA(crowded.byId.B, crowded.emps, CAPS)).toBeLessThan(0);
    // the row that caused it is bounded by the group cap, which this fixture
    // already exceeds by the 80 of NSW work its own cap cannot cover — so even
    // backing out A's own amount leaves it short, and clampDa holds the stored
    // figure rather than dragging it down
    expect(getMaxDA(crowded.byId.A, crowded.emps, CAPS)).toBe(-80);
  });
});

describe("an NSW site manager's discretionary rides on the fixed bonus (24 Aug 2026)", () => {
  it("final = fixed bonus + DA, with the pool untouched", () => {
    const base = runSm();
    const adj = runSm({ C: { daEdit: 100 } });
    // the fixed bonus itself never scales; the DA sits on top of it
    expect(adj.byId.C.calcBonus).toBeCloseTo(200, 10);
    expect(adj.byId.C.finalBonus).toBeCloseTo(300, 10);
    // the pool pays nothing for it: their fixed bonus comes off the top as
    // always, and their DA sits outside the pool like everyone else's
    expect(adj.pool.vicScale).toBeCloseTo(base.pool.vicScale, 12);
    expect(adj.pool.nswScale).toBeCloseTo(base.pool.nswScale, 12);
    expect(adj.byId.A.finalBonus).toBeCloseTo(base.byId.A.finalBonus, 12);
    expect(totalVicAlloc(adj.emps, adj.pool)).toBeCloseTo(1000, 6);
    // it lands on their own state's total, like any other grant — C's card is
    // NSW even though VIC funds their fixed bonus (vp 1)
    expect(cardTotal(adj.emps, "NSW") - cardTotal(base.emps, "NSW")).toBeCloseTo(100, 8);
  });

  it("a negative DA lowers them and their pool's total, and frees nothing", () => {
    const base = runSm();
    const adj = runSm({ C: { daEdit: -50 } });
    expect(adj.byId.C.finalBonus).toBeCloseTo(150, 10);
    expect(adj.pool.vicScale).toBeCloseTo(base.pool.vicScale, 12);
    expect(adj.byId.B.finalBonus).toBeCloseTo(base.byId.B.finalBonus, 12);
    expect(cardTotal(adj.emps, "NSW") - cardTotal(base.emps, "NSW")).toBeCloseTo(-50, 8);
  });

  it("a VIC site manager's is inert — stored, imported, or left behind", () => {
    // The 24 Aug 2026 split, enforced where the money is decided. This is the
    // regression that put six VIC site managers back to their fixed bonus: an
    // amount typed into one during the ~35 minutes they were editable in
    // production was still being paid, while the cell showed a dash.
    const base = run();
    const adj = run({ C: { daEdit: 100 } }); // C is VIC in the main fixture
    expect(adj.byId.C.finalBonus).toBeCloseTo(200, 10);
    expect(adj.byId.C.finalBonus).toBeCloseTo(base.byId.C.finalBonus, 12);
    expect(adj.byId.C.daEdit).toBe(0);
    // and a lock on one is inert too — isLockable refuses them as well
    const frozen = run({ C: { locked: true, lockedFinal: 50 } });
    expect(frozen.byId.C.locked).toBe(false);
    expect(frozen.byId.C.finalBonus).toBeCloseTo(200, 10);
    // nobody else moves either way: the fixed 200 comes off the top as always
    expect(frozen.pool.vicScale).toBeCloseTo(base.pool.vicScale, 12);
  });
});

/**
 * The automatic refusal the owner asked for (25 August 2026): "it will get
 * refused automatically by each discretionary field". getMaxDA is that bound —
 * the room left under the caps, measured off exactly the totals the pool cards
 * show (Σ final by home state, and Σ final over everyone for the group).
 *
 * These use their own roomier caps because the fixture's own leave no group
 * room at all (gCap === vCap + nCap with both pools fully spent) — which is
 * the real dataset's position too, and the subject of the last test here.
 */
describe("getMaxDA is the room left under the caps", () => {
  const ROOM: Caps = { vCap: 100_000, nCap: 100_000, gCap: 200_000 };
  function roomy(overrides: Overrides = {}) {
    const emps = applyOverrides(FIXTURE, overrides);
    const pool = computeScalesAndBonuses(emps, ROOM);
    const byId = Object.fromEntries(emps.map((e) => [e.id, e]));
    return { emps, pool, byId };
  }
  const max = (r: ReturnType<typeof roomy>, id: string) =>
    getMaxDA(r.byId[id], r.emps, ROOM);

  it("is the home-state cap minus everything else already on that card", () => {
    const r = roomy();
    // VIC's card holds A 200 + B 600 + C 200 + F 0 = 1,000 of a 100,000 cap,
    // and A's own 200 counts against them too: 100,000 - 1,000 + 0 = 99,000
    expect(cardTotal(r.emps, "VIC")).toBeCloseTo(1000, 10);
    expect(max(r, "A")).toBe(99_000);
  });

  it("at exactly the ceiling the card lands on its cap, and one dollar more passes it", () => {
    const atMax = roomy({ A: { daEdit: 99_000 } });
    expect(cardTotal(atMax.emps, "VIC")).toBeCloseTo(100_000, 8);
    expect(max(atMax, "B")).toBe(0); // and the card has nothing left for anyone
    const over = roomy({ A: { daEdit: 99_001 } });
    expect(cardTotal(over.emps, "VIC")).toBeGreaterThan(100_000);
  });

  it("does not move as the field fills up: it is what the field may HOLD", () => {
    // the clamp compares the whole requested figure against this, so the
    // ceiling has to be an absolute amount rather than a remaining increase
    const r = roomy({ A: { daEdit: 500 } });
    expect(max(r, "A")).toBe(99_000);
    // ...while everyone else on the card has 500 less room than before
    expect(max(r, "B")).toBe(98_500);
  });

  it("Shared Services has no cap of its own, so only the group bound applies", () => {
    const r = roomy();
    // group holds 1,700 of 200,000
    expect(cardTotal(r.emps)).toBeCloseTo(1700, 10);
    expect(max(r, "E")).toBe(198_300);
  });

  it("a site manager is bounded exactly like anyone else on their card", () => {
    expect(max(roomy(), "C")).toBe(99_000);
  });

  it("a locked row has none, and a row drawing from no pool has no bound", () => {
    const r = roomy({ B: { locked: true, lockedFinal: 500 } });
    expect(max(r, "B")).toBe(0); // frozen: there is nothing to grant
    expect(max(r, "F")).toBe(Infinity); // no pool, so no cap to overrun
    // B's lock released 100 of card space, which the others may now hold
    expect(max(r, "A")).toBe(99_100);
  });

  it("the group cap binds when it is the tighter of the two", () => {
    // The fixture's own caps: VIC's card still has ~104 of room, but the group
    // total is already 80 PAST gCap — NSW pays its full entitlement and gCap
    // is only vCap + nCap, so the 80 of NSW work the NSW cap cannot cover
    // lands on the group. Nothing can be granted anywhere until gCap moves.
    const base = run();
    expect(Math.floor(1000 - cardTotal(base.emps, "VIC"))).toBe(104);
    expect(cardTotal(base.emps)).toBeCloseTo(1580, 8);
    expect(getMaxDA(base.byId.A, base.emps, CAPS)).toBe(-80);
    // lift the group cap alone and the state cap becomes the binding one
    const lifted: Caps = { ...CAPS, gCap: 10_000 };
    expect(getMaxDA(base.byId.A, base.emps, lifted)).toBe(104);
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

/**
 * NSW pays full entitlement (owner decision, 25 August 2026): the ask was
 * literally "Calc bonus should be 1,074,487 — exactly equal to After IPM" on
 * an NSW lead's tab. That holds when and only when nswScale is 1, so these
 * pin the equality itself rather than the scale, and pin that VIC did not move
 * to buy it. See NSW_FULL_ENTITLEMENT in lib/calc.ts.
 */
describe("NSW is paid in full: Calc bonus equals After IPM", () => {
  it("every row drawing only on NSW gets its whole After-IPM figure", () => {
    const { byId } = run();
    expect(byId.D.calcBonus).toBeCloseTo(byId.D.bipmCalc, 10);
    expect(byId.D.calcBonus).toBe(500);
  });

  it("a split row's NSW share is unscaled while its VIC share still scales", () => {
    // E is 60 VIC / 40 NSW: the NSW slice is paid whole, the VIC slice is
    // pro-rated exactly as before — the two halves of one bonus, priced by
    // two different rules, which is what pinning one pool means
    const { byId, pool } = run();
    expect(byId.E.calcBonus).toBeCloseTo(200 * 0.6 * pool.vicScale + 200 * 0.4, 10);
    expect(pool.vicScale).toBeCloseTo(800 / 920, 10);
  });

  it("the columns the owner was looking at now total the same for NSW", () => {
    // "After IPM" and "Calc bonus", summed down an NSW-only tab
    const { emps } = run();
    const nsw = emps.filter((e) => e.st === "NSW");
    const afterIpm = nsw.reduce((s, e) => s + e.bipmCalc, 0);
    const calc = nsw.reduce((s, e) => s + e.calcBonus, 0);
    expect(nsw.length).toBeGreaterThan(0);
    expect(calc).toBeCloseTo(afterIpm, 8);
  });

  it("holds on the real dataset, row by row, for all 54 NSW people", () => {
    const real = JSON.parse(
      readFileSync(join(__dirname, "..", "data", "bonus.json"), "utf-8")
    ) as { emp: Employee[]; vCap: number; nCap: number; gCap: number };
    const emps = applyOverrides(real.emp, {});
    computeScalesAndBonuses(emps, real);
    const nsw = emps.filter((e) => e.st === "NSW" && e.np === 1);
    expect(nsw.length).toBeGreaterThan(40);
    for (const e of nsw) expect(e.calcBonus).toBeCloseTo(e.bipmCalc, 6);
    const afterIpm = nsw.reduce((s, e) => s + e.bipmCalc, 0);
    expect(nsw.reduce((s, e) => s + e.calcBonus, 0)).toBeCloseTo(afterIpm, 6);
  });

  it("no VIC-only row moved to pay for it", () => {
    // the guard on blast radius: a pure-VIC row's figure is a function of
    // vicScale alone, and vicScale is not in this decision
    const { byId } = run();
    expect(byId.A.calcBonus).toBeCloseTo(200 * (800 / 920), 10);
    expect(byId.B.calcBonus).toBeCloseTo(600 * (800 / 920), 10);
    expect(byId.C.finalBonus).toBe(200); // the site manager, fixed as ever
  });

  it("a lower NSW cap no longer changes anyone's NSW figure", () => {
    // the cap has stopped constraining NSW through scaling — stated as a test
    // because it is the cost of the decision, not an accident
    const emps = applyOverrides(FIXTURE, {});
    computeScalesAndBonuses(emps, { vCap: 1000, nCap: 1, gCap: 1001 });
    expect(emps.find((e) => e.id === "D")!.calcBonus).toBe(500);
  });
});

describe("real-data regression (data/bonus.json)", () => {
  // Originally computed with an independent Python implementation of the
  // prototype's algorithm. Re-anchored for the 25 August 2026 reversal back to
  // DA-on-top, which restores the pre-reform figures exactly: one source row
  // (ALANT) carries da=3000, which the pool no longer funds — so VIC's scale
  // returns to 0.67178…, NSW is untouched, and the group total is gCap + 3000,
  // the 3,000 being paid on top of two still-fully-spent pools.
  const data = JSON.parse(
    readFileSync(join(__dirname, "..", "data", "bonus.json"), "utf-8")
  );

  it("reproduces the baseline scales and group total exactly", () => {
    const emps = applyOverrides(data.emp, {});
    const pool = computeScalesAndBonuses(emps, data);
    // VIC is untouched by the NSW pin, to the last bit — that is the whole
    // point of pinning only the payout scale (see NSW_FULL_ENTITLEMENT)
    expect(pool.vicScale).toBeCloseTo(0.6717823483284814, 12);
    expect(pool.nswScale).toBe(1);
    const totFinal = emps.reduce((s, e) => s + e.finalBonus, 0);
    expect(totFinal).toBeCloseTo(2866751.5958, 4);
    expect(totalVicAlloc(emps, pool)).toBeCloseTo(1580414.5, 6);
    // NSW now draws its full entitlement, $244,928.85 above the cap it used to
    // be scaled into — on THIS dataset's original caps, which are lower than
    // the live ones
    expect(totalNswAlloc(emps, pool)).toBeCloseTo(1283337.0958, 4);
    expect(totalNswAlloc(emps, pool) - data.nCap).toBeCloseTo(244928.8458, 4);
  });

  it("leaves no room for a grant until the caps are raised", () => {
    // gCap is exactly vCap + nCap and both pools are fully spent, so the group
    // cap has nothing left even before ALANT's stored 3,000 — every field
    // refuses. Worth pinning: it is the first thing anyone will hit.
    const emps = applyOverrides(data.emp, {});
    computeScalesAndBonuses(emps, data);
    expect(data.gCap).toBe(data.vCap + data.nCap);
    const pooled = emps.filter((e) => e.vp + e.np > 0);
    expect(pooled.length).toBeGreaterThan(0);
    for (const e of pooled) expect(getMaxDA(e, emps, data)).toBeLessThanOrEqual(0);
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
describe("a locked NSW site manager really freezes (24 Aug 2026)", () => {
  it("pays the frozen figure, not the live one", () => {
    const { byId } = runSm({ C: { locked: true, lockedFinal: 50 } });
    expect(byId.C.finalBonus).toBeCloseTo(50, 10);
    // calcBonus still reports what they WOULD draw, as for any locked row
    expect(byId.C.calcBonus).toBeCloseTo(200, 10);
  });

  it("a discretionary amount cannot move a frozen site manager", () => {
    const { byId } = runSm({ C: { locked: true, lockedFinal: 50, daEdit: 500 } });
    expect(byId.C.finalBonus).toBeCloseTo(50, 10);
  });

  it("only the frozen figure comes off the pool, so the others get the rest", () => {
    const base = runSm();
    // Freezing C at 150 instead of their live 200 releases 50 into VIC. Not
    // lower: freeing much more would leave the pool under-subscribed, the
    // scale would clamp at 1 (FY26 methodology) and the remainder would go
    // unspent, which is a different behaviour from the redistribution here.
    const frozen = runSm({ C: { locked: true, lockedFinal: 150 } });
    expect(frozen.pool.vicScale).toBeGreaterThan(base.pool.vicScale);
    expect(frozen.byId.A.finalBonus).toBeGreaterThan(base.byId.A.finalBonus);
    expect(frozen.byId.B.finalBonus).toBeGreaterThan(base.byId.B.finalBonus);
    // and the pool still fills exactly, with the frozen draw counted once
    expect(totalVicAlloc(frozen.emps, frozen.pool)).toBeCloseTo(1000, 8);
  });

  it("freezing one far below their live figure under-subscribes the pool", () => {
    // the companion to the above: C frozen at 50 releases 150, more than the
    // others can absorb at scale 1, so 30 is deliberately left unspent
    const { emps, pool } = runSm({ C: { locked: true, lockedFinal: 50 } });
    expect(pool.vicScale).toBe(1);
    expect(totalVicAlloc(emps, pool)).toBeCloseTo(970, 8);
  });

  it("getVicAlloc/getNswAlloc price the frozen draw, not the fixed bonus", () => {
    const { byId, pool } = runSm({ C: { locked: true, lockedFinal: 50 } });
    expect(getVicAlloc(byId.C, pool)).toBeCloseTo(50, 10);
    expect(getNswAlloc(byId.C, pool)).toBeCloseTo(0, 10);
  });

  it("a frozen site manager has no discretionary headroom", () => {
    const { emps, byId } = runSm({ C: { locked: true, lockedFinal: 50 } });
    expect(getMaxDA(byId.C, emps, CAPS)).toBe(0);
  });

  it("an unlocked site manager is untouched by any of this", () => {
    const base = runSm();
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

/**
 * The per-row funding flag (`daPooled` on an override). Each row chooses
 * whether its own discretionary amount is funded FROM the pool — deducted
 * before anyone is scaled, so everyone else's scaled portion reflows — or sits
 * ON TOP of it, adding to the total and moving nobody through the scale.
 *
 * The fixture's VIC pool is genuinely oversubscribed, so vicScale is below 1
 * and there is real scale to move. NSW is pinned at 1 by NSW_FULL_ENTITLEMENT,
 * which is exactly why the redistribution cases below use VIC rows (A and B) —
 * see the last test, which pins that limitation down rather than hiding it.
 */
describe("daPooled: per-row discretionary funding", () => {
  function run(overrides: Overrides, caps: Caps = CAPS) {
    const emps = applyOverrides(FIXTURE, overrides);
    const pool = computeScalesAndBonuses(emps, caps);
    return { emps, pool, by: new Map(emps.map((e) => [e.id, e])) };
  }

  it("no row flagged is identical to the on-top model", () => {
    const bare = run({ A: { daEdit: 100 } });
    const explicit = run({ A: { daEdit: 100, daPooled: false } });
    for (const e of bare.emps) {
      expect(explicit.by.get(e.id)!.finalBonus).toBe(e.finalBonus);
    }
    expect(explicit.pool.vicScale).toBe(bare.pool.vicScale);
  });

  it("unflagged: the amount lands on top and moves nobody", () => {
    const base = run({});
    const granted = run({ A: { daEdit: 100 } });
    expect(granted.by.get("A")!.finalBonus).toBeCloseTo(
      base.by.get("A")!.finalBonus + 100,
      6
    );
    expect(granted.by.get("B")!.finalBonus).toBeCloseTo(
      base.by.get("B")!.finalBonus,
      6
    );
    expect(granted.pool.vicScale).toBeCloseTo(base.pool.vicScale, 12);
  });

  it("flagged: the amount comes OUT of the other rows", () => {
    const base = run({});
    const granted = run({ A: { daEdit: 100, daPooled: true } });
    expect(granted.pool.vicScale).toBeLessThan(base.pool.vicScale);
    // B granted nothing and pays part of it
    expect(granted.by.get("B")!.finalBonus).toBeLessThan(
      base.by.get("B")!.finalBonus
    );
    // the VIC pool total does not rise: the grant was funded, not added
    const vicTotal = (r: ReturnType<typeof run>) =>
      r.emps.reduce((s, e) => s + getVicAlloc(e, r.pool), 0);
    expect(vicTotal(granted)).toBeCloseTo(vicTotal(base), 6);
  });

  it("flagged: Final is the scaled figure, the amount already inside it", () => {
    const a = run({ A: { daEdit: 100, daPooled: true } }).by.get("A")!;
    // the "Calc bonus + Discretionary = Final" identity deliberately does not
    // hold on a flagged row — the scale already paid for the amount
    expect(a.finalBonus).toBe(a.calcBonus);
  });

  it("unflagged keeps the Calc + Discretionary = Final identity", () => {
    const a = run({ A: { daEdit: 100 } }).by.get("A")!;
    expect(a.finalBonus).toBeCloseTo(a.calcBonus + 100, 6);
  });

  it("mixed: one flagged, one on top — only the flagged one is absorbed", () => {
    const base = run({});
    const mixed = run({
      A: { daEdit: 100, daPooled: true },
      B: { daEdit: 100 },
    });
    // B's own amount is on top, so B ends up above its baseline...
    const bBase = base.by.get("B")!.finalBonus;
    expect(mixed.by.get("B")!.finalBonus).toBeGreaterThan(bBase);
    // ...but its SCALED portion fell, so it is NOT baseline + 100. This is the
    // "on top is not immune" semantic: A's flagged grant moved the scale under
    // everyone, B included.
    expect(mixed.by.get("B")!.finalBonus).toBeLessThan(bBase + 100);
    expect(mixed.pool.vicScale).toBeLessThan(base.pool.vicScale);
  });

  it("un-flagging hands the money back to the team", () => {
    const flagged = run({ A: { daEdit: 100, daPooled: true } });
    const onTop = run({ A: { daEdit: 100 } });
    expect(onTop.pool.vicScale).toBeGreaterThan(flagged.pool.vicScale);
    expect(onTop.by.get("B")!.finalBonus).toBeGreaterThan(
      flagged.by.get("B")!.finalBonus
    );
  });

  it("flipping the flag alone, amount unchanged, moves other rows", () => {
    const before = run({ A: { daEdit: 100 } });
    const after = run({ A: { daEdit: 100, daPooled: true } });
    expect(after.by.get("A")!.daEdit).toBe(before.by.get("A")!.daEdit);
    expect(after.by.get("B")!.finalBonus).not.toBeCloseTo(
      before.by.get("B")!.finalBonus,
      6
    );
  });

  it("getMaxDA bounds each row by its OWN mode, in one population", () => {
    const { emps, pool, by } = run({ A: { daPooled: true } });
    // the fixture starts with no room under the group cap, so the cap-measured
    // bound is ~0 — but a flagged row is self-funding, so its pool bound is real
    const flagged = getMaxDA(by.get("A")!, emps, CAPS, pool);
    const onTop = getMaxDA(by.get("B")!, emps, CAPS, pool);
    expect(flagged).toBeGreaterThan(0);
    expect(flagged).toBeGreaterThan(onTop);
  });

  it("a site manager is outside the pool under either mode", () => {
    const flagged = run({ C: { daEdit: 50, daPooled: true } });
    const onTop = run({ C: { daEdit: 50 } });
    expect(flagged.by.get("C")!.calcBonus).toBe(onTop.by.get("C")!.calcBonus);
  });

  it("flagging never becomes a cap override on a pinned pool", () => {
    // Owner decision, 24 Aug 2026. D draws only on NSW and nswScale is pinned,
    // so nobody funds a flagged amount there — it must stay bounded by the
    // CAPS, exactly as an on-top amount is, rather than by the NSW pool. If
    // this ever starts returning the pool figure, a flagged NSW row can spend
    // past the group cap and take money from no one.
    const flagged = run({ D: { daPooled: true } });
    const onTop = run({});
    expect(
      getMaxDA(flagged.by.get("D")!, flagged.emps, CAPS, flagged.pool)
    ).toBe(getMaxDA(onTop.by.get("D")!, onTop.emps, CAPS, onTop.pool));

    // VIC keeps the pool bound, where the grant genuinely is self-funding
    const vic = run({ A: { daPooled: true } });
    expect(getMaxDA(vic.by.get("A")!, vic.emps, CAPS, vic.pool)).toBeGreaterThan(
      getMaxDA(onTop.by.get("A")!, onTop.emps, CAPS, onTop.pool)
    );
  });

  it("a pinned pool cannot redistribute: flagging an NSW-only row moves nobody", () => {
    // D draws only on NSW (vp 0, np 1) and NSW_FULL_ENTITLEMENT pins nswScale
    // at 1, so there is no scale left to move. Flagging D folds its amount into
    // calcBonus but reduces no one — the documented limitation, asserted so it
    // cannot regress silently into a surprise.
    const base = run({});
    const flagged = run({ D: { daEdit: 100, daPooled: true } });
    expect(flagged.pool.nswScale).toBe(base.pool.nswScale);
    const d = flagged.by.get("D")!;
    expect(d.finalBonus).toBe(d.calcBonus);
    expect(d.finalBonus).toBeCloseTo(base.by.get("D")!.finalBonus + 100, 6);
  });
});
