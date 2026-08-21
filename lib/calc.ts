/**
 * Bonus pool calculation engine, originally ported 1:1 from the prototype
 * ("FY26 EBS Dashboard - Secure.html", computeScalesAndBonuses / getMaxDA).
 *
 * Pure functions only — no data imports, no I/O. This module is shared by:
 *  - the server (scoping read-only views, revalidating persisted edit state)
 *  - the editor client (instant recalc on edits, like the prototype)
 *  - the Vitest suite
 *
 * FY26 METHODOLOGY UPDATE (the "EBS FY26 Hardcoded v2" workbook): two
 * deliberate changes to computeScalesAndBonuses, both confirmed by
 * reconciling every one of that workbook's 146 employees to the cent
 * (previously 72 mismatched; now 146/146):
 *  1. A pool's scale is capped at 1.0 (see clampScale) — an under-subscribed
 *     pool no longer scales everyone up above 100% to force the cap to be
 *     fully spent; the remainder is left unpaid ("Pool Remaining" in the
 *     workbook). Previously uncapped.
 *  2. A locked (non-site-manager) employee's contribution to each state's
 *     pool deduction is now split using a preliminary "no locks" scale pass
 *     (see vicScaleNoLocks/nswScaleNoLocks) rather than their raw vp/np
 *     weight — matching the workbook's own "VIC/NSW Scale (no locks)" line.
 *     Site managers are unaffected — they still split by raw vp/np, which
 *     already reconciled correctly.
 *
 * DISCRETIONARY UPDATE (business-owner decision, Aug 2026): a discretionary
 * adjustment is a plain manual amount ON TOP of the pool calculation, may be
 * negative, and is no longer funded from the capped pools. Consequences,
 * all deliberate:
 *  - calcBonus is the scaled pool bonus alone; finalBonus = calcBonus +
 *    daEdit, so the dashboard identity "Calc bonus + Discretionary = Final"
 *    holds exactly on every unlocked row.
 *  - Entering a DA no longer moves any pool scale, so it no longer shaves
 *    everyone else's (or the recipient's own) scaled bonus.
 *  - Totals can exceed a pool cap by exactly the net DA amounts — visible on
 *    the pool cards, which compare actual payout against the cap.
 *  - The old "maximum absorbable DA" clamp (getMaxDA/clampDaToPool) is gone:
 *    a DA outside the pool has no pool-derived bound. It is not silently
 *    clamped either — a save that would push a scoped manager above their own
 *    pool is REFUSED outright (lib/manager-pool.ts's poolBreach, enforced by
 *    /api/state), so the figure the user typed is the figure they keep or the
 *    figure they are told they cannot have.
 * A locked row's frozen finalBonus still includes whatever DA it carried at
 * lock time and is still deducted from the pool as before.
 */
import type { Employee, Overrides } from "./schema";

export interface CalcEmployee extends Employee {
  /** editable copies (prototype: bpEdit/ipmEdit/daEdit) */
  bpEdit: number;
  ipmEdit: number;
  daEdit: number;
  locked: boolean;
  /** company performance modifier, derived once from the source figures */
  cpm: number;
  preIpm: number;
  /** recomputed "After IPM" figure (prototype overwrites e.bipm) */
  bipmCalc: number;
  calcBonus: number;
  finalBonus: number;
}

export interface Caps {
  vCap: number;
  nCap: number;
  gCap: number;
}

/**
 * Pre-aggregated shared-services figures. The prototype's state views carried
 * these in their blobs; the master view (which this app always computes from)
 * has them at 0 with SHARED rows flowing through the normal aggregation.
 */
export interface SharedAgg {
  sharedBipmVp: number;
  sharedBipmNp: number;
  sharedDaVp: number;
  sharedDaNp: number;
}

export const ZERO_SHARED: SharedAgg = {
  sharedBipmVp: 0,
  sharedBipmNp: 0,
  sharedDaVp: 0,
  sharedDaNp: 0,
};

/** How much of each state's pool the locked rows (and site managers) consume. */
export interface PoolAgg {
  empLockedVp: number;
  empLockedNp: number;
}

export interface PoolState {
  vicScale: number;
  nswScale: number;
  stateVicAvail: number;
  stateNswAvail: number;
  poolAgg: PoolAgg;
}

/**
 * A pool's scale multiplier, clamped to [0, 1]. Confirmed with the FY26
 * methodology update (the workbook's "Pool Remaining" / "Pool Utilisation"
 * figures): an oversubscribed pool still scales everyone down (floor at 0,
 * never negative), but an UNDER-subscribed pool no longer scales people UP
 * above their full entitlement to force the cap to be exactly exhausted —
 * it's capped at exactly 100% and the remainder is left unpaid. This
 * supersedes the previous behaviour (no ceiling), which redistributed any
 * surplus above 100% so the pool cap was always fully consumed.
 */
