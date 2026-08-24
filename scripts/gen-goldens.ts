/**
 * Generate golden files for the calculation engine.
 *
 * Runs the CURRENT engine (lib/calc.ts) against the current source data and
 * records every derived figure at full double precision. The output —
 * lib/__goldens__/fy26-baseline.json — is committed once and then frozen;
 * lib/calc-golden.test.ts asserts strict equality against it forever after.
 * If a later change moves any number by even one ULP, the suite fails.
 *
 *   npx tsx scripts/gen-goldens.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Employee, Overrides } from "../lib/schema";
import {
  applyOverrides,
  computeScalesAndBonuses,
  getVicAlloc,
  getNswAlloc,
  type CalcEmployee,
} from "../lib/calc";

const dataPath = join(__dirname, "..", "data", "bonus.json");
const data = JSON.parse(readFileSync(dataPath, "utf-8")) as {
  emp: Employee[];
  vCap: number;
  nCap: number;
  gCap: number;
};

interface GoldenRow {
  id: string;
  cpm: number;
  preIpm: number;
  bipmCalc: number;
  calcBonus: number;
  finalBonus: number;
}

function run(overrides: Overrides) {
  const emps = applyOverrides(data.emp, overrides);
  const pool = computeScalesAndBonuses(emps, data);
  const rows: GoldenRow[] = emps.map((e: CalcEmployee) => ({
    id: e.id,
    cpm: e.cpm,
    preIpm: e.preIpm,
    bipmCalc: e.bipmCalc,
    calcBonus: e.calcBonus,
    finalBonus: e.finalBonus,
  }));
  return {
    vicScale: pool.vicScale,
    nswScale: pool.nswScale,
    totalFinal: emps.reduce((s, e) => s + e.finalBonus, 0),
    totalVicAlloc: emps.reduce((s, e) => s + getVicAlloc(e, pool), 0),
    totalNswAlloc: emps.reduce((s, e) => s + getNswAlloc(e, pool), 0),
    rows,
  };
}

// Deterministic scenario subjects picked from the data itself.
const baselineEmps = applyOverrides(data.emp, {});
computeScalesAndBonuses(baselineEmps, data);
const byId = new Map(baselineEmps.map((e) => [e.id, e]));
const firstUnlocked = (pred: (e: CalcEmployee) => boolean) =>
  baselineEmps.find((e) => !e.sm && e.vp + e.np > 0 && pred(e))!;

const vicA = firstUnlocked((e) => e.st === "VIC");
const vicB = firstUnlocked((e) => e.st === "VIC" && e.id !== vicA.id);
const nswA = firstUnlocked((e) => e.st === "NSW");
const sharedA = firstUnlocked((e) => e.st === "SHARED");

// Scenario 1: one row locked at its baseline final, DA on another.
const s1: Overrides = {
  [sharedA.id]: { locked: true, lockedFinal: byId.get(sharedA.id)!.finalBonus },
  [vicA.id]: { daEdit: 5000 },
};

// Scenario 2: DA far larger than the remaining pool (scale floors at 0).
const s2: Overrides = {
  [vicA.id]: { daEdit: 10_000_000 },
};

// Scenario 3: two DAs + bp/ipm edits + a lock, mixed across pools.
const s3: Overrides = {
  [vicA.id]: { daEdit: 2500, ipmEdit: 0.75 },
  [nswA.id]: { daEdit: 1000, bpEdit: 0.25 },
  [vicB.id]: { locked: true, lockedFinal: byId.get(vicB.id)!.finalBonus },
  [sharedA.id]: { ipmEdit: 1.1 },
};

// Scenario 4: every source DA neutralised. The all-zero-DA degenerate case,
// generated as a checkpoint BEFORE the Aug 2026 pool-funded DA reform so the
// reform could be proven bit-identical when no DA exists.
const noDa: Overrides = Object.fromEntries(
  data.emp.filter((e) => e.da !== 0).map((e) => [e.id, { daEdit: 0 }])
);

const golden = {
  generatedFrom: "data/bonus.json",
  employeeCount: data.emp.length,
  caps: { vCap: data.vCap, nCap: data.nCap, gCap: data.gCap },
  baseline: run({}),
  scenarios: [
    { name: "lock-plus-da", overrides: s1, ...run(s1) },
    { name: "da-exceeds-pool", overrides: s2, ...run(s2) },
    { name: "mixed-edits-and-lock", overrides: s3, ...run(s3) },
    { name: "no-da", overrides: noDa, ...run(noDa) },
  ],
};

const outPath = join(__dirname, "..", "lib", "__goldens__", "fy26-baseline.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(golden, null, 1));

console.log(`Wrote ${outPath}`);
console.log(`rows: ${golden.baseline.rows.length}`);
console.log(`vicScale: ${golden.baseline.vicScale}`);
console.log(`nswScale: ${golden.baseline.nswScale}`);
console.log(`totalFinal: ${golden.baseline.totalFinal}`);
console.log(`scenario subjects: ${vicA.id}, ${vicB.id}, ${nswA.id}, ${sharedA.id}`);
