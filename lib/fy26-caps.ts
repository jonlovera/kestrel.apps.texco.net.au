/**
 * FY26 pool-cap carve-outs — the two deductions Dee Gibson's signed-off
 * waterfall ('EBS Group - FY26'!F9/F10) takes off each state's TOTAL cap to
 * reach the STATE POOL the sheet actually runs each state against:
 *
 *                              VIC              NSW
 *   Total cap        1,593,574.32     1,365,714.16   (params.vCap / nCap)
 *   Less shared svc    162,541          145,505
 *   Less split state    87,637           25,239
 *   State pool       1,343,396        1,194,970
 *
 * Pure and importable from client and server alike, so the cards, the client
 * clamp and /api/state's gate 4 all read the same constants.
 *
 * Hardcoded deliberately, mirroring the workbook where F9/F10 are typed
 * figures too. The migration path is fields on the params document (with the
 * shared-services figure eventually derived from the SHARED rows once the
 * methodology in docs/bonus-reconciliation.md §8 Q2/Q5 is settled); deferred
 * so that a one-constant change here is all it takes if Dee's answers flip
 * which carve binds.
 *
 * TWO identities live here, and they are not the same number:
 *
 *  - `statePoolOf`: what the CARD HEADLINE shows — the full waterfall down to
 *    the state pool, so the build-up rows sum to the headline exactly.
 *  - `bindingStateCap`: what a GRANT IS REFUSED AGAINST (owner decision,
 *    25 Aug 2026, "Option A") — total cap less shared services ONLY. The four
 *    part-split staff were moved to `st = "VIC"` on 24 Aug, so their whole
 *    payouts already count in VIC's home total; also subtracting the
 *    split-state carve would charge them twice. Shared-services staff are
 *    `st = "SHARED"` and never in a home total, so carving SS out is exactly
 *    consistent with how capRoom measures.
 */

export type CarveState = "VIC" | "NSW";

export const FY26_CARVE_OUTS: Record<
  CarveState,
  { sharedServices: number; splitState: number }
> = {
  VIC: { sharedServices: 162_541, splitState: 87_637 },
  NSW: { sharedServices: 145_505, splitState: 25_239 },
};

/**
 * The published figures, for cross-checking only (lib/fy26-caps.test.ts).
 * Nothing in the app reads these at runtime — the live total caps are
 * params.vCap / nCap, and the pools derive from them through the carve-outs.
 */
export const FY26_PUBLISHED = {
  VIC: { totalCap: 1_593_574.3239418203, statePool: 1_343_396 },
  NSW: { totalCap: 1_365_714.1604075, statePool: 1_194_970 },
  groupCap: 2_959_288.48,
} as const;

/** The card headline: total cap less BOTH carve-outs. */
export function statePoolOf(st: CarveState, totalCap: number): number {
  const c = FY26_CARVE_OUTS[st];
  return totalCap - c.sharedServices - c.splitState;
}

/**
 * The figure a state's payouts are bound by: total cap less shared services
 * (Option A — see the module docblock for why NOT the split-state carve too).
 */
export function bindingStateCap(st: CarveState, totalCap: number): number {
  return totalCap - FY26_CARVE_OUTS[st].sharedServices;
}

/**
 * Attach the binding carve-outs to a caps object as optional DATA
 * (`vCarve` / `nCarve`), so lib/calc.ts's capRoom can net them without
 * knowing where they came from. Fields absent = carve 0 = the pre-FY26
 * behaviour, which is what every synthetic-cap test fixture relies on.
 */
export function attachFy26Carves<T extends { vCap: number; nCap: number }>(
  caps: T
): T & { vCarve: number; nCarve: number } {
  return {
    ...caps,
    vCarve: FY26_CARVE_OUTS.VIC.sharedServices,
    nCarve: FY26_CARVE_OUTS.NSW.sharedServices,
  };
}