function clampScale(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * Whether a row can be locked (or take a discretionary adjustment): a site
 * manager's bonus is fixed with nothing to adjust, and a row drawing from no
 * pool has nothing to freeze. The single source of the rule enforced by
 * /api/state's Gate 2, the import, and the dashboard's lock button.
 */
export function isLockable(e: Pick<Employee, "sm" | "vp" | "np">): boolean {
  return !e.sm && e.vp + e.np > 0;
}

/**
 * Derivation the prototype performs at login (lines 252–266):
 * cpm is inferred from the source bipm so that pkg * bp * cpm * ipm === bipm.
 */
export function deriveCpm(e: Employee): { preIpm: number; cpm: number } {
  const preIpm = e.ipm > 0 ? e.bipm / e.ipm : e.bipm;
  const cpm = e.pkg * e.bp > 0 ? preIpm / (e.pkg * e.bp) : 1;
  return { preIpm, cpm };
}

/**
 * Build the working rows: source employees + persisted edit state.
 * Locked rows resume with their frozen finalBonus (`lockedFinal`).
 */
export function applyOverrides(
  emps: Employee[],
  overrides: Overrides
): CalcEmployee[] {
  return emps.map((e) => {
    const { preIpm, cpm } = deriveCpm(e);
    const ov = overrides[e.id] ?? {};
    return {
      ...e,
      bpEdit: ov.bpEdit ?? e.bp,
      ipmEdit: ov.ipmEdit ?? e.ipm,
      daEdit: ov.daEdit ?? e.da,
      locked: ov.locked ?? false,
      cpm,
      preIpm,
      bipmCalc: 0,
      calcBonus: 0,
      finalBonus: ov.locked ? ov.lockedFinal ?? 0 : 0,
    };
  });
}

/**
 * Prototype lines 462–521, behaviour-identical (including the `!== 0 ? … : 1`
 * denominator guards, `Math.max(0, …)` clamps and lock/sm handling).
 * Mutates `emps` in place (calcBonus/finalBonus/bipmCalc) and returns the
 * pool state.
 */
export function computeScalesAndBonuses(
  emps: CalcEmployee[],
  caps: Caps,
  shared: SharedAgg = ZERO_SHARED
): PoolState {
  emps.forEach((e) => {
    e.preIpm = e.pkg * e.bpEdit * e.cpm;
    e.bipmCalc = e.preIpm * e.ipmEdit;
  });

  // Pass 0: a preliminary "no locks" scale — site managers excluded (they're
  // never in the pool at all), but genuinely locked rows flow through as if
  // unlocked. Used purely as a weighting below, never returned: a locked
  // employee's frozen amount still has to come out of *somewhere* in each
  // state's pool, and the fair split for a blended (VIC/NSW) locked row is
  // proportional to what they'd have drawn from each state before any
  // locking happened — not their raw vp/np weight, which was confirmed to
  // disagree with the FY26 model workbook for every blended locked employee
  // (raw-weight split reproduced 74/146 rows; this reproduced 146/146).
  let smVp = 0,
    smNp = 0;
  let bipmVpNoLocks = 0,
    bipmNpNoLocks = 0;
  emps.forEach((e) => {
    if (e.sm) {
      smVp += e.bipmCalc * e.vp;
      smNp += e.bipmCalc * e.np;
    } else {
      bipmVpNoLocks += e.bipmCalc * e.vp;
      bipmNpNoLocks += e.bipmCalc * e.np;
    }
  });
  const vicNoLocksDenom = bipmVpNoLocks + shared.sharedBipmVp;
  const nswNoLocksDenom = bipmNpNoLocks + shared.sharedBipmNp;
  const vicScaleNoLocks =
    vicNoLocksDenom !== 0
      ? clampScale((caps.vCap - smVp - shared.sharedDaVp) / vicNoLocksDenom)
      : 1;
  const nswScaleNoLocks =
    nswNoLocksDenom !== 0
      ? clampScale((caps.nCap - smNp - shared.sharedDaNp) / nswNoLocksDenom)
      : 1;

  let empLockedVp = 0,
    empLockedNp = 0;
  let empBipmVpUnlocked = 0,
    empBipmNpUnlocked = 0;

  emps.forEach((e) => {
    if (e.sm) {
      empLockedVp += e.bipmCalc * e.vp;
      empLockedNp += e.bipmCalc * e.np;
    } else if (e.locked) {
      const wVic = e.vp * vicScaleNoLocks;
      const wNsw = e.np * nswScaleNoLocks;
      const wSum = wVic + wNsw;
      const vpSum = e.vp + e.np;
      const fracVic = wSum > 0 ? wVic / wSum : vpSum > 0 ? e.vp / vpSum : 0;
      empLockedVp += e.finalBonus * fracVic;
      empLockedNp += e.finalBonus * (1 - fracVic);
    } else {
      empBipmVpUnlocked += e.bipmCalc * e.vp;
      empBipmNpUnlocked += e.bipmCalc * e.np;
    }
  });

  // Two-step scale: shared services locked first, DA redistributes within state only.

  // Step 1: base scale (no state DA) — sets shared services' fixed allocation
  const vicBaseDenom = empBipmVpUnlocked + shared.sharedBipmVp;
  const nswBaseDenom = empBipmNpUnlocked + shared.sharedBipmNp;
  const vicBaseScale =
    vicBaseDenom !== 0
      ? clampScale((caps.vCap - empLockedVp - shared.sharedDaVp) / vicBaseDenom)
      : 1;
  const nswBaseScale =
    nswBaseDenom !== 0
      ? clampScale((caps.nCap - empLockedNp - shared.sharedDaNp) / nswBaseDenom)
      : 1;

  // Step 2: lock shared allocation at base scale — DA cannot touch it
  const sharedVicFixed = shared.sharedBipmVp * vicBaseScale + shared.sharedDaVp;
  const sharedNswFixed = shared.sharedBipmNp * nswBaseScale + shared.sharedDaNp;

  // Step 3: state pool = cap minus fixed shared allocation
  const stateVicAvail = caps.vCap - sharedVicFixed;
  const stateNswAvail = caps.nCap - sharedNswFixed;

  // Step 4: state scale. Capped at 1: an under-subscribed pool is no longer
  // scaled up above 100% to force the cap to be fully spent — the remainder
  // is left as "pool remaining" (FY26 methodology update; previously
  // uncapped). Discretionary adjustments are NOT deducted here — they sit on
  // top of the pool entirely (see the module header).
  const vicScale =
    empBipmVpUnlocked !== 0
      ? clampScale((stateVicAvail - empLockedVp) / empBipmVpUnlocked)
      : 1;
  const nswScale =
    empBipmNpUnlocked !== 0
      ? clampScale((stateNswAvail - empLockedNp) / empBipmNpUnlocked)
      : 1;

  emps.forEach((e) => {
    if (e.sm) {
      e.calcBonus = e.bipmCalc;
      e.finalBonus = e.bipmCalc;
    } else if (!e.locked) {
      e.calcBonus = e.bipmCalc * e.vp * vicScale + e.bipmCalc * e.np * nswScale;
      e.finalBonus = e.calcBonus + e.daEdit;
    } else {
      e.calcBonus = e.bipmCalc * e.vp * vicScale + e.bipmCalc * e.np * nswScale;
      // finalBonus stays frozen at its locked value
    }
  });

  return {
    vicScale,
    nswScale,
    stateVicAvail,
    stateNswAvail,
    poolAgg: { empLockedVp, empLockedNp },
  };
}

/** VIC pool allocation of one employee — pool money only, DA sits on top. */
export function getVicAlloc(e: CalcEmployee, vicScale: number): number {
  if (e.sm) return e.bipmCalc * e.vp;
  if (e.locked) return e.finalBonus * e.vp;
  return e.bipmCalc * e.vp * vicScale;
}

/** NSW pool allocation of one employee — pool money only, DA sits on top. */
export function getNswAlloc(e: CalcEmployee, nswScale: number): number {
  if (e.sm) return e.bipmCalc * e.np;
  if (e.locked) return e.finalBonus * e.np;
  return e.bipmCalc * e.np * nswScale;
}

/**
 * Σ final over a set of rows — the single definition of "allocated", shared by
 * the manager header (all in-scope rows) and the table footer (the rows a
 * search or facet leaves visible), so the two can never disagree about what a
 * total is. Generic over the row shape because the server measures
 * CalcEmployee.finalBonus and the browser measures a scoped row's `final`.
 */
export function sumAllocated<T>(
  rows: readonly T[],
  final: (r: T) => number
): number {
  return rows.reduce((s, r) => s + final(r), 0);
}

/** Prototype input parsing: "90" and "0.9" both mean 90%. */
export function parsePercentInput(val: string): number | null {
  const num = parseFloat(val.replace(/[^\d.]/g, ""));
  if (isNaN(num)) return null;
  return num > 1 ? num / 100 : num;
}

/**
 * Input parsing for DA: strip formatting. Negatives are allowed — a
 * discretionary adjustment is a manual amount on top of the pool calculation
 * and may deliberately reduce a final bonus (the prototype floored at 0,
 * superseded by the same owner decision that took DA out of the pools).
 */
export function parseDaInput(val: string): number {
  return parseFloat(val.replace(/[^\d.-]/g, "")) || 0;
}
