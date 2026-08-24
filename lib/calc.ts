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
 * DISCRETIONARY UPDATE (business-owner decision, 25 August 2026, reversing
 * the 24 August 2026 pool-funded reform and restoring the "DA on top" model
 * that preceded it): a discretionary adjustment is a plain manual amount ON
 * TOP of the pool calculation, may be negative, and is not funded from the
 * capped pools. Consequences, all deliberate:
 *  - calcBonus is the scaled pool bonus alone; finalBonus = calcBonus +
 *    daEdit, so the dashboard identity "Calc bonus + Discretionary = Final"
 *    holds exactly on every unlocked row, and typing a DA of X gives the
 *    recipient exactly X more.
 *  - A DA enters no pool deduction and moves no scale, so it shaves nobody
 *    else's bonus — not the other unlocked rows', not the recipient's own.
 *    Every pool total therefore rises by exactly the DA, which is what the
 *    owner asked for: the figure on the card has to move with the grant.
 *  - The bound is the cap itself. getMaxDA is the room left under the caps
 *    the pool cards measure against — the row's home-state cap and the group
 *    cap — so a discretionary field blocks automatically at the point its
 *    pool would pass its cap. The editor holds input to it at type time and
 *    /api/state refuses anything above it.
 *  - The engine itself does NOT clamp stored figures: a figure that already
 *    over-runs a cap stays exactly as typed and the overshoot is surfaced
 *    (red pool card) rather than silently trimmed, consistent with
 *    /api/state's "the figure the user typed is the figure they keep or the
 *    figure they are told they cannot have" principle.
 *  - When every daEdit is 0 the output is bit-identical to the pool-funded
 *    model it replaces (proven by the frozen "no-da" golden scenario).
 * A locked row's frozen finalBonus still includes whatever DA it carried at
 * lock time, and that whole frozen figure is deducted from the pool through
 * the locked branch — locking a row is what puts its DA inside the pool.
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
  /**
   * The scale applied to every unlocked row. Discretionary amounts are not in
   * it — they sit on top of the pool (see the module header), so typing one
   * moves no scale.
   */
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
 * The shape both editability rules read. Deliberately not `Employee`: the
 * browser holds a DisplayRow and the server an Employee, and both satisfy
 * this, so the rule has exactly one definition rather than one per caller.
 */
export interface RowRule {
  sm: 0 | 1;
  st: "VIC" | "NSW" | "SHARED";
  /** true when the row draws from at least one pool */
  inPool: boolean;
}

/**
 * The rule underneath both predicates below: a row must draw from a pool at
 * all, and a site manager must be on the NSW pool.
 *
 * The site-manager split is an owner decision (24 August 2026): NSW site
 * managers are adjustable — a discretionary amount rides on top of their fixed
 * bonus, and their bonus can be frozen — while VIC site managers are left
 * alone entirely, so those 16 fixed bonuses stay untouchable. A site manager
 * outside both states (none today) is excluded, the conservative reading of
 * "only NSW".
 */
function isAdjustable(e: RowRule): boolean {
  if (!e.inPool) return false;
  if (e.sm) return e.st === "NSW";
  return true;
}

/**
 * Whether a row can be locked — enforced by /api/state's Gate 2, the import,
 * and the dashboard's lock button.
 *
 * Locking a site manager genuinely freezes them as of 24 August 2026: their
 * frozen payout is what comes off the top of the pool instead of their live
 * figure (see computeScalesAndBonuses). Before that the engine ignored the
 * flag outright, which is why they were barred from carrying it.
 */
export function isLockable(e: RowRule): boolean {
  return isAdjustable(e);
}

/**
 * Whether a row's discretionary adjustment may be edited.
 *
 * The same rule as isLockable today. Kept as its own name because they answer
 * different questions and have already diverged once: before 24 August 2026 a
 * site manager could be neither, then briefly could be adjusted but not
 * locked. Change one without checking the other at your peril.
 */
export function isDaEditable(e: RowRule): boolean {
  return isAdjustable(e);
}

