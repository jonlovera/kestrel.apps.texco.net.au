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
 * ONE identity, deliberately (owner decision, 25 August 2026, reversing that
 * morning's "Option A"). The state pool is BOTH what the card headline shows
 * and what a grant is refused against, so a lead's "Your pool CAP", the
 * admin's "NSW State Cap", the discretionary-field clamp and /api/state's
 * gate 4 are all the same number. There is no second, looser figure to drift
 * from it — which is exactly what went wrong before: a NSW lead was shown a
 * $1,220,209 budget while the card beside it headlined $1,194,970.
 *
 * What keeps that identity honest is WHO is counted against the pool. The pool
 * is defined net of two carves, and the people those carves fund must not also
 * be measured against it: shared-services staff are `st = "SHARED"` and never
 * in a home total, and the four part-split staff — moved to `st = "VIC"` on
 * 24 Aug 2026, their locked amounts being exactly the split-state carve — are
 * excluded from every home-state total by lib/calc.ts's inStateHomeTotal
 * (cards, capRoom, a lead's Allocated, the redistribution budget, the impact
 * dialog). Before that rule VIC's card read ~$104k over its pool while its
 * whole-pool rows were $9.7k under (docs/bonus-reconciliation.md §9).
 *
 * The Shared Services card's part-split lines show the typed splitState
 * constants below. The live attribution (poolCardTotals's vicPartSplit /
 * nswPartSplit: 90,050 / 23,959 on the 25 Aug population, with-locks scale ×
 * today's payouts) differs from the sheet's no-locks-scale figures and stays
 * open with Dee — docs/bonus-reconciliation.md §9.5. Settling it moves the
 * constants below and nothing else.
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

/** Everything carved off one state's total cap, as a single figure. */
export function stateCarveOf(st: CarveState): number {
  const c = FY26_CARVE_OUTS[st];
  return c.sharedServices + c.splitState;
}

/**
 * The state pool: total cap less BOTH carve-outs. The card headline, a lead's
 * pool, and the figure a grant is refused against — see the module docblock
 * for why those are one number and not three.
 */
export function statePoolOf(st: CarveState, totalCap: number): number {
  return totalCap - stateCarveOf(st);
}

/**
 * Attach the carve-outs to a caps object as optional DATA (`vCarve` /
 * `nCarve`), so lib/calc.ts's capRoom can net them without knowing where they
 * came from. `cap - carve` is therefore statePoolOf by construction, which is
 * what keeps the engine's bound and the cards one identity. Fields absent =
 * carve 0 = the pre-FY26 behaviour, which is what every synthetic-cap test
 * fixture relies on.
 */
export function attachFy26Carves<T extends { vCap: number; nCap: number }>(
  caps: T
): T & { vCarve: number; nCarve: number } {
  return {
    ...caps,
    vCarve: stateCarveOf("VIC"),
    nCarve: stateCarveOf("NSW"),
  };
}
