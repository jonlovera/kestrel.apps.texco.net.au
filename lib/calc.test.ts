import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Employee, Overrides } from "./schema";
import {
  applyOverrides,
  computeScalesAndBonuses,
  getMaxDA,
  clampDaToPool,
  getVicAlloc,
  getNswAlloc,
  deriveCpm,
  parsePercentInput,
  parseDaInput,
  type Caps,
  type CalcEmployee,
} from "./calc";

/**
 * Hand-computable fixture:
 *   VIC pool: A (bipm 100), B (bipm 300) unlocked; C site manager fixed at 200
 *   NSW pool: D (bipm 250) unlocked
 *   SHARED:   E (bipm 100, 60/40 split) unlocked
 *   F: no pool exposure (vp = np = 0)
 * Baseline: vicScale = (1000-200)/460, nswScale = 500/290
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
  makeEmp({ id: "A", bipm: 100, pkg: 1000 }),
  makeEmp({ id: "B", bipm: 300, pkg: 3000 }),
  makeEmp({ id: "C", bipm: 200, pkg: 2000, sm: 1 }),
  makeEmp({ id: "D", st: "NSW", vp: 0, np: 1, bipm: 250, pkg: 2500 }),
  makeEmp({ id: "E", st: "SHARED", vp: 0.6, np: 0.4, bipm: 100, pkg: 1000 }),
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
    expect(pool.vicScale).toBeCloseTo(800 / 460, 10);
    expect(pool.nswScale).toBeCloseTo(500 / 290, 10);
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
      100 * 0.6 * pool.vicScale + 100 * 0.4 * pool.nswScale,
      10
    );
  });

  it("zero-weight employee gets only their DA (here 0)", () => {
    const { byId } = run();
    expect(byId.F.finalBonus).toBe(0);
  });
});

describe("single discretionary adjustment pro-rates across the unlocked pool", () => {
  it("pool cap is still exactly filled and the DA recipient nets less than the DA", () => {
    const base = run();
    const adj = run({ A: { daEdit: 100 } });

    // scale drops to absorb the DA
    expect(adj.pool.vicScale).toBeCloseTo(700 / 460, 10);
    // recipient rises, but by less than the DA (their own share re-prorates)
    expect(adj.byId.A.finalBonus).toBeCloseTo(100 * (700 / 460) + 100, 10);
    expect(adj.byId.A.finalBonus - base.byId.A.finalBonus).toBeLessThan(100);
    expect(adj.byId.A.finalBonus).toBeGreaterThan(base.byId.A.finalBonus);
    // pool total unchanged
    expect(totalVicAlloc(adj.emps, adj.pool.vicScale)).toBeCloseTo(1000, 8);
  });

  it("the delta is spread over other unlocked employees proportional to bipm x weight", () => {
    const base = run();
    const adj = run({ A: { daEdit: 100 } });
    const dB = base.byId.B.finalBonus - adj.byId.B.finalBonus;
    const dEvic =
      base.byId.E.finalBonus -
      adj.byId.E.finalBonus; // E only loses on its VIC component
    // B carries 300 of VIC bipm, E carries 60 → 5:1 ratio
    expect(dB / dEvic).toBeCloseTo(300 / 60, 8);
  });

  it("site managers and the other pool are untouched", () => {
    const base = run();
    const adj = run({ A: { daEdit: 100 } });
    expect(adj.byId.C.finalBonus).toBeCloseTo(base.byId.C.finalBonus, 10);
    expect(adj.byId.D.finalBonus).toBeCloseTo(base.byId.D.finalBonus, 10);
    expect(adj.pool.nswScale).toBeCloseTo(base.pool.nswScale, 10);
  });
});

describe("multiple adjustments compose", () => {
  it("two DAs shrink the scale additively and are order-independent", () => {
    const both = run({ A: { daEdit: 100 }, B: { daEdit: 50 } });
    expect(both.pool.vicScale).toBeCloseTo((800 - 150) / 460, 10);
    // pure function of state → same result as applying in any order
    const swapped = run({ B: { daEdit: 50 }, A: { daEdit: 100 } });
    expect(swapped.byId.A.finalBonus).toBeCloseTo(both.byId.A.finalBonus, 12);
    expect(swapped.byId.B.finalBonus).toBeCloseTo(both.byId.B.finalBonus, 12);
    expect(totalVicAlloc(both.emps, both.pool.vicScale)).toBeCloseTo(1000, 8);
  });

  it("DAs in different pools do not interact", () => {
    const adj = run({ A: { daEdit: 100 }, D: { daEdit: 60 } });
    expect(adj.pool.vicScale).toBeCloseTo(700 / 460, 10);
    expect(adj.pool.nswScale).toBeCloseTo((500 - 60) / 290, 10);
  });
});

describe("locked positions are excluded from re-proration", () => {
  // Lock B at its baseline final (521.739…) as the prototype's lock button does
  const bFinal = 300 * (800 / 460);

  it("a locked employee's final is frozen while others re-prorate", () => {
    const adj = run({
      B: { locked: true, lockedFinal: bFinal },
      A: { daEdit: 100 },
    });
    expect(adj.byId.B.finalBonus).toBeCloseTo(bFinal, 10);
    // locked B moves into the locked aggregate: scale over remaining 160 bipm
    expect(adj.pool.vicScale).toBeCloseTo((1000 - 200 - bFinal - 100) / 160, 10);
    expect(totalVicAlloc(adj.emps, adj.pool.vicScale)).toBeCloseTo(1000, 8);
  });

  it("locked row still shows a live calcBonus but keeps frozen finalBonus", () => {
    const adj = run({ B: { locked: true, lockedFinal: bFinal }, A: { daEdit: 100 } });
    expect(adj.byId.B.calcBonus).not.toBeCloseTo(adj.byId.B.finalBonus, 4);
  });

  it("unlocking releases the bonus back into the pool", () => {
    const relocked = run({ A: { daEdit: 100 } }); // as if B was unlocked again
    expect(relocked.pool.vicScale).toBeCloseTo(700 / 460, 10);
  });
});

describe("all-but-one locked", () => {
  const bFinal = 300 * (800 / 460);
  const eFinal = 100 * 0.6 * (800 / 460) + 100 * 0.4 * (500 / 290);
  const locks: Overrides = {
    B: { locked: true, lockedFinal: bFinal },
    E: { locked: true, lockedFinal: eFinal },
  };

  it("the sole unlocked employee's scale absorbs a DA fully", () => {
    const adj = run({ ...locks, A: { daEdit: 100 } });
    const lockedVp = 200 + bFinal + eFinal * 0.6;
    expect(adj.pool.vicScale).toBeCloseTo((1000 - lockedVp - 100) / 100, 8);
    expect(adj.byId.A.finalBonus).toBeCloseTo(
      100 * adj.pool.vicScale + 100,
      8
    );
    expect(totalVicAlloc(adj.emps, adj.pool.vicScale)).toBeCloseTo(1000, 8);
  });

  it("getMaxDA equals the exact remaining room for the last unlocked employee", () => {
    const { emps, pool, byId } = run(locks);
    const lockedVp = 200 + bFinal + eFinal * 0.6;
    const room = 1000 - lockedVp;
    expect(getMaxDA(byId.A, pool)).toBe(Math.floor(room));
    void emps;
  });
});

describe("adjustment larger than the remaining pool", () => {
  it("scale floors at zero (never negative) and the pool overdraws by the excess", () => {
    const adj = run({ A: { daEdit: 10000 } });
    expect(adj.pool.vicScale).toBe(0);
    // everyone else's VIC component collapses to their DA only
    expect(adj.byId.B.finalBonus).toBe(0);
    expect(adj.byId.A.finalBonus).toBe(10000);
  });

  it("getMaxDA reports the exact absorbable maximum, and at that DA the cap holds", () => {
    const base = run();
    const maxDa = getMaxDA(base.byId.A, base.pool); // floor(1000 - 200 - 0) for vp=1
    expect(maxDa).toBe(800);
    const capped = run({ A: { daEdit: maxDa } });
    expect(capped.pool.vicScale).toBe(0);
    // allocations: locked 200 + DA 800 = cap exactly
    expect(totalVicAlloc(capped.emps, capped.pool.vicScale)).toBeCloseTo(1000, 8);
    // one dollar more would overdraw
    const over = run({ A: { daEdit: maxDa + 1 } });
    expect(totalVicAlloc(over.emps, over.pool.vicScale)).toBeGreaterThan(1000);
  });

  it("getMaxDA for a split-state employee is bound by the tighter pool", () => {
    const { byId, pool } = run();
    const vicRoom = 1000 - 200; // per-weight: /0.6
    const nswRoom = 500; // per-weight: /0.4
    expect(getMaxDA(byId.E, pool)).toBe(
      Math.floor(Math.min(vicRoom / 0.6, nswRoom / 0.4))
    );
  });

  it("getMaxDA is 0 for zero-weight employees", () => {
    const { byId, pool } = run();
    expect(getMaxDA(byId.F, pool)).toBe(0); // Infinity guard → 0
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
    expect(parseDaInput("-500")).toBe(0);
    expect(parseDaInput("$1,500")).toBe(1500);
  });
});

describe("real-data regression (data/bonus.json)", () => {
  // Expected values computed with an independent implementation of the
  // prototype's algorithm (Python) against the extracted master blob.
  const data = JSON.parse(
    readFileSync(join(__dirname, "..", "data", "bonus.json"), "utf-8")
  );

  it("reproduces the baseline scales and group total exactly", () => {
    const emps = applyOverrides(data.emp, {});
    const pool = computeScalesAndBonuses(emps, data);
    expect(pool.vicScale).toBeCloseTo(0.6701530558872546, 12);
    expect(pool.nswScale).toBeCloseTo(0.7820525079336984, 12);
    const totFinal = emps.reduce((s, e) => s + e.finalBonus, 0);
    expect(totFinal).toBeCloseTo(2618822.75, 6);
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

describe("clampDaToPool", () => {
  /**
   * The save path and the what-if preview both run this, so a lead can never
   * be shown an adjustment the save would quietly reduce. Baseline room for A
   * is 800 (getMaxDA above), so 800 stands and 801 comes back as 800.
   */
  it("leaves an adjustment the pool can absorb alone", () => {
    const overrides: Overrides = { A: { daEdit: 800 } };
    expect(clampDaToPool(overrides, FIXTURE, CAPS)).toEqual([]);
    expect(overrides.A.daEdit).toBe(800);
  });

  it("clamps an adjustment past the cap down to the absorbable maximum", () => {
    const overrides: Overrides = { A: { daEdit: 10000 } };
    expect(clampDaToPool(overrides, FIXTURE, CAPS)).toEqual(["A"]);
    expect(overrides.A.daEdit).toBe(800);
    // and at the clamped figure the cap holds exactly
    const { emps, pool } = run(overrides);
    expect(totalVicAlloc(emps, pool.vicScale)).toBeCloseTo(1000, 8);
  });

  it("clamps to the tighter of the two pools for a split employee", () => {
    const overrides: Overrides = { E: { daEdit: 10000 } };
    clampDaToPool(overrides, FIXTURE, CAPS);
    expect(overrides.E.daEdit).toBe(Math.floor(Math.min(800 / 0.6, 500 / 0.4)));
  });

  it("leaves a locked row alone — its bonus is already frozen", () => {
    const overrides: Overrides = { A: { daEdit: 10000, locked: true } };
    expect(clampDaToPool(overrides, FIXTURE, CAPS)).toEqual([]);
    expect(overrides.A.daEdit).toBe(10000);
  });

  it("ignores entries with no adjustment, and unknown employees", () => {
    const overrides: Overrides = { B: { ipmEdit: 0.5 }, ZZZ: { daEdit: 9999 } };
    expect(clampDaToPool(overrides, FIXTURE, CAPS)).toEqual([]);
    expect(overrides.B.ipmEdit).toBe(0.5);
    expect(overrides.ZZZ.daEdit).toBe(9999);
  });

  it("zero-weight employees can absorb nothing", () => {
    const overrides: Overrides = { F: { daEdit: 500 } };
    expect(clampDaToPool(overrides, FIXTURE, CAPS)).toEqual(["F"]);
    expect(overrides.F.daEdit).toBe(0);
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
