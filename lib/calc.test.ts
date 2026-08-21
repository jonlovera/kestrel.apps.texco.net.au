import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Employee, Overrides } from "./schema";
import {
  applyOverrides,
  computeScalesAndBonuses,
  getVicAlloc,
  getNswAlloc,
  deriveCpm,
  isLockable,
  parsePercentInput,
  parseDaInput,
  type Caps,
  type CalcEmployee,
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

function totalVicAlloc(emps: CalcEmployee[], vicScale: number) {
  return emps.reduce((s, e) => s + getVicAlloc(e, vicScale), 0);
}
function totalNswAlloc(emps: CalcEmployee[], nswScale: number) {
  return emps.reduce((s, e) => s + getNswAlloc(e, nswScale), 0);
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
    expect(totalVicAlloc(emps, pool.vicScale)).toBeCloseTo(1000, 8);
    expect(totalNswAlloc(emps, pool.nswScale)).toBeCloseTo(500, 8);
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
    expect(totalVicAlloc(emps, pool.vicScale)).toBeLessThan(bigCaps.vCap);
    expect(totalNswAlloc(emps, pool.nswScale)).toBeLessThan(bigCaps.nCap);
    // nobody is paid above their own theoretical (unscaled) entitlement
    expect(emps.find((e) => e.id === "A")!.finalBonus).toBeCloseTo(200, 10);
    expect(emps.find((e) => e.id === "B")!.finalBonus).toBeCloseTo(600, 10);
  });
});

describe("discretionary adjustment sits on top of the pool (owner decision, Aug 2026)", () => {
  it("Calc bonus + Discretionary = Final, exactly, and the scale does not move", () => {
    const base = run();
    const adj = run({ A: { daEdit: 100 } });

    // the pool is untouched by a DA
    expect(adj.pool.vicScale).toBeCloseTo(base.pool.vicScale, 12);
    expect(adj.byId.A.calcBonus).toBeCloseTo(base.byId.A.calcBonus, 12);
    // the identity the dashboard promises
    expect(adj.byId.A.finalBonus).toBeCloseTo(adj.byId.A.calcBonus + 100, 12);
    // pool allocation (pool money only) still fills the cap exactly
    expect(totalVicAlloc(adj.emps, adj.pool.vicScale)).toBeCloseTo(1000, 8);
  });

  it("nobody else moves — a DA is not funded by the pool any more", () => {
    const base = run();
    const adj = run({ A: { daEdit: 100 } });
    expect(adj.byId.B.finalBonus).toBeCloseTo(base.byId.B.finalBonus, 12);
    expect(adj.byId.E.finalBonus).toBeCloseTo(base.byId.E.finalBonus, 12);
    expect(adj.byId.C.finalBonus).toBeCloseTo(base.byId.C.finalBonus, 12);
    expect(adj.byId.D.finalBonus).toBeCloseTo(base.byId.D.finalBonus, 12);
    expect(adj.pool.nswScale).toBeCloseTo(base.pool.nswScale, 12);
  });

  it("a negative DA reduces the final below the calc", () => {
    const base = run();
    const adj = run({ A: { daEdit: -50 } });
    expect(adj.byId.A.finalBonus).toBeCloseTo(base.byId.A.calcBonus - 50, 12);
    expect(adj.pool.vicScale).toBeCloseTo(base.pool.vicScale, 12);
  });

  it("total payout exceeds the pools by exactly the net DA", () => {
    const base = run();
    const adj = run({ A: { daEdit: 100 }, D: { daEdit: -40 } });
    const totalBase = base.emps.reduce((s, e) => s + e.finalBonus, 0);
    const totalAdj = adj.emps.reduce((s, e) => s + e.finalBonus, 0);
    expect(totalAdj - totalBase).toBeCloseTo(100 - 40, 10);
  });

  it("a zero-weight employee's final is exactly their DA", () => {
    const adj = run({ F: { daEdit: 500 } });
    expect(adj.byId.F.calcBonus).toBe(0);
    expect(adj.byId.F.finalBonus).toBe(500);
  });
});

/**
 * The acceptance case the business owner stated for the "on top" model, in
 * their own numbers: 5,429 typed against a 24,571 calc bonus is $30,000, and
 * it is still $30,000 after someone else's discretionary amount lands.
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
    // discretionary does not scale, so neither pool moved to fund it
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
    // locked B moves into the locked aggregate: scale over remaining 320 bipm
    // (A + E's VIC share); A's DA no longer feeds the pool maths at all
    expect(adj.pool.vicScale).toBeCloseTo((1000 - 200 - bFinal) / 320, 10);
    expect(totalVicAlloc(adj.emps, adj.pool.vicScale)).toBeCloseTo(1000, 8);
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
    expect(relocked.pool.vicScale).toBeCloseTo(800 / 920, 10);
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
    // it by hand, since that's exactly the quantity under test. The DA plays
    // no part in the scale.
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

describe("a very large adjustment has no pool-derived bound", () => {
  it("the pool is untouched and the recipient gets scaled share + DA in full", () => {
    const base = run();
    const adj = run({ A: { daEdit: 10000 } });
    expect(adj.pool.vicScale).toBeCloseTo(base.pool.vicScale, 12);
    expect(adj.byId.B.finalBonus).toBeCloseTo(base.byId.B.finalBonus, 12);
    expect(adj.byId.A.finalBonus).toBeCloseTo(base.byId.A.calcBonus + 10000, 10);
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
  // prototype's algorithm. Re-anchored (deliberately) for the Aug 2026
  // DA-on-top methodology change: one source row (ALANT) carries da=3000,
  // which the pool no longer funds — so VIC's scale rises a touch
  // (0.67015… → 0.67178…), NSW is untouched, and the group total is exactly
  // the old figure + 3000 (the DA now paid on top of the still-capped pools).
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
    expect(totalVicAlloc(emps, pool.vicScale)).toBeCloseTo(1580414.5, 6);
    expect(totalNswAlloc(emps, pool.nswScale)).toBeCloseTo(1038408.25, 6);
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

describe("isLockable", () => {
  it("a pooled non-site-manager row is lockable", () => {
    expect(isLockable({ sm: 0, vp: 0.6, np: 0.4 })).toBe(true);
    expect(isLockable({ sm: 0, vp: 0, np: 1 })).toBe(true);
  });

  it("site managers are not, regardless of pool weighting", () => {
    expect(isLockable({ sm: 1, vp: 1, np: 0 })).toBe(false);
  });

  it("a row drawing from no pool is not", () => {
    expect(isLockable({ sm: 0, vp: 0, np: 0 })).toBe(false);
  });
});
