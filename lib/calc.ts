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
 * DISCRETIONARY UPDATE (business-owner decision, 24 August 2026, reversing
 * the earlier "DA on top" decision from August 2026): a discretionary
 * adjustment is funded from the capped pools again, as in the original
 * prototype, with one refinement over the prototype: the recipient is priced
 * at the BASE scale (the scale ignoring all DA), so editing a DA never moves
 * the recipient's own scaled bonus. Consequences, all deliberate:
 *  - calcBonus is the scaled pool bonus alone; finalBonus = calcBonus +
 *    daEdit, so the dashboard identity "Calc bonus + Discretionary = Final"
 *    still holds exactly on every unlocked row, and typing a DA of X gives
 *    the recipient exactly X more.
 *  - A DA row's whole draw (base-scaled bonus plus DA) is deducted from the
 *    pool like a locked amount before the remaining unlocked rows are
 *    scaled, so everyone else pro-rata funds the DA and the pool total
 *    stays within the cap.
 *  - Negative DA remains allowed and frees pool money back to the others.
 *  - getMaxDA is restored: it is the largest DA the pool can absorb before
 *    the remaining rows' scale floors at 0. The editor clamps DA input to it
 *    at type time. The engine itself does NOT clamp stored figures: an
 *    over-cap DA already persisted simply floors the scale at 0 and the
 *    overshoot is surfaced (red pool card) rather than silently trimmed,
 *    consistent with /api/state's "the figure the user typed is the figure
 *    they keep or the figure they are told they cannot have" principle.
 *  - When every daEdit is 0 the output is bit-identical to the previous
 *    model (proven by the frozen "no-da" golden scenario).
 * A locked row's frozen finalBonus still includes whatever DA it carried at
 * lock time and is still deducted from the pool once, through the locked
 * branch; a locked row is never treated as a DA row.
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
  /** DA rows' whole pool draw (base-scaled bonus plus DA), per state. */
  daDrawVp: number;
  daDrawNp: number;
}

export interface PoolState {
  /**
   * The scale applied to unlocked rows WITHOUT a DA. When any DA exists this
   * sits below the base scale (the DA rows' draw comes off the top first).
   */
  vicScale: number;
  nswScale: number;
  /**
   * The scale ignoring all DA, identical to the pre-reform scale. DA rows'
   * own bonuses are priced at this scale so a DA edit never moves the
   * recipient's calc bonus. Equals vicScale/nswScale when no DA exists.
   */
  vicScaleBase: number;
  nswScaleBase: number;
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
 * managers are adjustable — a discretionary amount rides on their fixed bonus
 * off the top of the pool, and their bonus can be frozen — while VIC site
 * managers are left alone entirely, so those 16 fixed bonuses stay
 * untouchable. A site manager outside both states (none today) is excluded,
 * the conservative reading of "only NSW".
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
      // A site manager's whole draw is fixed off the top — the fixed bonus
      // and, since 24 Aug 2026, any discretionary amount on top of it.
      smVp += e.bipmCalc * e.vp + e.daEdit * e.vp;
      smNp += e.bipmCalc * e.np + e.daEdit * e.np;
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
  // DA rows (unlocked, daEdit !== 0) and the rest, accumulated separately —
  // nonDa* is NOT derived by subtraction, so with no DA rows it sums exactly
  // the same terms in the same order as empBipm*Unlocked and the whole
  // pipeline stays bit-identical to the pre-reform engine.
  let daBipmVp = 0,
    daBipmNp = 0;
  let daVp = 0,
    daNp = 0;
  let nonDaBipmVp = 0,
    nonDaBipmNp = 0;

