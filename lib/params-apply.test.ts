import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Dataset } from "./schema";
import type { Scope } from "./access";
import { applyOverrides, computeScalesAndBonuses } from "./calc";
import { applyParams, defaultParams, ParamsSchema, canChangeCaps, capsWarning } from "./params-apply";

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
    // 2026 decision to pay NSW in full: nswScale is pinned at 1, VIC's is
    // untouched).
    expect(pool.vicScale).toBe(0.6717823483284814);
    expect(pool.nswScale).toBe(1);
    expect(emps.reduce((s, e) => s + e.finalBonus, 0)).toBe(2866751.5958);
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
    rule: { type: "full", canEditCaps: grant, canEditVicSiteManagers: false, canRecalculatePool: false, canRevokeIssued: false, canActAs: [], canDownloadLetter: false },
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
      canActAs: [], canDownloadLetter: false,
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

describe("capsWarning", () => {
  it("is silent when the state caps sum to the group cap within a dollar", () => {
    expect(capsWarning({ vCap: 1_593_574.32, nCap: 1_365_714.16, gCap: 2_959_288.48 })).toBeNull();
    expect(capsWarning({ vCap: 100, nCap: 200, gCap: 300.99 })).toBeNull();
  });

  it("names the gap when they do not — the August 2026 NSW corruption", () => {
    // nCap overwritten with the NSW state pool while gCap kept the truth
    const w = capsWarning({ vCap: 1_593_574, nCap: 1_194_970, gCap: 2_959_288.48 });
    expect(w).toMatch(/differ from the group cap/);
    expect(w).toContain("2,788,544");
    expect(w).toContain("2,959,288");
    expect(w).toContain("-170,744");
  });
});
