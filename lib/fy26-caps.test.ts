import { describe, it, expect } from "vitest";
import {
  FY26_CARVE_OUTS,
  FY26_PUBLISHED,
  statePoolOf,
  bindingStateCap,
  attachFy26Carves,
} from "./fy26-caps";

/**
 * The carve-out constants against the signed-off waterfall. If someone edits
 * a constant, these are the identities that must still hold — the published
 * pools are whole dollars, so a half-dollar tolerance is the sheet's own
 * rounding and nothing more.
 */
describe("FY26 carve-outs", () => {
  it("total cap less both carve-outs reaches the published state pool", () => {
    for (const st of ["VIC", "NSW"] as const) {
      const { totalCap, statePool } = FY26_PUBLISHED[st];
      expect(Math.abs(statePoolOf(st, totalCap) - statePool)).toBeLessThan(0.5);
    }
  });

  it("the published total caps sum to the published group cap", () => {
    const sum = FY26_PUBLISHED.VIC.totalCap + FY26_PUBLISHED.NSW.totalCap;
    expect(Math.abs(sum - FY26_PUBLISHED.groupCap)).toBeLessThan(0.01);
  });

  it("the binding cap nets shared services only — never the split-state carve", () => {
    for (const st of ["VIC", "NSW"] as const) {
      const cap = FY26_PUBLISHED[st].totalCap;
      expect(bindingStateCap(st, cap)).toBe(cap - FY26_CARVE_OUTS[st].sharedServices);
      // strictly looser than the headline by exactly the split-state carve
      expect(bindingStateCap(st, cap) - statePoolOf(st, cap)).toBe(
        FY26_CARVE_OUTS[st].splitState
      );
    }
    // Option A figures quoted in the 25 Aug 2026 decision
    expect(bindingStateCap("VIC", FY26_PUBLISHED.VIC.totalCap)).toBeCloseTo(1_431_033.32, 2);
    expect(bindingStateCap("NSW", FY26_PUBLISHED.NSW.totalCap)).toBeCloseTo(1_220_209.16, 2);
  });

  it("the headline moves one-for-one with the total cap", () => {
    const base = statePoolOf("VIC", 1_000_000);
    expect(statePoolOf("VIC", 1_000_001) - base).toBe(1);
    expect(bindingStateCap("NSW", 5.25) - bindingStateCap("NSW", 4.25)).toBe(1);
  });

  it("attachFy26Carves adds the binding carves and leaves everything else alone", () => {
    const caps = { vCap: 10, nCap: 20, gCap: 30, companyModifier: 1 };
    const out = attachFy26Carves(caps);
    expect(out).toEqual({
      ...caps,
      vCarve: FY26_CARVE_OUTS.VIC.sharedServices,
      nCarve: FY26_CARVE_OUTS.NSW.sharedServices,
    });
    // the binding identity and the attached data are the same rule
    expect(out.vCap - out.vCarve).toBe(bindingStateCap("VIC", caps.vCap));
    expect(out.nCap - out.nCarve).toBe(bindingStateCap("NSW", caps.nCap));
    expect(caps).not.toHaveProperty("vCarve"); // input untouched
  });
});