  emps.forEach((e) => {
    if (e.sm) {
      // A site manager's whole draw comes off the top either way; locking only
      // changes WHICH figure that is. Frozen when locked (24 Aug 2026, when
      // NSW site managers became lockable), otherwise the live fixed bonus
      // plus any discretionary amount. Split by raw vp/np — site managers
      // always reconciled that way, unlike the blended locked rows below.
      const draw = e.locked ? e.finalBonus : e.bipmCalc + e.daEdit;
      empLockedVp += draw * e.vp;
      empLockedNp += draw * e.np;
    } else if (e.locked) {
      // A locked row is never a DA row: its frozen finalBonus already holds
      // whatever DA it carried at lock time, deducted once right here.
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
      if (e.daEdit !== 0) {
        daBipmVp += e.bipmCalc * e.vp;
        daBipmNp += e.bipmCalc * e.np;
        daVp += e.daEdit * e.vp;
        daNp += e.daEdit * e.np;
      } else {
        nonDaBipmVp += e.bipmCalc * e.vp;
        nonDaBipmNp += e.bipmCalc * e.np;
      }
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

  // Step 4: state scales. Capped at 1: an under-subscribed pool is no longer
  // scaled up above 100% to force the cap to be fully spent — the remainder
  // is left as "pool remaining" (FY26 methodology update; previously
  // uncapped).
  //
  // Step 4a: base scale, ignoring all DA. Same formula as the pre-reform
  // engine, so it never moves when a DA is typed. DA recipients' own bonuses
  // are priced at this scale (recipient stability, see the module header).
  const vicScaleBase =
    empBipmVpUnlocked !== 0
      ? clampScale((stateVicAvail - empLockedVp) / empBipmVpUnlocked)
      : 1;
  const nswScaleBase =
    empBipmNpUnlocked !== 0
      ? clampScale((stateNswAvail - empLockedNp) / empBipmNpUnlocked)
      : 1;

  // Step 4b: DA rows' whole pool draw (base-scaled bonus plus DA) comes off
  // the top like a locked amount, and the remaining unlocked non-DA rows are
  // scaled to what is left. With no DA rows this reduces to the base scale
  // exactly (daDraw is 0 and nonDaBipm sums the same terms).
  const daDrawVp = daBipmVp * vicScaleBase + daVp;
  const daDrawNp = daBipmNp * nswScaleBase + daNp;
  const vicScale =
    nonDaBipmVp !== 0
      ? clampScale((stateVicAvail - empLockedVp - daDrawVp) / nonDaBipmVp)
      : 1;
  const nswScale =
    nonDaBipmNp !== 0
      ? clampScale((stateNswAvail - empLockedNp - daDrawNp) / nonDaBipmNp)
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
      const v = e.daEdit !== 0 ? vicScaleBase : vicScale;
      const n = e.daEdit !== 0 ? nswScaleBase : nswScale;
      e.calcBonus = e.bipmCalc * e.vp * v + e.bipmCalc * e.np * n;
      e.finalBonus = e.calcBonus + e.daEdit;
    } else {
      e.calcBonus = e.bipmCalc * e.vp * vicScale + e.bipmCalc * e.np * nswScale;
      // finalBonus stays frozen at its locked value
    }
  });

  return {
    vicScale,
    nswScale,
    vicScaleBase,
    nswScaleBase,
    stateVicAvail,
    stateNswAvail,
    poolAgg: { empLockedVp, empLockedNp, daDrawVp, daDrawNp },
  };
}

/**
 * The largest discretionary adjustment a row can carry before the remaining
 * unlocked rows' scale floors at 0, i.e. before the pool cap would be
 * breached. Restored with the 24 August 2026 pool-funded DA reform (the
 * prototype had it as getMaxDA/clampDaToPool), with one new term: the
 * recipient's own base-scaled draw also comes off the top, because the
 * recipient is pinned at the base scale rather than scaled with the rest.
 *
 * Floored to whole dollars like the prototype. Returns 0 for rows that
 * cannot take a DA (locked rows — a site manager can take one since 24 Aug
 * 2026, funded off the top like their fixed bonus), Infinity for rows
 * drawing from no pool (vp + np === 0: no pool bound; /api/state strips
 * their DA anyway), and can be NEGATIVE when already-stored figures
 * over-draw the pool (pre-reform data): the pool has no room at all.
 */
