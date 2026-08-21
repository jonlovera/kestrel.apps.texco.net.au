/**
 * Golden tests: the calculation engine's output must never move.
 *
 * lib/__goldens__/fy26-baseline.json was generated once (scripts/
 * gen-goldens.ts) from the engine as it stood on main and is FROZEN. Every
 * assertion here is strict `toBe` — bit-for-bit double equality, no
 * tolerance. If any refactor of the data layer, params plumbing, or payload
 * shaping moves a single figure, this suite fails.
 *
 * Requires data/bonus.json on local disk (untracked; holds the real data).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Employee, Overrides } from "./schema";
import { applyOverrides, computeScalesAndBonuses, getVicAlloc, getNswAlloc } from "./calc";
import golden from "./__goldens__/fy26-baseline.json";

const data = JSON.parse(
  readFileSync(join(__dirname, "..", "data", "bonus.json"), "utf-8")
) as { emp: Employee[]; vCap: number; nCap: number; gCap: number };

function run(overrides: Overrides) {
  const emps = applyOverrides(data.emp, overrides);
  const pool = computeScalesAndBonuses(emps, data);
  return { emps, pool };
}

function assertMatches(
  overrides: Overrides,
  expected: (typeof golden)["baseline"]
) {
  const { emps, pool } = run(overrides);
  expect(pool.vicScale).toBe(expected.vicScale);
  expect(pool.nswScale).toBe(expected.nswScale);
  expect(emps.reduce((s, e) => s + e.finalBonus, 0)).toBe(expected.totalFinal);
  expect(emps.reduce((s, e) => s + getVicAlloc(e, pool.vicScale), 0)).toBe(
    expected.totalVicAlloc
  );
  expect(emps.reduce((s, e) => s + getNswAlloc(e, pool.nswScale), 0)).toBe(
    expected.totalNswAlloc
  );
  const byId = new Map(emps.map((e) => [e.id, e]));
  expect(emps.length).toBe(expected.rows.length);
  for (const row of expected.rows) {
    const e = byId.get(row.id)!;
    expect(e).toBeDefined();
    expect(e.cpm).toBe(row.cpm);
    expect(e.preIpm).toBe(row.preIpm);
    expect(e.bipmCalc).toBe(row.bipmCalc);
    expect(e.calcBonus).toBe(row.calcBonus);
    expect(e.finalBonus).toBe(row.finalBonus);
  }
}

describe("golden: baseline", () => {
  it("has the anchored known values", () => {
    // Independent anchors, hardcoded — not read from the golden file.
    // Re-anchored (deliberately) for the Aug 2026 DA-on-top methodology
    // change: the goldens were regenerated because DA left the pool maths —
    // see lib/calc.ts's module header and the re-anchoring note in
    // lib/calc.test.ts's real-data regression block.
    expect(golden.baseline.vicScale).toBe(0.6717823483284814);
    expect(golden.baseline.nswScale).toBe(0.7820525079336984);
    // The bit-exact double sum; 2621822.75 is its value rounded to cents
    // (the old reconciliation figure + the one source DA of 3000, now paid
    // on top of the capped pools). Both anchored strictly.
    expect(golden.baseline.totalFinal).toBe(2621822.7499999995);
    expect(Math.round(golden.baseline.totalFinal * 100) / 100).toBe(2621822.75);
    expect(golden.baseline.rows.length).toBe(155);
  });

  it("every derived figure matches bit-for-bit", () => {
    const { pool } = run({});
    expect(pool.vicScale).toBe(0.6717823483284814);
    expect(pool.nswScale).toBe(0.7820525079336984);
    assertMatches({}, golden.baseline);
  });
});

describe("golden: scenarios", () => {
  for (const scenario of golden.scenarios) {
    it(`${scenario.name} matches bit-for-bit`, () => {
      assertMatches(scenario.overrides as Overrides, scenario);
    });
  }
});
