import { describe, it, expect } from "vitest";
import { clampDa } from "./da-impact";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Employee, Overrides } from "./schema";
import {
  applyOverrides,
  computeScalesAndBonuses,
  getVicAlloc,
  getNswAlloc,
  floorCents,
  getMaxDA,
  inStateHomeTotal,
  isCarveFunded,
  isIpmEditable,
  deriveCpm,
  isDaEditable,
  rowRule,
  isLockable,
  liveCarve,
  stateHomeTotal,
  parsePercentInput,
  parseDaInput,
  poolCardTotals,
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

/**
 * WHAT E COSTS EACH STATE BOUND. E is Shared Services on a 60/40 split, so from
 * 28 August 2026 their payout is carved off both state caps before anything is
 * measured against them (lib/calc.ts's stateBoundCap). Hand-computable: at the
 * roomy caps every scale clamps to 1 and E is paid their full 200, so VIC
 * carries 120 of it and NSW 80. Subtracted from the expectations below, which
 * is what makes the arithmetic still readable rather than a pasted figure.
 */
const E_CARVE = { vic: 120, nsw: 80 } as const;

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

function runSm(overrides: Overrides = {}, caps: Caps = CAPS) {
  const emps = applyOverrides(FIXTURE_NSW_SM, overrides);
  const pool = computeScalesAndBonuses(emps, caps);
  const byId = Object.fromEntries(emps.map((e) => [e.id, e]));
  return { emps, pool, byId, caps };
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

describe("lock is protection-only, not an allocation input", () => {
  // Lock B at its baseline final (521.739…) as the prototype's lock button does.
  // B is pure-VIC (vp=1, np=0), so its raw-vp/np split and the FY26
  // no-locks-scale-weighted split agree exactly here — the two only diverge
  // for a *blended* locked employee (see the "blended locked employee" tests
  // further down).
  const bFinal = 600 * (800 / 920);

  it("a lock freezes the row but leaves scale and others unchanged", () => {
    const locked = run({
      B: { locked: true, lockedFinal: bFinal },
      A: { daEdit: 100 },
    });
    const unlocked = run({ A: { daEdit: 100 } });
    expect(locked.byId.B.finalBonus).toBeCloseTo(bFinal, 10);
    expect(locked.pool.vicScale).toBeCloseTo(unlocked.pool.vicScale, 10);
    expect(locked.pool.nswScale).toBeCloseTo(unlocked.pool.nswScale, 10);
    expect(locked.byId.A.finalBonus).toBeCloseTo(unlocked.byId.A.finalBonus, 10);
    expect(locked.byId.E.finalBonus).toBeCloseTo(unlocked.byId.E.finalBonus, 10);
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

  it("unlocking itself is also number-neutral", () => {
    const locked = run({ B: { locked: true, lockedFinal: bFinal }, A: { daEdit: 100 } });
    const unlocked = run({ A: { daEdit: 100 } });
    expect(unlocked.pool.vicScale).toBeCloseTo(locked.pool.vicScale, 10);
    expect(unlocked.byId.A.finalBonus).toBeCloseTo(locked.byId.A.finalBonus, 10);
    expect(unlocked.byId.E.finalBonus).toBeCloseTo(locked.byId.E.finalBonus, 10);
  });

  it("a DA left on a row that is then locked is inert: the frozen final already holds it", () => {
    // B locked at a frozen figure that (say) included a DA at lock time, with
    // the stale daEdit still stored in the override. Only the frozen figure
    // counts — it is deducted once, and the stale amount is not paid again.
    const adj = run({ B: { locked: true, lockedFinal: 500, daEdit: 100 } });
    expect(adj.byId.B.finalBonus).toBe(500);
    // Locking no longer feeds pool deductions: scale and pool aggregation stay
    // on live entitlement draw.
    expect(adj.pool.vicScale).toBeCloseTo(800 / 920, 10);
    expect(adj.pool.poolAgg.empLockedVp).toBeCloseTo(200, 10);
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
    const unlocked = run({ A: { daEdit: 100 } });
    expect(adj.pool.vicScale).toBeCloseTo(unlocked.pool.vicScale, 8);
    expect(adj.byId.A.finalBonus).toBeCloseTo(
      200 * adj.pool.vicScale + 100,
      8
    );
    expect(adj.byId.E.finalBonus).toBeCloseTo(eFinal, 8);
  });
});

describe("a blended locked employee does not enter pool deductions", () => {
  it("contributes no locked draw in either state", () => {
    const bigNCap: Caps = { vCap: 1000, nCap: 100_000, gCap: 101_000 };
    const eFinal = 500; // an arbitrary frozen figure for this scenario
    const pool = computeScalesAndBonuses(
      applyOverrides(FIXTURE, { E: { locked: true, lockedFinal: eFinal } }),
      bigNCap
    );
    // Only C (the site manager) contributes to empLockedVp in this fixture.
    expect(pool.poolAgg.empLockedVp).toBeCloseTo(200, 8);
    expect(pool.poolAgg.empLockedNp).toBeCloseTo(0, 8);
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

  it("a VIC site manager's stored amount and lock ARE paid — the boundary is the write, not the engine (26 Aug 2026)", () => {
    // Until 26 Aug 2026 the engine dropped these itself, against a figure
    // stranded by a rule change. Now a VIC site manager can only carry one if
    // an admin holding the grant wrote it, and /api/state's gate 2
    // (lib/scheme-gate.ts) reverts anyone else's attempt to the stored value —
    // so what is stored is what is paid, whoever is looking.
    const base = run();
    const adj = run({ C: { daEdit: 100 } }); // C is a VIC site manager
    expect(adj.byId.C.daEdit).toBe(100);
    expect(adj.byId.C.finalBonus).toBeCloseTo(300, 10);
    // on top of the pool, as for everyone: the scale does not move
    expect(adj.pool.vicScale).toBeCloseTo(base.pool.vicScale, 12);
    // a lock is honoured too, and moves no money on its own
    const frozen = run({ C: { locked: true } });
    expect(frozen.byId.C.locked).toBe(true);
    expect(frozen.byId.C.finalBonus).toBeCloseTo(200, 10);
    // a row drawing from no pool is still stripped: there is nothing to pay it against
    const none = run({ F: { daEdit: 100, locked: true } });
    expect(none.byId.F.daEdit).toBe(0);
    expect(none.byId.F.locked).toBe(false);
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
    expect(max(r, "A")).toBe(99_000 - E_CARVE.vic);
  });

  it("at exactly the ceiling the card lands on its cap, and one dollar more passes it", () => {
    const atMax = roomy({ A: { daEdit: 99_000 } });
    expect(cardTotal(atMax.emps, "VIC")).toBeCloseTo(100_000, 8);
    expect(max(atMax, "B")).toBe(-E_CARVE.vic); // and the card has nothing left for anyone
    const over = roomy({ A: { daEdit: 99_001 } });
    expect(cardTotal(over.emps, "VIC")).toBeGreaterThan(100_000);
  });

  it("does not move as the field fills up: it is what the field may HOLD", () => {
    // the clamp compares the whole requested figure against this, so the
    // ceiling has to be an absolute amount rather than a remaining increase
    const r = roomy({ A: { daEdit: 500 } });
    expect(max(r, "A")).toBe(99_000 - E_CARVE.vic);
    // ...while everyone else on the card has 500 less room than before
    expect(max(r, "B")).toBe(98_500 - E_CARVE.vic);
  });

  it("Shared Services has no cap of its own, so only the group bound applies", () => {
    const r = roomy();
    // group holds 1,700 of 200,000
    expect(cardTotal(r.emps)).toBeCloseTo(1700, 10);
    expect(max(r, "E")).toBe(198_300);
  });

  it("a site manager is bounded exactly like anyone else on their card", () => {
    expect(max(roomy(), "C")).toBe(99_000 - E_CARVE.vic);
  });

  it("a locked row is bounded by the caps like any other, and a no-pool row not at all", () => {
    // This used to answer 0 for a locked row, whatever the caps had left. That
    // refused a real grant: with $145,904 of VIC room, changing an
    // already-locked row's amount came back "at most $0 can be granted",
    // because the row was locked before the save and after it. A payout is a
    // stored figure the lock does not touch, so the caps are the only bound.
    const r = roomy({ B: { locked: true, lockedFinal: 500 } });
    expect(max(r, "B")).toBeGreaterThan(90_000);
    expect(max(r, "F")).toBe(Infinity); // no pool, so no cap to overrun
    expect(max(r, "A")).toBe(99_100 - E_CARVE.vic);
  });

  it("bounds a row identically however its lock moves in the save", () => {
    // the regression in one line: locking, unlocking and leaving it alone all
    // measure the same room, because none of them moves an amount
    const unlocked = roomy();
    const locking = roomy({ A: { locked: true } });
    expect(max(locking, "A")).toBe(max(unlocked, "A"));
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
    // lift the group cap alone and the state cap becomes the binding one —
    // to the cent (104.34 of room), since 26 Aug 2026
    const lifted: Caps = { ...CAPS, gCap: 10_000 };
    expect(getMaxDA(base.byId.A, base.emps, lifted)).toBe(
      floorCents(1000 - liveCarve("VIC", base.emps).total - cardTotal(base.emps, "VIC"))
    );
    // 104.34 under the raw cap, less E's VIC share which is carved off first
    expect(getMaxDA(base.byId.A, base.emps, lifted)).toBeCloseTo(
      104.34 - liveCarve("VIC", base.emps).total,
      2
    );
  });
});

/**
 * The bound a SCOPED LEAD is judged by (owner decision, 25 Aug 2026, after a
 * lead was refused a $246,000 grant by a cap they are not shown).
 *
 * The block above ends on the reason: with gCap only vCap + nCap, the group
 * bound is tighter than either state bound by the whole Shared Services total,
 * so it refused everything, everywhere, for everyone. An admin owns that cap
 * and can raise it; a lead is never even sent it (lib/scope-core.ts). So a
 * lead is bounded by their home state alone, and the group overrun surfaces on
 * the admin's group card instead.
 */
describe("getMaxDA under CapBound 'state' (what bounds a scoped lead)", () => {
  it("ignores the group cap, so a lead may spend their state's room", () => {
    const base = run();
    // the very case the block above pins: nothing grantable under "both"...
    expect(getMaxDA(base.byId.A, base.emps, CAPS)).toBe(-80);
    // ...while VIC's own card still has 104.34 of room, which is now A's ceiling
    expect(getMaxDA(base.byId.A, base.emps, CAPS, "state")).toBe(
      floorCents(1000 - liveCarve("VIC", base.emps).total - cardTotal(base.emps, "VIC"))
    );
  });

  it("defaults to 'both', so a caller that has not thought about it is stricter", () => {
    const base = run();
    expect(getMaxDA(base.byId.A, base.emps, CAPS)).toBe(
      getMaxDA(base.byId.A, base.emps, CAPS, "both")
    );
  });

  it("leaves a Shared Services row unbounded, since it has no state cap", () => {
    // Under "both" the group cap is E's only bound; remove it and there is no
    // cap left to overrun. Infinity is honest rather than permissive: gate 4
    // skips a non-finite ceiling and the lead's own pool (poolBreach) binds.
    const base = run();
    expect(getMaxDA(base.byId.E, base.emps, CAPS)).toBe(-80);
    expect(getMaxDA(base.byId.E, base.emps, CAPS, "state")).toBe(Infinity);
  });

  it("keeps every other rule: a no-pool row has no bound, a locked row has the cap's", () => {
    const r = run({ B: { locked: true, lockedFinal: 500 } });
    expect(getMaxDA(r.byId.F, r.emps, CAPS, "state")).toBe(Infinity);
    // the lock is not a bound under either CapBound — only the caps are, so a
    // locked row gets whatever its state card has left, exactly as A does
    expect(getMaxDA(r.byId.B, r.emps, CAPS, "state")).toBe(
      getMaxDA(r.byId.A, r.emps, CAPS, "state")
    );
  });

  it("still refuses once the state's OWN card is full", () => {
    // the bound is relaxed, not removed — a lead cannot overrun their state
    const full = run({ A: { daEdit: 104 } });
    // 34¢ of room is left: nothing a whole-dollar grant can take
    const room = getMaxDA(full.byId.B, full.emps, CAPS, "state");
    // 34¢ under the raw cap, but E's VIC share is carved off it first, so the
    // room is that much further under — still nothing a whole dollar can take.
    expect(room).toBeCloseTo(0.34 - liveCarve("VIC", full.emps).total, 2);
    expect(clampDa(1, 0, room)).toEqual({ value: 0, clamped: true });
  });
});

/**
 * FY26: the caps may carry a carve-out (Caps.vCarve / nCarve, attached by
 * lib/fy26-caps.ts's attachFy26Carves) that the state bound nets off. Every
 * fixture above leaves the fields absent and so binds at the raw cap — these
 * pin what attaching one does, and what it must NOT touch.
 */
describe("a carve-out tightens the state bound by exactly the carve", () => {
  const ROOM: Caps = { vCap: 100_000, nCap: 100_000, gCap: 200_000 };
  // vCarve/nCarve are the TEST SEAM (lib/calc.ts's stateBoundCap): they pin a
  // carve instead of deriving one from the rows. The comparison side pins ZERO
  // rather than leaving it unset, so the pair differs by the carve alone and
  // not also by E's live share.
  const UNCARVED: Caps = { ...ROOM, vCarve: 0, nCarve: 0 };
  const CARVED: Caps = { ...ROOM, vCarve: 25_000, nCarve: 10_000 };
  function roomy(caps: Caps, overrides: Overrides = {}) {
    const emps = applyOverrides(FIXTURE, overrides);
    computeScalesAndBonuses(emps, caps);
    const byId = Object.fromEntries(emps.map((e) => [e.id, e]));
    return { emps, byId };
  }

  it("a VIC row's ceiling drops by the VIC carve, under either CapBound", () => {
    const raw = roomy(UNCARVED);
    const carved = roomy(CARVED);
    for (const bound of ["both", "state"] as const) {
      expect(getMaxDA(carved.byId.A, carved.emps, CARVED, bound)).toBe(
        getMaxDA(raw.byId.A, raw.emps, UNCARVED, bound) - 25_000
      );
    }
    // the raw figure is the 99,000 pinned above; the carved one is 74,000
    expect(getMaxDA(carved.byId.A, carved.emps, CARVED, "state")).toBe(74_000);
  });

  it("the scales do not move: a carve is a bound, not an engine input", () => {
    const raw = roomy(ROOM);
    const carved = roomy(CARVED);
    for (const id of Object.keys(raw.byId)) {
      expect(carved.byId[id].finalBonus).toBe(raw.byId[id].finalBonus);
    }
  });

  it("a Shared Services row is untouched — the group cap carries no carve", () => {
    const raw = roomy(ROOM);
    const carved = roomy(CARVED);
    expect(getMaxDA(carved.byId.E, carved.emps, CARVED)).toBe(
      getMaxDA(raw.byId.E, raw.emps, ROOM)
    );
    expect(getMaxDA(carved.byId.E, carved.emps, CARVED, "state")).toBe(Infinity);
  });

  it("when the carved state cap binds tighter than the group cap, it is the one reported", () => {
    // group room is 200,000 − Σ all; VIC room under the carve is 75,000 − others
    const carved = roomy(CARVED);
    const groupRoom = 200_000 - (cardTotal(carved.emps) - carved.byId.A.daEdit);
    const stateRoom = 75_000 - (cardTotal(carved.emps, "VIC") - carved.byId.A.daEdit);
    expect(stateRoom).toBeLessThan(groupRoom);
    expect(getMaxDA(carved.byId.A, carved.emps, CARVED)).toBe(floorCents(stateRoom));
  });

  it("a stored total past the carved cap reads as no room, even though it is under the raw cap", () => {
    const tight: Caps = { ...ROOM, vCarve: 99_500 }; // binding VIC cap 500 vs 1,000 on the card
    const r = roomy(tight);
    expect(cardTotal(r.emps, "VIC")).toBeCloseTo(1000, 10);
    // the card holds 1,000 and A's own daEdit is 0, so nothing backs out:
    // 500 − 1,000 — negative, honestly "no room at all"
    expect(getMaxDA(r.byId.A, r.emps, tight, "state")).toBe(-500);
    expect(getMaxDA(r.byId.A, r.emps, ROOM, "state")).toBe(99_000 - E_CARVE.vic);
  });
});

/**
 * FY26: a row whose cost splits across both pools is CARVE-FUNDED — its money
 * comes out of the state pool before the pool is struck (lib/fy26-caps.ts), so
 * it must never also be measured against that pool. The four part-split staff
 * have been st = "VIC" since 24 Aug 2026; counting their whole payouts in the
 * VIC home total charged the pool for them twice.
 */
describe("carve-funded rows do not count against a state pool", () => {
  const ROOM: Caps = { vCap: 100_000, nCap: 100_000, gCap: 200_000 };
  // P: VIC-labelled, on their own split — the shape of Clements/Fairclough/Wali/Porter
  const P = makeEmp({ id: "P", st: "VIC", vp: 0.9, np: 0.1, bipm: 300, pkg: 3000 });
  function roomy(rows: Employee[], overrides: Overrides = {}) {
    const emps = applyOverrides(rows, overrides);
    computeScalesAndBonuses(emps, ROOM);
    const byId = Object.fromEntries(emps.map((e) => [e.id, e]));
    return { emps, byId };
  }

  it("the predicates: any split is carve-funded; only a VIC/NSW split is left out of a home total", () => {
    expect(isCarveFunded(P)).toBe(true);
    expect(isCarveFunded(FIXTURE[4])).toBe(true); // E, SHARED 0.6/0.4
    expect(isCarveFunded(FIXTURE[0])).toBe(false); // A, wholly VIC
    expect(isCarveFunded(FIXTURE[5])).toBe(false); // F, no pool at all
    expect(inStateHomeTotal(P)).toBe(false);
    expect(inStateHomeTotal({ ...P, st: "NSW" })).toBe(false);
    expect(inStateHomeTotal(FIXTURE[4])).toBe(true); // SHARED is never in a home total anyway
    expect(inStateHomeTotal(FIXTURE[0])).toBe(true);
  });

  it("a whole-pool VIC row's ceiling is narrowed by the carve-funded row's VIC SHARE, not its whole payout", () => {
    const with_ = roomy([...FIXTURE, P]);
    const without = roomy(FIXTURE);
    expect(with_.byId.P.finalBonus).toBeGreaterThan(0);
    // the card's whole-payout total DOES include P...
    expect(cardTotal(with_.emps, "VIC")).toBeCloseTo(cardTotal(without.emps, "VIC") + with_.byId.P.finalBonus, 8);
    // ...and P is still out of the home total, but since 28 August 2026 the VIC
    // cap is carved by what P actually costs VIC — their vp share — instead of
    // by a frozen constant. So A's ceiling drops by that share and by no more:
    // P's NSW portion is NSW's problem, and P's whole payout never lands on VIC.
    const share = with_.byId.P.finalBonus * P.vp;
    for (const bound of ["both", "state"] as const) {
      expect(
        getMaxDA(without.byId.A, without.emps, ROOM, bound) -
          getMaxDA(with_.byId.A, with_.emps, ROOM, bound)
      ).toBeCloseTo(share, 6);
    }
    expect(getMaxDA(with_.byId.A, with_.emps, ROOM, "state")).toBe(
      floorCents(
        100_000 -
          liveCarve("VIC", with_.emps).total -
          (cardTotal(with_.emps, "VIC") - with_.byId.P.finalBonus)
      )
    );
  });

  it("the carve-funded row itself is bounded like Shared Services: group cap only", () => {
    const r = roomy([...FIXTURE, P]);
    expect(getMaxDA(r.byId.P, r.emps, ROOM, "state")).toBe(Infinity);
    expect(getMaxDA(r.byId.P, r.emps, ROOM, "both")).toBe(
      floorCents(200_000 - (cardTotal(r.emps) - r.byId.P.daEdit))
    );
    // and exactly as E, the SHARED split row, has always been
    expect(getMaxDA(r.byId.E, r.emps, ROOM, "state")).toBe(Infinity);
    expect(getMaxDA(r.byId.E, r.emps, ROOM, "both")).toBe(
      floorCents(200_000 - (cardTotal(r.emps) - r.byId.E.daEdit))
    );
  });

  it("a carve attached to the caps still nets off the whole-pool rows only", () => {
    const carved: Caps = { ...ROOM, vCarve: 25_000 };
    const r = roomy([...FIXTURE, P]);
    expect(getMaxDA(r.byId.A, r.emps, carved, "state")).toBe(
      floorCents(75_000 - (cardTotal(r.emps, "VIC") - r.byId.P.finalBonus))
    );
    expect(getMaxDA(r.byId.P, r.emps, carved, "state")).toBe(Infinity);
  });

  it("poolCardTotals reports the pool-facing home totals without the carve-funded rows", () => {
    const rows = [...FIXTURE, P, makeEmp({ id: "Q", st: "NSW", vp: 0.2, np: 0.8, bipm: 100, pkg: 1000 })];
    const emps = applyOverrides(rows, {});
    const pool = computeScalesAndBonuses(emps, ROOM);
    const t = poolCardTotals(emps, pool, ROOM);
    const byId = Object.fromEntries(emps.map((e) => [e.id, e]));
    expect(t.vicHome).toBeCloseTo(cardTotal(emps, "VIC") - byId.P.finalBonus, 10);
    expect(t.nswHome).toBeCloseTo(cardTotal(emps, "NSW") - byId.Q.finalBonus, 10);
    // the whole-payout grouping and its identity are untouched
    expect(t.vic + t.vicOther).toBeCloseTo(cardTotal(emps, "VIC"), 10);
    expect(t.nsw + t.nswOther).toBeCloseTo(cardTotal(emps, "NSW"), 10);
    // and with no VIC/NSW split row the two definitions coincide
    const plain = run();
    const tp = poolCardTotals(plain.emps, plain.pool, CAPS);
    expect(tp.vicHome).toBeCloseTo(cardTotal(plain.emps, "VIC"), 10);
    expect(tp.nswHome).toBeCloseTo(cardTotal(plain.emps, "NSW"), 10);
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
    // decimals survive: an IPM can be 87.5%
    expect(parsePercentInput("87.5")).toBe(0.875);
    expect(parsePercentInput("87.5%")).toBe(0.875);
    expect(parsePercentInput("0.875")).toBe(0.875);
    expect(parsePercentInput("12.25 %")).toBe(0.1225);
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
describe("a locked NSW site manager freezes payout without reallocating others", () => {
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

  it("freezing the manager does not move scale or other rows", () => {
    const base = runSm();
    const frozen = runSm({ C: { locked: true, lockedFinal: 150 } });
    expect(frozen.pool.vicScale).toBeCloseTo(base.pool.vicScale, 10);
    expect(frozen.byId.A.finalBonus).toBeCloseTo(base.byId.A.finalBonus, 10);
    expect(frozen.byId.B.finalBonus).toBeCloseTo(base.byId.B.finalBonus, 10);
  });

  it("freezing far below live leaves allocation math unchanged", () => {
    const { emps, pool } = runSm({ C: { locked: true, lockedFinal: 50 } });
    expect(pool.vicScale).toBeCloseTo(800 / 920, 10);
    expect(totalVicAlloc(emps, pool)).toBeCloseTo(1000, 8);
  });

  it("getVicAlloc/getNswAlloc stay on live allocation draw", () => {
    const { byId, pool } = runSm({ C: { locked: true, lockedFinal: 50 } });
    expect(getVicAlloc(byId.C, pool)).toBeCloseTo(200, 10);
    expect(getNswAlloc(byId.C, pool)).toBeCloseTo(0, 10);
  });

  it("a frozen site manager is bounded by the caps, not by the lock", () => {
    // -50 rather than 0: this fixture's group total is 50 past gCap, so the
    // honest answer is that there is no room — and it is the CAP saying so, not
    // the lock. A locked row used to be told 0 whatever the caps had left.
    const { emps, byId } = runSm({ C: { locked: true, lockedFinal: 50 } });
    // C is the NSW site manager, so it is NSW's carve that narrows their bound
    expect(getMaxDA(byId.C, emps, CAPS)).toBe(floorCents(-50 - liveCarve("NSW", emps).total));
    // with room, the same frozen row has real headroom
    const roomy = runSm({ C: { locked: true, lockedFinal: 50 } }, {
      vCap: 100_000,
      nCap: 100_000,
      gCap: 200_000,
    });
    expect(getMaxDA(roomy.byId.C, roomy.emps, roomy.caps)).toBeGreaterThan(0);
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

  it("a VIC site manager IS, for a caller holding the grant (26 Aug 2026) — and nothing else changes", () => {
    const grant = { vicSiteManagers: true };
    expect(isLockable({ sm: 1, st: "VIC", inPool: true }, grant)).toBe(true);
    expect(isLockable({ sm: 1, st: "NSW", inPool: true }, grant)).toBe(true);
    expect(isLockable({ sm: 1, st: "SHARED", inPool: true }, grant)).toBe(false);
    expect(isLockable({ sm: 1, st: "VIC", inPool: false }, grant)).toBe(false);
    expect(isLockable({ sm: 0, st: "VIC", inPool: true }, grant)).toBe(true);
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

  it("…unless the caller holds the VIC site managers grant (26 Aug 2026)", () => {
    const grant = { vicSiteManagers: true };
    expect(isDaEditable({ sm: 1, st: "VIC", inPool: true }, grant)).toBe(true);
    expect(isDaEditable({ sm: 1, st: "SHARED", inPool: true }, grant)).toBe(false);
    expect(isDaEditable({ sm: 1, st: "VIC", inPool: false }, grant)).toBe(false);
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
          for (const allow of [{ vicSiteManagers: false }, { vicSiteManagers: true }]) {
            expect(isDaEditable({ sm, st, inPool }, allow)).toBe(
              isLockable({ sm, st, inPool }, allow)
            );
          }
        }
      }
    }
  });
});

/**
 * IPM is editable for anyone in a pool — it only moves the advisory figure —
 * except for a SITE MANAGER, whose IPM re-prices their fixed bonus on save
 * (lib/reprice.ts) and is therefore gated exactly like their lock.
 */
describe("isIpmEditable", () => {
  const grant = { vicSiteManagers: true };
  it("anyone in a pool who is not a site manager, whatever the allowance", () => {
    for (const st of ["VIC", "NSW", "SHARED"] as const) {
      expect(isIpmEditable({ sm: 0, st, inPool: true })).toBe(true);
      expect(isIpmEditable({ sm: 0, st, inPool: true }, grant)).toBe(true);
    }
  });
  it("a site manager follows the lock rule: NSW yes, VIC only with the grant", () => {
    expect(isIpmEditable({ sm: 1, st: "NSW", inPool: true })).toBe(true);
    expect(isIpmEditable({ sm: 1, st: "VIC", inPool: true })).toBe(false);
    expect(isIpmEditable({ sm: 1, st: "VIC", inPool: true }, grant)).toBe(true);
    expect(isIpmEditable({ sm: 1, st: "SHARED", inPool: true }, grant)).toBe(false);
  });
  it("a row drawing from no pool has no IPM to speak of", () => {
    expect(isIpmEditable({ sm: 0, st: "VIC", inPool: false })).toBe(false);
    expect(isIpmEditable({ sm: 1, st: "NSW", inPool: false }, grant)).toBe(false);
  });
});

/**
 * There is ONE discretionary model in this engine: the amount sits on top of
 * the pool. Nothing selects a funding mode, per row or per scheme — a
 * redistribution is performed by writing amounts (lib/redistribute.ts), and the
 * engine never learns who took part.
 *
 * These are the properties that design rests on. Two funding-based designs were
 * tried and removed on 24 August 2026: both moved the state scale, which was
 * inert on NSW (nswScale is pinned at 1, so there was nothing to move) and
 * reached every lead in the state rather than the one making the decision.
 */
describe("a discretionary amount always sits on top of the pool", () => {
  function run(overrides: Overrides, caps: Caps = CAPS) {
    const emps = applyOverrides(FIXTURE, overrides);
    const pool = computeScalesAndBonuses(emps, caps);
    return { emps, pool, by: new Map(emps.map((e) => [e.id, e])) };
  }

  it("Calc + Discretionary = Final on every unlocked row", () => {
    const { by } = run({ A: { daEdit: 100 }, B: { daEdit: 250 } });
    for (const id of ["A", "B"]) {
      const r = by.get(id)!;
      expect(r.finalBonus).toBeCloseTo(r.calcBonus + r.daEdit, 6);
    }
  });

  it("moves nobody else, and moves no scale", () => {
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
    expect(granted.pool.vicScale).toBe(base.pool.vicScale);
    expect(granted.pool.nswScale).toBe(base.pool.nswScale);
  });

  it("is no part of the pool draw", () => {
    const vicTotal = (r: ReturnType<typeof run>) =>
      r.emps.reduce((s, e) => s + getVicAlloc(e, r.pool), 0);
    // an amount is not pool money, so the draw against the cap is untouched
    expect(vicTotal(run({ A: { daEdit: 100 } }))).toBeCloseTo(
      vicTotal(run({})),
      6
    );
  });

  it("lands the same on NSW as on VIC, which a funding model could not", () => {
    const base = run({});
    const vic = run({ A: { daEdit: 100 } });
    const nsw = run({ D: { daEdit: 100 } });
    expect(vic.by.get("A")!.finalBonus - base.by.get("A")!.finalBonus).toBeCloseTo(100, 6);
    expect(nsw.by.get("D")!.finalBonus - base.by.get("D")!.finalBonus).toBeCloseTo(100, 6);
  });
});

/**
 * THE LOCK CONTRACT (owner decision, 25 August 2026): locking or unlocking
 * somebody changes no amount, anywhere.
 *
 * It used to change plenty. A payout was read as `locked ? lockedFinal :
 * calc + discretionary`, so the flag chose between two figures that had drifted
 * apart — 44 of the 49 locked rows in the production capture moved when
 * unlocked, the worst by $15,529. A payout now has one source and the flag is
 * not in the expression, which is what these pin.
 */
describe("locking and unlocking move no money", () => {
  const finals = (overrides: Overrides) =>
    new Map(run(overrides).emps.map((e) => [e.id, e.finalBonus]));

  const unchanged = (a: Map<string, number>, b: Map<string, number>) => {
    for (const [id, v] of a) expect(b.get(id)).toBeCloseTo(v, 10);
  };

  it("locking a row leaves every figure exactly where it was", () => {
    unchanged(finals({}), finals({ B: { locked: true } }));
  });

  it("unlocking a row locked in this model leaves every figure alone", () => {
    const locked = { B: { locked: true } };
    unchanged(finals(locked), finals({ B: { locked: false } }));
  });

  it("a row frozen before the change keeps its stored payout through both", () => {
    // B's stored 400 is its base: not what the engine would pay it today
    // (521.74 at this scale), which is the whole point — the figure is stored,
    // so the flag cannot switch it back to a derived one.
    const frozen: Overrides = { B: { locked: true, lockedFinal: 400 } };
    expect(run(frozen).byId.B.finalBonus).toBeCloseTo(400, 10);
    const unlocked: Overrides = { B: { locked: false, lockedFinal: 400 } };
    expect(run(unlocked).byId.B.finalBonus).toBeCloseTo(400, 10);
    unchanged(finals(frozen), finals(unlocked));
  });

  it("keeps the discretionary amount separable on a frozen row", () => {
    // stored payout 500 with 100 of it discretionary: base is 400, so Final is
    // 500 either way and Calc + Discretionary still reconciles
    const frozen: Overrides = { B: { locked: true, lockedFinal: 500, daEdit: 100 } };
    expect(run(frozen).byId.B.finalBonus).toBeCloseTo(500, 10);
    unchanged(finals(frozen), finals({ B: { locked: false, lockedFinal: 500, daEdit: 100 } }));
  });

  it("nobody else moves either, in either direction", () => {
    const base = finals({});
    for (const id of ["A", "B", "D", "E"]) {
      const after = finals({ [id]: { locked: true } });
      for (const [other, v] of base) {
        if (other === id) continue;
        expect(after.get(other)).toBeCloseTo(v, 10);
      }
    }
  });

  it("an unpriced row is paid what the formula says it is owed", () => {
    // The last derivation in the payout path, and it is deliberate: every live
    // row carries a stored base, but /admin/snapshots can restore a document
    // taken before the field existed. Without this, such a restore would pay
    // everybody $0.
    const preSeed = run({ A: { daEdit: 100 } }); // no baseAmount anywhere
    expect(preSeed.byId.A.baseAmount).toBeUndefined();
    expect(preSeed.byId.A.finalBonus).toBeCloseTo(preSeed.byId.A.calcBonus + 100, 10);
    expect(preSeed.byId.B.finalBonus).toBeCloseTo(preSeed.byId.B.calcBonus, 10);
    // ...and a stored base takes precedence over it wherever there is one
    const priced = run({ A: { daEdit: 100, baseAmount: 1000 } });
    expect(priced.byId.A.finalBonus).toBeCloseTo(1100, 10);
  });

  it("an IPM edit moves the advisory figure and not the payout", () => {
    // the other half of the contract: amounts are stored, so recalculation is
    // never a side effect of an edit
    const frozen: Overrides = { B: { locked: true, lockedFinal: 400 } };
    const edited: Overrides = { B: { locked: true, lockedFinal: 400, ipmEdit: 0.5 } };
    expect(run(edited).byId.B.calcBonus).not.toBeCloseTo(run(frozen).byId.B.calcBonus, 2);
    expect(run(edited).byId.B.finalBonus).toBeCloseTo(400, 10);
  });
});

/**
 * The same contract on the real thing: every locked row in the production
 * capture, unlocked one at a time, must move nothing at all. This is the sweep
 * that would have caught the reported bug — it fails on 44 rows before the fix.
 */
const PROD_FIXTURE = join(__dirname, "..", "data", "prod-fixture.json");
describe.skipIf(!existsSync(PROD_FIXTURE))(
  "the lock contract holds across the production capture",
  () => {
    const raw = JSON.parse(readFileSync(PROD_FIXTURE, "utf-8"));
    const caps: Caps = {
      vCap: raw.params.vCap,
      nCap: raw.params.nCap,
      gCap: raw.params.gCap,
    };
    const price = (doc: Overrides) => {
      const emps = applyOverrides(raw.dataset.emp, doc);
      computeScalesAndBonuses(emps, caps);
      return new Map(emps.map((e) => [e.id, e.finalBonus]));
    };
    const stored: Overrides = raw.overrides;

    it("unlocking any locked row changes nothing for anyone", () => {
      const before = price(stored);
      const lockedIds = Object.entries(stored)
        .filter(([, ov]) => ov.locked)
        .map(([id]) => id);
      expect(lockedIds.length).toBeGreaterThan(40);
      for (const id of lockedIds) {
        const after = price({ ...stored, [id]: { ...stored[id], locked: false } });
        for (const [who, v] of before) expect(after.get(who)).toBeCloseTo(v, 6);
      }
    });
  }
);

/**
 * The admin pool cards (owner decision, 26 August 2026). FIXTURE: A/B are VIC
 * (wholly), C is a VIC site manager, D is NSW, E is SHARED split 60/40, F draws
 * from no pool at all.
 */
describe("poolCardTotals", () => {
  it("carries a shared row's payout into the state cards it is funded by", () => {
    const { emps, byId, pool } = run();
    const t = poolCardTotals(emps, pool, CAPS);
    // E is the only row funded from a cap it does not appear on
    expect(t.vicOther).toBeCloseTo(byId.E.finalBonus * 0.6, 10);
    expect(t.nswOther).toBeCloseTo(byId.E.finalBonus * 0.4, 10);
    // F has no pool exposure, so it contributes to neither
    expect(byId.F.finalBonus).toBe(0);
  });

  it("shows each state net of the money its own cap carries", () => {
    const { emps, byId, pool } = run();
    const t = poolCardTotals(emps, pool, CAPS);
    const vicHome = byId.A.finalBonus + byId.B.finalBonus + byId.C.finalBonus + byId.F.finalBonus;
    expect(t.vic).toBeCloseTo(vicHome - t.vicOther, 10);
    expect(t.nsw).toBeCloseTo(byId.D.finalBonus - t.nswOther, 10);
  });

  it("leaves Shared Services and the group total exactly as they were", () => {
    const { emps, byId, pool } = run();
    const t = poolCardTotals(emps, pool, CAPS);
    expect(t.shared).toBeCloseTo(byId.E.finalBonus, 10);
    expect(t.group).toBeCloseTo(cardTotal(emps), 10);
  });

  it("puts a VIC person's NSW share in nswOther and takes it out of nsw", () => {
    // the generalisation the `st !== ` form buys: nobody on the roster is like
    // this today, but if a VIC-home person is given an NSW share their NSW money
    // must land somewhere rather than vanishing
    const crossed = FIXTURE.map((e) =>
      e.id === "B" ? { ...e, vp: 0.5, np: 0.5 } : e
    );
    const emps = applyOverrides(crossed, {});
    const pool = computeScalesAndBonuses(emps, CAPS);
    const b = emps.find((e) => e.id === "B")!;
    const t = poolCardTotals(emps, pool, CAPS);
    // B is VIC-home, so its NSW half is money the NSW cap carries for a row
    // that never appears on the NSW card
    expect(t.nswOther).toBeCloseTo(
      b.finalBonus * 0.5 + emps.find((e) => e.id === "E")!.finalBonus * 0.4,
      10
    );
    // ...and B's VIC half is not in vicOther: B IS on the VIC card
    expect(t.vicOther).toBeCloseTo(emps.find((e) => e.id === "E")!.finalBonus * 0.6, 10);
    // ...but B is now carve-funded, so the figure the VIC POOL is measured
    // against leaves B out entirely, while the whole-payout grouping keeps B
    expect(t.vicHome).toBeCloseTo(cardTotal(emps, "VIC") - b.finalBonus, 10);
    expect(t.vic + t.vicOther).toBeCloseTo(cardTotal(emps, "VIC"), 10);
  });

  /** Σ payout over the rows the carried figures apportion. */
  const splitPayout = (emps: CalcEmployee[]) =>
    emps.reduce((s, e) => (e.vp > 0 && e.np > 0 ? s + e.finalBonus : s), 0);

  it("charges each cap the split payouts it carries, weighted by the scales", () => {
    const { emps, pool, byId } = run();
    const t = poolCardTotals(emps, pool, CAPS);
    // E is the fixture's only split row (0.6/0.4)
    const wVic = 0.6 * pool.vicScale;
    const wNsw = 0.4 * pool.nswScale;
    const fracVic = wVic / (wVic + wNsw);
    expect(t.vicPool).toBeCloseTo(CAPS.vCap - byId.E.finalBonus * fracVic, 8);
    expect(t.nswPool).toBeCloseTo(CAPS.nCap - byId.E.finalBonus * (1 - fracVic), 8);
    // and the weighting is NOT the raw split, because the scales differ
    expect(fracVic).not.toBeCloseTo(0.6, 3);
  });

  it("closes: the two headlines account for every dollar of split payout", () => {
    // vicCarried + nswCarried is exactly the split rows' payout, so this holds
    // by construction — a failure means money was lost or double-counted
    const { emps, pool } = run();
    const t = poolCardTotals(emps, pool, CAPS);
    expect(t.vicPool + t.nswPool).toBeCloseTo(
      CAPS.vCap + CAPS.nCap - splitPayout(emps),
      8
    );
  });

  it("apportions nothing for a row that draws on only one pool", () => {
    // A is wholly VIC and D wholly NSW: neither is carried by the other cap,
    // and neither is apportioned at all
    const { emps, pool, byId } = run();
    const t = poolCardTotals(emps, pool, CAPS);
    expect(splitPayout(emps)).toBeCloseTo(byId.E.finalBonus, 10);
    // F has no pool exposure either way, so it cannot be apportioned
    expect(byId.F.vp + byId.F.np).toBe(0);
    expect(t.vicPool + t.nswPool).toBeCloseTo(
      CAPS.vCap + CAPS.nCap - byId.E.finalBonus,
      8
    );
  });

  it("falls back to the raw split when both scales are zero", () => {
    // both caps at zero drives both scales to 0, so the weighting has nothing
    // to say — the payout must still be wholly attributed, on the raw split,
    // rather than landing entirely on NSW
    const zero: Caps = { vCap: 0, nCap: 0, gCap: 0 };
    const emps = applyOverrides(FIXTURE, {});
    const pool = computeScalesAndBonuses(emps, zero);
    expect(pool.vicScale).toBe(0);
    const t = poolCardTotals(emps, pool, zero);
    const e = emps.find((x) => x.id === "E")!;
    // nswScale is pinned at 1 (NSW_FULL_ENTITLEMENT), so force the degenerate
    // case directly rather than pretending the fixture can produce it
    const forced = poolCardTotals(emps, { ...pool, nswScale: 0 }, zero);
    expect(forced.vicPool).toBeCloseTo(0 - e.finalBonus * 0.6, 8);
    expect(forced.nswPool).toBeCloseTo(0 - e.finalBonus * 0.4, 8);
    expect(t.vicPool + t.nswPool).toBeCloseTo(-splitPayout(emps), 8);
  });

  it("leaves every pre-existing field exactly as it was", () => {
    // the additive guarantee: the new arguments changed no old figure
    const { emps, pool, byId } = run();
    const t = poolCardTotals(emps, pool, CAPS);
    expect(t.shared).toBeCloseTo(byId.E.finalBonus, 10);
    expect(t.group).toBeCloseTo(cardTotal(emps), 10);
    expect(t.vicOther).toBeCloseTo(byId.E.finalBonus * 0.6, 10);
    expect(t.nswOther).toBeCloseTo(byId.E.finalBonus * 0.4, 10);
    expect(t.vic).toBeCloseTo(cardTotal(emps, "VIC") - t.vicOther, 10);
    expect(t.nsw).toBeCloseTo(cardTotal(emps, "NSW") - t.nswOther, 10);
  });

  /**
   * Part-split staff: the split rows NOT on the corporate ratio, which is
   * inferred as the modal vp. The main FIXTURE has a single split row, so these
   * build their own — several on one ratio plus one differing.
   */
  describe("part-split staff", () => {
    const mk = (id: string, vp: number, bipm = 1000): Employee =>
      makeEmp({ id, st: "SHARED", vp, np: 1 - vp, bipm, pkg: bipm * 10 });
    /** four on 0.6 (corporate) and one on 0.9 (part-split) */
    const MIXED: Employee[] = [
      makeEmp({ id: "V", bipm: 500, pkg: 5000 }), // wholly VIC, not split
      mk("C1", 0.6), mk("C2", 0.6), mk("C3", 0.6), mk("C4", 0.6),
      mk("P1", 0.9, 2000),
    ];
    const ROOM: Caps = { vCap: 100_000, nCap: 100_000, gCap: 200_000 };
    function mixed(emp: Employee[] = MIXED, caps: Caps = ROOM) {
      const emps = applyOverrides(emp, {});
      const pool = computeScalesAndBonuses(emps, caps);
      return { emps, pool, caps, t: poolCardTotals(emps, pool, caps), byId: Object.fromEntries(emps.map((e) => [e.id, e])) };
    }
    const frac = (e: CalcEmployee, pool: PoolState) => {
      const wv = e.vp * pool.vicScale;
      const wn = e.np * pool.nswScale;
      return wv / (wv + wn);
    };

    it("counts only the rows off the corporate ratio", () => {
      const { t, pool, byId } = mixed();
      const p1 = byId.P1;
      expect(t.vicPartSplit).toBeCloseTo(p1.finalBonus * frac(p1, pool), 8);
      expect(t.nswPartSplit).toBeCloseTo(p1.finalBonus * (1 - frac(p1, pool)), 8);
      // the four on 0.6 are the corporate block and contribute nothing
      for (const id of ["C1", "C2", "C3", "C4"]) {
        expect(byId[id].finalBonus).toBeGreaterThan(0);
      }
    });

    it("attributes by the scales, not the raw split", () => {
      // needs a VIC pool under pressure: with room to spare both scales clamp
      // to 1 and the weighting degenerates to the raw split, which would make
      // this assertion vacuous
      const TIGHT: Caps = { vCap: 2000, nCap: 100_000, gCap: 200_000 };
      const { t, pool, byId } = mixed(MIXED, TIGHT);
      expect(pool.vicScale).toBeLessThan(1);
      const p1 = byId.P1;
      const weighted = frac(p1, pool);
      expect(weighted).not.toBeCloseTo(0.9, 2);
      expect(t.vicPartSplit).toBeCloseTo(p1.finalBonus * weighted, 8);
      // and emphatically not the figure the raw split would have given
      expect(t.vicPartSplit).not.toBeCloseTo(p1.finalBonus * 0.9, 2);
    });

    it("reports nothing when every split row shares one ratio", () => {
      const { t } = mixed(MIXED.filter((e) => e.id !== "P1"));
      expect(t.vicPartSplit).toBe(0);
      expect(t.nswPartSplit).toBe(0);
    });

    it("reports nothing when nobody splits at all", () => {
      const { t } = mixed([makeEmp({ id: "V", bipm: 500, pkg: 5000 })]);
      expect(t.vicPartSplit).toBe(0);
      expect(t.nswPartSplit).toBe(0);
    });

    it("ignores a row that draws on one pool only", () => {
      // V is wholly VIC: not in the split population, so it can never be
      // part-split however the ratios fall
      const { t, byId, pool } = mixed();
      expect(byId.V.np).toBe(0);
      const p1 = byId.P1;
      expect(t.vicPartSplit + t.nswPartSplit).toBeCloseTo(p1.finalBonus, 8);
      void pool;
    });

    it("breaks a tie deterministically rather than by iteration order", () => {
      // two ratios, two rows each, equal payouts: the lower vp is corporate, so
      // the higher one is what shows as part-split — and it does not flip when
      // the rows are fed in the opposite order
      const tie: Employee[] = [mk("A1", 0.5), mk("A2", 0.5), mk("B1", 0.8), mk("B2", 0.8)];
      const forward = mixed(tie);
      const backward = mixed([...tie].reverse());
      expect(forward.t.vicPartSplit).toBeCloseTo(backward.t.vicPartSplit, 10);
      expect(forward.t.nswPartSplit).toBeCloseTo(backward.t.nswPartSplit, 10);
      // 0.5 is corporate (lower vp wins the tie), so the 0.8 pair is part-split
      const eight = forward.emps.filter((e) => e.vp === 0.8);
      expect(forward.t.vicPartSplit + forward.t.nswPartSplit).toBeCloseTo(
        eight.reduce((s, e) => s + e.finalBonus, 0),
        8
      );
    });

    it("leaves every other field untouched", () => {
      const { t, emps } = mixed();
      const home = (st: string) => emps.reduce((s, e) => (e.st === st ? s + e.finalBonus : s), 0);
      expect(t.shared).toBeCloseTo(home("SHARED"), 10);
      expect(t.group).toBeCloseTo(emps.reduce((s, e) => s + e.finalBonus, 0), 10);
      expect(t.vic).toBeCloseTo(home("VIC") - t.vicOther, 10);
      expect(t.nsw).toBeCloseTo(home("NSW") - t.nswOther, 10);
      // and the headline pair still closes over the WHOLE split population
      const splitTotal = emps.reduce((s, e) => (e.vp > 0 && e.np > 0 ? s + e.finalBonus : s), 0);
      expect(t.vicPool + t.nswPool).toBeCloseTo(ROOM.vCap + ROOM.nCap - splitTotal, 8);
    });
  });

  it("is display only: it never reports a figure a cap is enforced against", () => {
    // the cap is enforced on Σ payout by HOME state, which is the net figure
    // plus what the cap carries — the identity the cards' footers rely on
    const { emps, pool } = run();
    const t = poolCardTotals(emps, pool, CAPS);
    const vicHome = cardTotal(emps, "VIC");
    expect(t.vic + t.vicOther).toBeCloseTo(vicHome, 10);
    expect(t.nsw + t.nswOther).toBeCloseTo(cardTotal(emps, "NSW"), 10);
  });
});


/**
 * The STORED Scale Factor, and ISSUED rows — the two additions of 27 August
 * 2026. Both are absence-defaulted: with no stored scale and no issue stamp
 * every figure in this file, and every figure in the golden baseline, is what
 * it always was.
 */
describe("a stored Scale Factor", () => {
  function emp(over: Partial<Employee> & { id: string }): Employee {
    return {
      sn: "S", gn: over.id, pos: "P", dept: "D", mgr: "M", cat: "C",
      st: "VIC", vp: 1, np: 0, pkg: 1000, bp: 0.1, ipm: 1, bipm: 100, da: 0, f25: 0, sm: 0,
      ...over,
    };
  }
  const EMPS = [emp({ id: "A" }), emp({ id: "B" })];
  const BASE: Caps = { vCap: 1000, nCap: 1000, gCap: 2000 };

  it("is used verbatim in place of the derivation", () => {
    const rows = applyOverrides(EMPS, {});
    const pool = computeScalesAndBonuses(rows, { ...BASE, vicScale: 0.25 });
    expect(pool.vicScale).toBe(0.25);
    // calcBonus follows it: 100 potential x 1 IPM x 0.25
    expect(rows.find((e) => e.id === "A")!.calcBonus).toBeCloseTo(25, 10);
  });

  it("its ABSENCE reproduces the derivation exactly", () => {
    const derived = computeScalesAndBonuses(applyOverrides(EMPS, {}), BASE);
    // an oversubscribed pool, so the derived figure is not trivially 1
    const tight = computeScalesAndBonuses(applyOverrides(EMPS, {}), { ...BASE, vCap: 50 });
    expect(derived.vicScale).toBe(1);
    expect(tight.vicScale).toBeCloseTo(0.25, 10);
  });

  it("cannot be moved by anybody's IPM, which is the point", () => {
    const flat = computeScalesAndBonuses(applyOverrides(EMPS, {}), { ...BASE, vicScale: 0.4 });
    const edited = computeScalesAndBonuses(
      applyOverrides(EMPS, { A: { ipmEdit: 0.1 } }),
      { ...BASE, vicScale: 0.4 }
    );
    expect(edited.vicScale).toBe(flat.vicScale);
  });

  it("a stored NSW scale is honoured over the NSW_FULL_ENTITLEMENT pin", () => {
    const pool = computeScalesAndBonuses(applyOverrides(EMPS, {}), { ...BASE, nswScale: 0.8 });
    expect(pool.nswScale).toBe(0.8);
  });
});

describe("an issued row", () => {
  function emp(over: Partial<Employee> & { id: string }): Employee {
    return {
      sn: "S", gn: over.id, pos: "P", dept: "D", mgr: "M", cat: "C",
      st: "VIC", vp: 1, np: 0, pkg: 1000, bp: 0.1, ipm: 1, bipm: 100, da: 0, f25: 0, sm: 0,
      ...over,
    };
  }
  const EMPS = [emp({ id: "A" })];
  const CAPS2: Caps = { vCap: 1000, nCap: 1000, gCap: 2000 };
  const issued = { amount: 777, at: "2026-08-27T00:00:00.000Z", by: "a@b.c" };

  function pay(ov: Overrides, caps: Caps = CAPS2) {
    const rows = applyOverrides(EMPS, ov);
    computeScalesAndBonuses(rows, caps);
    return rows[0];
  }

  it("is paid its committed amount, not a derivation", () => {
    expect(pay({ A: { locked: true, issued, baseAmount: 10 } }).finalBonus).toBe(777);
  });

  it("is immovable by IPM, by discretionary and by a new Scale Factor", () => {
    expect(pay({ A: { locked: true, issued, ipmEdit: 0.01 } }).finalBonus).toBe(777);
    expect(pay({ A: { locked: true, issued, daEdit: 5000 } }).finalBonus).toBe(777);
    expect(pay({ A: { locked: true, issued } }, { ...CAPS2, vicScale: 0.01 }).finalBonus).toBe(777);
  });

  it("is locked whatever the flag says — an Unlock all cannot free it", () => {
    expect(pay({ A: { locked: false, issued } }).locked).toBe(true);
  });

  it("keeps its stored discretionary visible rather than having it blanked", () => {
    // issuing FREEZES a row, it does not erase what was true of it
    expect(pay({ A: { locked: true, issued, daEdit: 42 } }).daEdit).toBe(42);
  });

  it("refuses every editability predicate", () => {
    const rule = rowRule({ sm: 0, st: "VIC", vp: 1, np: 0, issued });
    expect(isLockable(rule)).toBe(false);
    expect(isDaEditable(rule)).toBe(false);
    expect(isIpmEditable(rule)).toBe(false);
    // and the same row without the stamp is editable, so the stamp is the cause
    const free = rowRule({ sm: 0, st: "VIC", vp: 1, np: 0 });
    expect(isLockable(free)).toBe(true);
    expect(isDaEditable(free)).toBe(true);
    expect(isIpmEditable(free)).toBe(true);
  });
});


/**
 * ISSUE then REVERT is number-neutral: the row comes back to exactly the payout
 * it was committed at. This is the property /api/issue's DELETE relies on, and
 * the reason reverting keeps the lock rather than clearing it.
 */
describe("issuing and reverting round-trips to the same figure", () => {
  function emp(over: Partial<Employee> & { id: string }): Employee {
    return {
      sn: "S", gn: over.id, pos: "P", dept: "D", mgr: "M", cat: "C",
      st: "VIC", vp: 1, np: 0, pkg: 1000, bp: 0.1, ipm: 1, bipm: 100, da: 0, f25: 0, sm: 0,
      ...over,
    };
  }
  const EMPS = [emp({ id: "A" })];
  const CAPS3: Caps = { vCap: 1000, nCap: 1000, gCap: 2000 };

  function payout(ov: Overrides, caps: Caps = CAPS3) {
    const rows = applyOverrides(EMPS, ov);
    computeScalesAndBonuses(rows, caps);
    return rows[0];
  }

  it("returns the identical payout, with the lock kept", () => {
    const locked: Overrides = { A: { locked: true, baseAmount: 812.34, daEdit: 55 } };
    const before = payout(locked).finalBonus;

    // issue: capture finalBonus exactly as /api/issue does
    const issuedDoc: Overrides = {
      A: { ...locked.A, issued: { amount: before, at: "2026-08-27T00:00:00.000Z", by: "a@b.c" } },
    };
    expect(payout(issuedDoc).finalBonus).toBe(before);

    // revert: drop the stamp, keep the lock — exactly what DELETE stores
    const { issued: _gone, ...rest } = issuedDoc.A!;
    void _gone;
    const reverted: Overrides = { A: { ...rest, locked: true } };
    const after = payout(reverted);

    expect(after.finalBonus).toBeCloseTo(before, 10);
    expect(after.locked).toBe(true);
    expect(after.daEdit).toBe(55);
  });

  it("survives a Recalculate having moved the scale while it was issued", () => {
    // the scale changing is exactly what an issued row is protected from, so
    // reverting afterwards must still land on the committed figure
    const locked: Overrides = { A: { locked: true, baseAmount: 812.34, daEdit: 55 } };
    const before = payout(locked).finalBonus;
    const issuedDoc: Overrides = {
      A: { ...locked.A, issued: { amount: before, at: "2026-08-27T00:00:00.000Z", by: "a@b.c" } },
    };
    const moved: Caps = { ...CAPS3, vicScale: 0.01 };
    expect(payout(issuedDoc, moved).finalBonus).toBe(before);

    const { issued: _gone, ...rest } = issuedDoc.A!;
    void _gone;
    expect(payout({ A: { ...rest, locked: true } }, moved).finalBonus).toBeCloseTo(before, 10);
  });

  it("a reverted row is editable and lockable again", () => {
    const rule = rowRule({ sm: 0, st: "VIC", vp: 1, np: 0 });
    expect(isLockable(rule)).toBe(true);
    expect(isDaEditable(rule)).toBe(true);
    expect(isIpmEditable(rule)).toBe(true);
  });
});


/**
 * THE LIVE CARVE-OUT: what each state's cap actually pays for people its home
 * total does not count. The behaviour this exists for is that editing a Shared
 * Services person now moves both states' Remaining by their VIC/NSW split.
 */
describe("liveCarve", () => {
  function emp(over: Partial<Employee> & { id: string }): Employee {
    return {
      sn: "S", gn: over.id, pos: "P", dept: "D", mgr: "M", cat: "C",
      st: "VIC", vp: 1, np: 0, pkg: 1000, bp: 0.1, ipm: 1, bipm: 100, da: 0, f25: 0, sm: 0,
      ...over,
    };
  }
  // one whole-pool row per state, one 61/39 shared row, one part-split VIC row
  const V = emp({ id: "V" });
  const N = emp({ id: "N", st: "NSW", vp: 0, np: 1 });
  const SH = emp({ id: "SH", st: "SHARED", vp: 0.61, np: 0.39 });
  const PS = emp({ id: "PS", st: "VIC", vp: 0.7, np: 0.3 });
  const POP = [V, N, SH, PS];
  const BIG: Caps = { vCap: 1_000_000, nCap: 1_000_000, gCap: 2_000_000 };

  function priced(ov: Overrides = {}) {
    const rows = applyOverrides(POP, ov);
    computeScalesAndBonuses(rows, BIG);
    return rows;
  }

  it("PARTITIONS the state's whole draw: home + carve loses and double-counts nothing", () => {
    const rows = priced();
    for (const st of ["VIC", "NSW"] as const) {
      const share = (r: (typeof rows)[number]) => (st === "VIC" ? r.vp : r.np);
      // every row's funded portion for this state, computed independently
      const everything = rows.reduce((s, r) => s + r.finalBonus * share(r), 0);
      expect(stateHomeTotal(st, rows) + liveCarve(st, rows).total).toBeCloseTo(
        everything,
        8
      );
    }
  });

  it("counts a Shared Services row at its own VIC/NSW percentages", () => {
    const rows = priced();
    const sh = rows.find((e) => e.id === "SH")!;
    expect(liveCarve("VIC", rows).sharedServices).toBeCloseTo(sh.finalBonus * 0.61, 10);
    expect(liveCarve("NSW", rows).sharedServices).toBeCloseTo(sh.finalBonus * 0.39, 10);
  });

  it("puts a part-split row in splitState, not in the home total", () => {
    const rows = priced();
    const ps = rows.find((e) => e.id === "PS")!;
    expect(liveCarve("VIC", rows).splitState).toBeCloseTo(ps.finalBonus * 0.7, 10);
    expect(liveCarve("NSW", rows).splitState).toBeCloseTo(ps.finalBonus * 0.3, 10);
    // and it is excluded from VIC's home total, so it is not counted twice
    expect(stateHomeTotal("VIC", rows)).toBeCloseTo(
      rows.find((e) => e.id === "V")!.finalBonus,
      10
    );
  });

  it("a whole-pool row contributes to its home total and to neither carve", () => {
    const rows = priced();
    const only = [rows.find((e) => e.id === "V")!];
    expect(liveCarve("VIC", only).total).toBe(0);
    expect(liveCarve("NSW", only).total).toBe(0);
  });

  it("A DISCRETIONARY ON A SHARED PERSON MOVES BOTH POOLS BY THEIR SPLIT", () => {
    const before = priced();
    const after = priced({ SH: { daEdit: 5000 } });
    expect(liveCarve("VIC", after).total - liveCarve("VIC", before).total)
      .toBeCloseTo(5000 * 0.61, 6);
    expect(liveCarve("NSW", after).total - liveCarve("NSW", before).total)
      .toBeCloseTo(5000 * 0.39, 6);
    // and no state's HOME total moved — a shared person is in neither
    expect(stateHomeTotal("VIC", after)).toBeCloseTo(stateHomeTotal("VIC", before), 10);
    expect(stateHomeTotal("NSW", after)).toBeCloseTo(stateHomeTotal("NSW", before), 10);
  });

  it("an IPM change on a shared person moves both carves in proportion", () => {
    const before = priced();
    const after = priced({ SH: { ipmEdit: 0.5 } });
    const dV = liveCarve("VIC", after).total - liveCarve("VIC", before).total;
    const dN = liveCarve("NSW", after).total - liveCarve("NSW", before).total;
    // whatever the row moved by, it is split 61/39 between the two
    expect(dV / (dV + dN)).toBeCloseTo(0.61, 6);
  });

  it("THE BOUND FOLLOWS THE CARD: a shared grant tightens what VIC may give", () => {
    // The card and the ceiling are one number again (lib/calc.ts's
    // stateBoundCap), so a shared person's grant reduces VIC's room by their
    // VIC share — 61% of it — instead of the card moving while the ceiling
    // stood still. That divergence is what this replaced.
    const before = priced();
    const after = priced({ SH: { daEdit: 5000 } });
    const roomFor = (rows: ReturnType<typeof priced>) =>
      getMaxDA(rows.find((e) => e.id === "V")!, rows, BIG, "state");
    expect(roomFor(before) - roomFor(after)).toBeCloseTo(5000 * 0.61, 6);
  });
});
