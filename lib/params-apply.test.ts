import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Dataset } from "./schema";
import type { Scope } from "./access";
import { applyOverrides, computeScalesAndBonuses } from "./calc";
import { applyParams, defaultParams, ParamsSchema, canChangeCaps } from "./params-apply";

const data = JSON.parse(
  readFileSync(join(__dirname, "..", "data", "bonus.json"), "utf-8")
) as Dataset;

describe("applyParams", () => {
  it("default params are a bit-exact identity (goldens unchanged)", () => {
    const eff = applyParams(data, defaultParams(data));
    expect(eff.emp).toBe(data.emp); // same array, untouched
    expect(eff.vCap).toBe(data.vCap);
    const emps = applyOverrides(eff.emp, {});
    const pool = computeScalesAndBonuses(emps, eff);
    // Anchors match lib/calc-golden.test.ts (re-anchored for the 25 August
    // 2026 reversal back to DA-on-top: the one source DA of 3000 leaves the
    // pools alone and is paid on top, so the total is gCap + 3000).
    expect(pool.vicScale).toBe(0.6717823483284814);
    expect(pool.nswScale).toBe(0.7820525079336984);
    expect(emps.reduce((s, e) => s + e.finalBonus, 0)).toBe(2621822.7499999995);
  });

  it("a 0.5 modifier exactly halves every derived after-IPM figure", () => {
    const eff = applyParams(data, { ...defaultParams(data), companyModifier: 0.5 });
    const base = applyOverrides(data.emp, {});
    const halved = applyOverrides(eff.emp, {});
    computeScalesAndBonuses(base, data);
    computeScalesAndBonuses(halved, eff);
    for (let i = 0; i < base.length; i++) {
      // ×0.5 is a power-of-two scale: exact through the whole derivation
      expect(halved[i].bipmCalc).toBe(base[i].bipmCalc * 0.5);
    }
  });

  it("changing a cap flows straight through to pool availability", () => {
    const doubled = applyParams(data, { ...defaultParams(data), vCap: data.vCap * 2 });
    const emps = applyOverrides(doubled.emp, {});
    const pool = computeScalesAndBonuses(emps, doubled);
    expect(pool.stateVicAvail).toBe(data.vCap * 2);
    const basePool = computeScalesAndBonuses(applyOverrides(data.emp, {}), data);
    expect(pool.vicScale).toBeGreaterThan(basePool.vicScale);
    expect(pool.nswScale).toBe(basePool.nswScale); // other pool untouched
  });

  it("schema bounds reject out-of-range values", () => {
    expect(ParamsSchema.safeParse({ vCap: -1, nCap: 1, gCap: 1, companyModifier: 1 }).success).toBe(false);
    expect(ParamsSchema.safeParse({ vCap: 1, nCap: 1, gCap: 1, companyModifier: 3 }).success).toBe(false);
    expect(ParamsSchema.safeParse({ vCap: 1, nCap: 1, gCap: 1, companyModifier: 0.05 }).success).toBe(false);
    expect(ParamsSchema.safeParse(defaultParams(data)).success).toBe(true);
  });
});

/**
 * Whether a scope may change the pool caps — its own grant, not implied by
 * full access. A state lead can never reach this at all (requireWriter
 * refuses them before the route gets this far), so the only real question is
 * which full-access admins hold the extra tick.
 */
describe("canChangeCaps", () => {
  const admin = (grant: boolean): Scope => ({
    email: "admin@texco.net.au",
    rule: { type: "full", canEditCaps: grant, canActAs: [] },
    canEdit: true,
    visibleFields: [],
    label: "Full access",
  });

  const lead: Scope = {
    email: "vic@texco.net.au",
    rule: {
      type: "state",
      states: ["VIC"],
      visibleFields: [],
      editableFields: ["da", "ipm"],
      canLock: true,
      canActAs: [],
    },
    canEdit: false,
    visibleFields: [],
    label: "VIC",
  };

  it("a full admin explicitly granted the permission may change caps", () => {
    expect(canChangeCaps(admin(true))).toBe(true);
  });

  it("a full admin without it may not, even though they're otherwise full access", () => {
    expect(canChangeCaps(admin(false))).toBe(false);
  });

  it("a state lead may never change caps, regardless of their other grants", () => {
    expect(canChangeCaps(lead)).toBe(false);
  });
});
