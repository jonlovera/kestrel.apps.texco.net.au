import { describe, it, expect } from "vitest";
import {
  FY26_CARVE_OUTS,
  FY26_PUBLISHED,
  statePoolOf,
  stateCarveOf,
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

  it("the bound nets BOTH carves — there is no looser second identity", () => {
    // The 25 Aug 2026 reversal: what a grant is refused against IS the card
    // headline. A separate shared-services-only figure (VIC 1,431,033 /
    // NSW 1,220,209) used to exist and showed a NSW lead a bigger budget than
    // the card beside it headlined; nothing may reintroduce it.
    for (const st of ["VIC", "NSW"] as const) {
      const cap = FY26_PUBLISHED[st].totalCap;
      expect(statePoolOf(st, cap)).toBe(cap - stateCarveOf(st));
      expect(stateCarveOf(st)).toBe(
        FY26_CARVE_OUTS[st].sharedServices + FY26_CARVE_OUTS[st].splitState
      );
    }
    expect(statePoolOf("VIC", FY26_PUBLISHED.VIC.totalCap)).toBeCloseTo(1_343_396.32, 2);
    expect(statePoolOf("NSW", FY26_PUBLISHED.NSW.totalCap)).toBeCloseTo(1_194_970.16, 2);
  });

  it("the headline moves one-for-one with the total cap", () => {
    const base = statePoolOf("VIC", 1_000_000);
    expect(statePoolOf("VIC", 1_000_001) - base).toBe(1);
    expect(statePoolOf("NSW", 5.25) - statePoolOf("NSW", 4.25)).toBe(1);
  });

  it("attachFy26Carves adds both carves and leaves everything else alone", () => {
    const caps = { vCap: 10, nCap: 20, gCap: 30, companyModifier: 1 };
    const out = attachFy26Carves(caps);
    expect(out).toEqual({
      ...caps,
      vCarve: 162_541 + 87_637,
      nCarve: 145_505 + 25_239,
    });
    // the attached data IS the state pool, so capRoom's `cap - carve` and the
    // card headline cannot come apart
    expect(out.vCap - out.vCarve).toBe(statePoolOf("VIC", caps.vCap));
    expect(out.nCap - out.nCarve).toBe(statePoolOf("NSW", caps.nCap));
    expect(caps).not.toHaveProperty("vCarve"); // input untouched
  });
});