/** RowRule for an Employee-shaped row, whose pool exposure is vp/np. */
export function rowRule(e: Pick<Employee, "sm" | "st" | "vp" | "np">): RowRule {
  return { sm: e.sm, st: e.st, inPool: e.vp + e.np > 0 };
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
      // A site manager's fixed bonus comes off the top. Their discretionary
      // amount does not: like everyone else's, it sits on top of the pool.
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
      // A site manager's draw comes off the top either way; locking only
      // changes WHICH figure that is. Frozen when locked (24 Aug 2026, when
      // NSW site managers became lockable) — and a frozen figure includes
      // whatever DA it carried at lock time — otherwise the live fixed bonus
      // alone, their DA sitting outside the pool. Split by raw vp/np: site
      // managers always reconciled that way, unlike the blended locked rows
      // below.
      const draw = e.locked ? e.finalBonus : e.bipmCalc;
      empLockedVp += draw * e.vp;
      empLockedNp += draw * e.np;
    } else if (e.locked) {
      // A frozen finalBonus already holds whatever DA the row carried at lock
      // time, and the whole figure is deducted once right here.
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
      // The fixed bonus never scales; a discretionary amount rides on top of
      // it, keeping the dashboard identity Calc bonus + Discretionary = Final.
      e.calcBonus = e.bipmCalc;
      // A locked site manager keeps the figure frozen at lock time, exactly as
      // a locked pooled row does — this assignment is what used to make the
      // lock flag a no-op for them.
      if (!e.locked) e.finalBonus = e.bipmCalc + e.daEdit;
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

/**
 * The most a row's discretionary amount may be before its pool passes its cap
 * — the automatic refusal the business owner asked for (25 August 2026): "it
 * will get refused automatically by each discretionary field".
 *
 * A discretionary amount is on top of the pool and moves nothing else, so the
 * room is simply what is left under the caps, measured EXACTLY the way the
 * dashboard's pool cards measure their totals (components/DashboardClient.tsx):
 * Σ finalBonus grouped by HOME STATE against that state's cap, and Σ finalBonus
 * over everyone against the group cap. A row is bounded by both, whichever
 * binds first; Shared Services has no state cap of its own, so only the group
 * bound applies there. Measuring it off the cards rather than off each pool's
 * draw is deliberate: the card is the figure the person is watching, and it is
 * the one that must not go over.
 *
 * The row's own current amount is added back in, so this is "the most this
 * field may hold", not "the most it may go up by" — which is what both the
 * type-time clamp and /api/state's gate need.
 *
 * Reads everyone's finalBonus, so call it only after computeScalesAndBonuses.
 *
 * Floored to whole dollars like the prototype. Returns 0 for a locked row (its
 * payout is frozen, so there is nothing to grant), Infinity for a row drawing
 * from no pool (vp + np === 0: no cap to overrun, and /api/state strips their
 * DA anyway), and can be NEGATIVE when stored figures already exceed a cap —
 * honestly "no room at all", which callers hold at the stored figure rather
 * than dragging it down.
 */
export function getMaxDA(
  e: CalcEmployee,
  emps: readonly CalcEmployee[],
  caps: Caps
): number {
  if (e.locked) return 0;
  if (e.vp + e.np === 0) return Infinity;
  let groupTotal = 0;
  let homeTotal = 0;
  for (const r of emps) {
    groupTotal += r.finalBonus;
    if (r.st === e.st) homeTotal += r.finalBonus;
  }
  // Back out this row's own amount so each figure measures every OTHER draw on
  // the cap, then the room is what the cap has left for this one.
  let room = caps.gCap - (groupTotal - e.daEdit);
  const stateCap =
    e.st === "VIC" ? caps.vCap : e.st === "NSW" ? caps.nCap : null;
  if (stateCap !== null) {
    room = Math.min(room, stateCap - (homeTotal - e.daEdit));
  }
  return Math.floor(room);
}

/** VIC pool allocation of one employee — pool money only, DA sits on top. */
export function getVicAlloc(e: CalcEmployee, pool: PoolState): number {
  // `locked` is tested FIRST, site manager or not: a frozen row draws its
  // frozen payout from the pool, which is what makes the lock real for an NSW
  // site manager (24 Aug 2026). Reversing these two silently unfreezes them.
  if (e.locked) return e.finalBonus * e.vp;
  if (e.sm) return e.bipmCalc * e.vp;
  return e.bipmCalc * e.vp * pool.vicScale;
}

/** NSW pool allocation of one employee — pool money only, DA sits on top. */
export function getNswAlloc(e: CalcEmployee, pool: PoolState): number {
  // `locked` first, for the same reason as getVicAlloc.
  if (e.locked) return e.finalBonus * e.np;
  if (e.sm) return e.bipmCalc * e.np;
  return e.bipmCalc * e.np * pool.nswScale;
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
 * and may deliberately reduce a final bonus, which lowers that pool's total by
 * the same amount rather than lifting anyone else's bonus (the prototype
 * floored at 0; every owner decision since has kept negatives).
 */
export function parseDaInput(val: string): number {
  return parseFloat(val.replace(/[^\d.-]/g, "")) || 0;
}
