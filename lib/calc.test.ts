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
    // the pools themselves are still spent to the cent, DA excluded
    expect(totalVicAlloc(adj.emps, adj.pool)).toBeCloseTo(1000, 8);
    expect(totalNswAlloc(adj.emps, adj.pool)).toBeCloseTo(500, 8);
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

  it("a zero-weight employee's final is exactly their DA", () => {
    const base = run();
    const adj = run({ F: { daEdit: 500 } });
    expect(adj.byId.F.calcBonus).toBe(0);
    expect(adj.byId.F.finalBonus).toBe(500);
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
    // the row that caused it can hold what it holds and no more, so the
    // figure stays correctable rather than being dragged down (see clampDa)
    expect(getMaxDA(crowded.byId.A, crowded.emps, CAPS)).toBe(0);
  });
});

describe("a site manager's discretionary rides on the fixed bonus (24 Aug 2026)", () => {
  it("final = fixed bonus + DA, with the pool untouched", () => {
    const base = run();
    const adj = run({ C: { daEdit: 100 } });
    // the fixed bonus itself never scales; the DA sits on top of it
    expect(adj.byId.C.calcBonus).toBeCloseTo(200, 10);
    expect(adj.byId.C.finalBonus).toBeCloseTo(300, 10);
    // the pool pays nothing for it: their fixed bonus comes off the top as
    // always, and their DA sits outside the pool like everyone else's
    expect(adj.pool.vicScale).toBeCloseTo(base.pool.vicScale, 12);
    expect(adj.pool.nswScale).toBeCloseTo(base.pool.nswScale, 12);
    expect(adj.byId.A.finalBonus).toBeCloseTo(base.byId.A.finalBonus, 12);
    expect(totalVicAlloc(adj.emps, adj.pool)).toBeCloseTo(1000, 6);
    // it does land on their state's total, like any other grant
    expect(cardTotal(adj.emps, "VIC") - cardTotal(base.emps, "VIC")).toBeCloseTo(100, 8);
  });

  it("a negative DA lowers them and their pool's total, and frees nothing", () => {
    const base = run();
    const adj = run({ C: { daEdit: -50 } });
    expect(adj.byId.C.finalBonus).toBeCloseTo(150, 10);
    expect(adj.pool.vicScale).toBeCloseTo(base.pool.vicScale, 12);
    expect(adj.byId.B.finalBonus).toBeCloseTo(base.byId.B.finalBonus, 12);
    expect(cardTotal(adj.emps, "VIC") - cardTotal(base.emps, "VIC")).toBeCloseTo(-50, 8);
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
    // total sits exactly on gCap, so nothing can be granted at all. This is
    // the real dataset's position (gCap === vCap + nCap, both pools spent):
    // raising a state cap alone does not create room for a grant.
    const base = run();
    expect(Math.floor(1000 - cardTotal(base.emps, "VIC"))).toBe(104);
    expect(cardTotal(base.emps)).toBeCloseTo(1500, 8);
    expect(getMaxDA(base.byId.A, base.emps, CAPS)).toBe(0);
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
    expect(pool.vicScale).toBeCloseTo(0.6717823483284814, 12);
    expect(pool.nswScale).toBeCloseTo(0.7820525079336984, 12);
    const totFinal = emps.reduce((s, e) => s + e.finalBonus, 0);
    expect(totFinal).toBeCloseTo(2621822.75, 6);
    // the pools are spent to the cent; the group total exceeds gCap by exactly
    // the one stored discretionary amount, which is what "on top" means
    expect(totFinal - data.gCap).toBeCloseTo(3000, 6);
    expect(totalVicAlloc(emps, pool)).toBeCloseTo(1580414.5, 6);
    expect(totalNswAlloc(emps, pool)).toBeCloseTo(1038408.25, 6);
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
    const { emps, byId } = run({ C: { locked: true, lockedFinal: 50 } });
    expect(getMaxDA(byId.C, emps, CAPS)).toBe(0);
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