export function getMaxDA(e: CalcEmployee, pool: PoolState): number {
  if (e.locked) return 0;
  const { empLockedVp, empLockedNp, daDrawVp, daDrawNp } = pool.poolAgg;
  if (e.sm) {
    // A site manager's whole draw (fixed bonus + current DA) already sits
    // inside empLocked*; back out only the DA so the room measures every
    // OTHER draw on the pool. Their fixed bonus is a given, not headroom.
    const vicRoomSm = pool.stateVicAvail - (empLockedVp - e.daEdit * e.vp) - daDrawVp;
    const nswRoomSm = pool.stateNswAvail - (empLockedNp - e.daEdit * e.np) - daDrawNp;
    let maxSm = Infinity;
    if (e.vp > 0) maxSm = Math.min(maxSm, vicRoomSm / e.vp);
    if (e.np > 0) maxSm = Math.min(maxSm, nswRoomSm / e.np);
    return Number.isFinite(maxSm) ? Math.floor(maxSm) : Infinity;
  }
  // This row's own current contribution to daDraw* (0 if it has no DA), so
  // the room measures every OTHER draw on the pool.
  const ownDrawVp =
    e.daEdit !== 0 ? e.bipmCalc * e.vp * pool.vicScaleBase + e.daEdit * e.vp : 0;
  const ownDrawNp =
    e.daEdit !== 0 ? e.bipmCalc * e.np * pool.nswScaleBase + e.daEdit * e.np : 0;
  const vicRoom =
    pool.stateVicAvail -
    empLockedVp -
    (daDrawVp - ownDrawVp) -
    e.bipmCalc * e.vp * pool.vicScaleBase;
  const nswRoom =
    pool.stateNswAvail -
    empLockedNp -
    (daDrawNp - ownDrawNp) -
    e.bipmCalc * e.np * pool.nswScaleBase;
  let maxDa = Infinity;
  if (e.vp > 0) maxDa = Math.min(maxDa, vicRoom / e.vp);
  if (e.np > 0) maxDa = Math.min(maxDa, nswRoom / e.np);
  return Number.isFinite(maxDa) ? Math.floor(maxDa) : Infinity;
}

/**
 * VIC pool allocation of one employee, including any DA draw: a DA row is
 * priced at the base scale plus its vp-weighted DA (24 August 2026 reform).
 */
export function getVicAlloc(e: CalcEmployee, pool: PoolState): number {
  // `locked` is tested FIRST, site manager or not: a frozen row draws its
  // frozen payout from the pool, which is what makes the lock real for an NSW
  // site manager (24 Aug 2026). Reversing these two silently unfreezes them.
  if (e.locked) return e.finalBonus * e.vp;
  if (e.sm) return e.bipmCalc * e.vp + e.daEdit * e.vp;
  if (e.daEdit !== 0)
    return e.bipmCalc * e.vp * pool.vicScaleBase + e.daEdit * e.vp;
  return e.bipmCalc * e.vp * pool.vicScale;
}

/**
 * NSW pool allocation of one employee, including any DA draw: a DA row is
 * priced at the base scale plus its np-weighted DA (24 August 2026 reform).
 */
export function getNswAlloc(e: CalcEmployee, pool: PoolState): number {
  // `locked` first, for the same reason as getVicAlloc.
  if (e.locked) return e.finalBonus * e.np;
  if (e.sm) return e.bipmCalc * e.np + e.daEdit * e.np;
  if (e.daEdit !== 0)
    return e.bipmCalc * e.np * pool.nswScaleBase + e.daEdit * e.np;
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
 * Input parsing for DA: strip formatting. Negatives are allowed: a negative
 * discretionary adjustment deliberately reduces a final bonus and frees pool
 * money back to the other unlocked rows (the prototype floored at 0; the
 * 24 August 2026 reform kept negatives when it moved DA back into the pool).
 */
export function parseDaInput(val: string): number {
  return parseFloat(val.replace(/[^\d.-]/g, "")) || 0;
}
