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
 *
 * REDISTRIBUTION IS BY WRITING, NOT BY SCALING (owner decision, 24 August
 * 2026, replacing a funding flag that briefly did the opposite). This engine
 * has exactly one discretionary model: the amount sits ON TOP of the scaled
 * pool bonus. It enters no pool deduction, moves no scale, and therefore
 * shaves nobody else's calculated bonus.
 *
 * Who takes part in a redistribution is not modelled here at all, and that is
 * deliberate. It is a transient selection the user makes in the browser, and
 * lib/redistribute.ts turns it into explicit amounts. Nothing about it is
 * persisted, and nothing about it reaches this engine.
 *
 * Why it was built that way, since the alternative was tried first: funding an
 * amount from the pool means moving the scale, and NSW_FULL_ENTITLEMENT pins
 * nswScale at 1 — so there is no scale to move and the whole mechanism was
 * inert for every NSW row. Moving the scale also reaches the whole state,
 * which meant one lead's decision silently reflowed another lead's people.
 * Writing amounts has neither problem: it works identically in both states,
 * and it touches only the rows the redistributing lead actually owns.
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
  /**
   * The stored payout-before-discretionary, if this row has one. See
   * lib/schema.ts. Carried through so the bonus loop can read it; `undefined`
   * means fall back (which never involves the lock flag).
   */
  baseAmount?: number;
  /** the legacy frozen figure, read as a base for rows locked before 25 Aug 2026 */
  lockedFinal?: number;
  /** recomputed "After IPM" figure (prototype overwrites e.bipm) */
  bipmCalc: number;
  calcBonus: number;
  finalBonus: number;
}

export interface Caps {
  vCap: number;
  nCap: number;
  gCap: number;
  /**
   * Optional carve-outs netted off each state's cap when a grant is BOUNDED
   * (capRoom), and nowhere else — the engine's scales run on the raw caps. FY26
   * attaches the shared-services figures here (lib/fy26-caps.ts's
   * attachFy26Carves) so a state's payouts are held to Dee Gibson's binding
   * state cap rather than the total cap. Absent = 0 = the raw cap binds, which
   * is what every synthetic fixture in the tests means by `vCap`.
   */
  vCarve?: number;
  nCarve?: number;
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
 * NSW PAYS FULL ENTITLEMENT (owner decision, 25 August 2026, taken while
 * looking at an NSW lead's tab where "Calc bonus" summed $36,020 below "After
 * IPM"): the NSW scale is pinned at 1, so an NSW calc bonus is always exactly
 * that row's After IPM figure and nobody is pro-rated down.
 *
 * Why it was below: the NSW cap does not fund only NSW-home people. Anyone
 * whose cost splits — a Shared Services role, or a VIC employee doing a
 * portion of NSW work — draws their np share from it, $184,243 of it in the
 * 21 August 2026 capture. So the NSW tab summed $1,074,487 against a
 * $1,194,970 cap and looked to have room, while the pool itself owed
 * $1,230,990 and was genuinely oversubscribed, scaling everyone to 0.9594.
 * The alternative fix was to raise nCap to $1,234,562 (the point where the
 * scale clamps at 1 on its own); pinning it was the decision taken instead.
 *
 * What this costs, stated plainly: the NSW cap no longer constrains NSW
 * payouts through scaling. The pool draw can exceed nCap — the pool card
 * shows that as an over-cap figure, which is now expected rather than a fault
 * — and it will keep doing so as IPM or package figures rise, with no
 * automatic correction. Flip this to false to restore cap-driven scaling;
 * nothing else needs to change, and the VIC side is untouched either way.
 *
 * Deliberately NOT applied to vicScaleNoLocks/nswScaleNoLocks (pass 0 below).
 * Those weight how a blended locked row's frozen amount is attributed between
 * the two pools; changing them would move VIC's scale, and no VIC figure
 * should move because of an NSW decision.
 */
const NSW_FULL_ENTITLEMENT: boolean = true;

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
 * A row whose cost splits across BOTH pools is funded by a carve-out, never by
 * a state pool: the corporate-ratio Shared Services staff by the
 * shared-services carve, the part-split staff (their own ratio) by the
 * split-state carve. The FY26 state pools are DEFINED net of both
 * (lib/fy26-caps.ts), so such a row's payout must never also be measured
 * against a state pool — whatever state label it carries.
 */
export function isCarveFunded(e: { vp: number; np: number }): boolean {
  return e.vp > 0 && e.np > 0;
}

/**
 * Whether a row counts in the home-state total a STATE POOL is measured
 * against — the cards' Remaining, capRoom, a whole-state lead's Allocated, the
 * redistribution budget. False for a carve-funded row labelled VIC or NSW:
 * the four part-split staff moved to `st = "VIC"` on 24 Aug 2026 kept their
 * split, and counting their whole payouts against a pool already net of them
 * charged VIC twice (docs/bonus-reconciliation.md §9). A SHARED row is never
 * in a home total anyway, so `true` there is harmless and keeps this a
 * statement about state pools only.
 */
export function inStateHomeTotal(e: { vp: number; np: number; st: string }): boolean {
  return !((e.st === "VIC" || e.st === "NSW") && isCarveFunded(e));
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
 *
 * Note what is NOT here any more: the lock flag no longer selects which figure
 * a row is paid. It used to — `locked ? lockedFinal : (derived)` — and that is
 * why toggling a lock moved the row's own payout by however far the two had
 * drifted apart (44 of 49 rows, up to $15,529). A payout now has one source,
 * resolved in computeScalesAndBonuses without reference to `locked` at all.
 */
export function applyOverrides(
  emps: Employee[],
  overrides: Overrides
): CalcEmployee[] {
  return emps.map((e) => {
    const { preIpm, cpm } = deriveCpm(e);
    const ov = overrides[e.id] ?? {};
    // The same two rules /api/state's gate 2, the table and the import enforce,
    // applied here as well — because this is the function that decides what is
    // PAID. Without them a figure stranded by a rule change keeps being paid:
    // for ~35 minutes on 24 Aug 2026 every site manager's discretionary cell
    // was editable in production, and after b8b22a1 restricted that to NSW the
    // amounts typed into VIC site managers were still being paid while their
    // cell rendered a dash — invisible, and unreachable from the row. Tolerant
    // at the load site, strict on save: the same shape as dropInvalidRules
    // (lib/access-rules.ts) and dropRetiredFields (lib/columns.ts).
    const rule = rowRule(e);
    const locked = isLockable(rule) ? ov.locked ?? false : false;
    return {
      ...e,
      bpEdit: ov.bpEdit ?? e.bp,
      ipmEdit: ov.ipmEdit ?? e.ipm,
      // Covers the source-data fallback too, which the save gate cannot reach:
      // an imported `da` on a row that may not carry one would otherwise be
      // paid with no override and no history entry behind it.
      daEdit: isDaEditable(rule) ? ov.daEdit ?? e.da : 0,
      locked,
      baseAmount: ov.baseAmount,
      // Gated by the same rule as `locked` and `daEdit` above: a row the scheme
      // will not let anyone freeze must not be PAID a frozen figure either.
      // Without this, a `lockedFinal` stranded on a VIC site manager by the
      // 24 Aug 2026 NSW-only split would come back to life as their payout base
      // — undoing 6060a90, which stopped exactly that.
      lockedFinal: isLockable(rule) ? ov.lockedFinal : undefined,
      cpm,
      preIpm,
      bipmCalc: 0,
      calcBonus: 0,
      finalBonus: 0,
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

  // Site managers come off the top of each pool at their fixed draw; everyone
  // else shares what is left. The lock flag is not consulted anywhere in here —
  // it is a protection state, not an allocation input, which is why locking
  // somebody moves nobody's calculated bonus.
  let empLockedVp = 0,
    empLockedNp = 0;
  let empBipmVpUnlocked = 0,
    empBipmNpUnlocked = 0;

  emps.forEach((e) => {
    if (e.sm) {
      // Lock state is deliberately ignored for pool math: it is a payout
      // freeze only, not a redistribution trigger.
      empLockedVp += e.bipmCalc * e.vp;
      empLockedNp += e.bipmCalc * e.np;
    } else {
      empBipmVpUnlocked += e.bipmCalc * e.vp;
      empBipmNpUnlocked += e.bipmCalc * e.np;
    }
  });

  // Two-step scale: shared services' allocation is fixed first, so a state's
  // discretionary spending can never reach into it.

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
  // uncapped).
  //
  // No discretionary term here, by design. Every amount sits on top of the
  // pool, so nothing anyone grants moves the scale and nobody's calculated
  // bonus is shaved by somebody else's amount. Redistribution is done by
  // WRITING amounts (lib/redistribute.ts), never by moving this.
  const vicScale =
    empBipmVpUnlocked !== 0
      ? clampScale((stateVicAvail - empLockedVp) / empBipmVpUnlocked)
      : 1;
  const nswScaleFromCap =
    empBipmNpUnlocked !== 0
      ? clampScale((stateNswAvail - empLockedNp) / empBipmNpUnlocked)
      : 1;
  // Pinned at 1 since 25 Aug 2026 — see NSW_FULL_ENTITLEMENT. The cap-derived
  // figure is kept named rather than deleted: this is one flag away from being
  // live again, and the arithmetic is the same arithmetic VIC still uses.
  const nswScale = NSW_FULL_ENTITLEMENT ? 1 : nswScaleFromCap;

  emps.forEach((e) => {
    // "Calc bonus" — ADVISORY. What the formula says this row would draw from
    // the pool at today's caps and IPM. Shown, never paid: an IPM or cap edit
    // moves this column and leaves the payout alone (owner decision, 25 Aug
    // 2026). A site manager's fixed bonus does not scale, as ever.
    e.calcBonus = e.sm
      ? e.bipmCalc
      : e.bipmCalc * e.vp * vicScale + e.bipmCalc * e.np * nswScale;

    // THE PAYOUT — one expression, every row, and `locked` is not in it.
    //
    // `baseAmount` is the stored figure, and every row in the live document has
    // one: it was seeded by scripts/seed-base-amounts.ts, and both paths that
    // create a row write one (/api/dataset's add, and seedImportedBases for an
    // import). Two fallbacks behind it, neither reading the lock flag, and both
    // permanent rather than transitional:
    //  - `lockedFinal`, for a row frozen before 25 Aug 2026. It was stored as
    //    calc+DA at lock time, so the base it implies is that figure less the
    //    amount. Only a locked row can ever carry one, which is what lets it be
    //    read unconditionally — and is what made lock and unlock
    //    number-neutral for those rows before the seed ran at all.
    //  - the advisory figure. This is the last derivation in the payout path
    //    and it STAYS, because /admin/snapshots can restore any of the 127
    //    documents taken before `baseAmount` existed. Without this leg such a
    //    restore would pay every single person $0 — the fallback is what keeps
    //    an old restore point meaning what it meant when it was taken. It is
    //    also the honest answer for a row nobody has priced yet: what the
    //    formula says they are owed.
    const base =
      e.baseAmount ??
      (e.lockedFinal !== undefined ? e.lockedFinal - e.daEdit : e.calcBonus);
    e.finalBonus = base + e.daEdit;
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
 * WHICH CAPS BOUND A GRANT (owner decision, 25 August 2026, after a lead was
 * refused a grant by a cap they are not shown).
 *
 *   "both"   the home-state cap AND the group cap, whichever binds first.
 *            What an admin gets: they see all four pool cards, they own every
 *            cap, and they are the one who can raise one.
 *   "state"  the home-state cap alone. What a SCOPED LEAD gets, so they are
 *            judged against the pool their own header actually shows.
 *
 * Why the group cap had to stop binding a lead. scripts/import.ts defaults
 * gCap to vCap + nCap, and that identity holds in every capture we have — so
 * the group cap has no headroom of its own, and Shared Services (which counts
 * in the group total but has no state cap of its own, see capRoom) eats the
 * states' combined room dollar for dollar. In the 21 August 2026 capture that
 * left $143,453 of group room against $274,282 VIC and $291,227 NSW: the group
 * bound was tighter than either state bound by the whole $422,056 Shared
 * Services total, permanently, for every grant in the system. A lead is
 * deliberately never sent vCap/nCap/gCap (lib/scope-core.ts), so the figure
 * refusing them was one they could not see, derive, or plan around.
 *
 * What this costs, stated plainly: a lead spending their state's room can now
 * take the GROUP total past gCap. That surfaces as a red group card on the
 * admin's dashboard — expected rather than a fault, the same bargain
 * NSW_FULL_ENTITLEMENT already struck with nCap.
 */
export type CapBound = "both" | "state";

/**
 * The most a row's discretionary amount may be before its pool passes its cap
 * — the automatic refusal the business owner asked for (25 August 2026): "it
 * will get refused automatically by each discretionary field".
 *
 * A discretionary amount is on top of the pool and moves nothing else, so the
 * room is simply what is left under the caps that apply (see CapBound),
 * measured EXACTLY the way the dashboard's pool cards measure their totals
 * (components/DashboardClient.tsx): Σ finalBonus grouped by HOME STATE against
 * that state's cap, and — for `bound: "both"` only — Σ finalBonus over everyone
 * against the group cap. Measuring it off the cards rather than off each pool's
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
 * payout is frozen, so there is nothing to grant) and Infinity for a row with
 * no cap left to bound it — either it draws from no pool (vp + np === 0, and
 * /api/state strips its DA anyway) or it is a Shared Services row — or any
 * other carve-funded row (inStateHomeTotal false) — under `bound: "state"`,
 * which has no state cap of its own. Callers treat a non-finite ceiling as "no
 * bound here"; for a lead the binding constraint is then their own pool, which
 * lib/manager-pool.ts's poolBreach enforces.
 *
 * Can be NEGATIVE when stored figures already exceed a cap — honestly "no room
 * at all", which callers hold at the stored figure rather than dragging down.
 */
export function getMaxDA(
  e: CalcEmployee,
  emps: readonly CalcEmployee[],
  caps: Caps,
  bound: CapBound = "both"
): number {
  // No lock branch here, deliberately. This used to return 0 for a locked row,
  // from when a locked row's payout came from a different source and topping it
  // up meant something. A payout is now an ordinary stored figure that the lock
  // flag does not touch, so a flat 0 protected nothing and refused real grants:
  // with $145,904 of VIC room left, changing an already-locked row's amount was
  // refused as "at most $0 can be granted", because the row was locked before
  // the save and after it. The caps are the only real bound. What the lock
  // protects is the payout from being RECALCULATED, and nothing recalculates it;
  // a deliberate edit is what the history's grant entries record.
  if (e.vp + e.np === 0) return Infinity;
  return Math.floor(capRoom(e, emps, caps, bound));
}

/**
 * Room left under the applicable caps for one row, measured EXACTLY the way
 * the dashboard's pool cards measure their totals: Σ finalBonus over the rows
 * that COUNT in a home state (inStateHomeTotal) against that state's cap, and
 * (under "both") Σ finalBonus over everyone against the group cap, whichever
 * binds first. A carve-funded row — Shared Services, or a part-split person
 * whatever their state label — is funded from outside the state pool, so it is
 * neither counted in a home total nor bounded by one: the group bound is its
 * only one, and under "state" it therefore has none at all, which is Infinity
 * rather than a cap.
 *
 * The row's own amount is added back in, so this is "the most this field may
 * hold", not "the most it may go up by".
 */
function capRoom(
  e: CalcEmployee,
  emps: readonly CalcEmployee[],
  caps: Caps,
  bound: CapBound
): number {
  let groupTotal = 0;
  let homeTotal = 0;
  for (const r of emps) {
    groupTotal += r.finalBonus;
    if (r.st === e.st && inStateHomeTotal(r)) homeTotal += r.finalBonus;
  }
  // Back out this row's own amount so each figure measures every OTHER draw on
  // the cap, then the room is what the cap has left for this one.
  let room = bound === "both" ? caps.gCap - (groupTotal - e.daEdit) : Infinity;
  // The state cap NET of its carve-outs (Caps.vCarve / nCarve), when attached:
  // the pool the state is actually bound by. Null for a row the pool does not
  // fund. The group cap carries no carve — every payout is in the group total,
  // so nothing there is being funded from outside it.
  const stateCap = !inStateHomeTotal(e)
    ? null
    : e.st === "VIC"
      ? caps.vCap - (caps.vCarve ?? 0)
      : e.st === "NSW"
        ? caps.nCap - (caps.nCarve ?? 0)
        : null;
  if (stateCap !== null) {
    room = Math.min(room, stateCap - (homeTotal - e.daEdit));
  }
  return room;
}

/**
 * VIC pool allocation of one employee — pool money only. A discretionary
 * amount is never part of the draw: it sits on top of the pool, so counting it
 * here would double it against the cap.
 */
export function getVicAlloc(e: CalcEmployee, pool: PoolState): number {
  // Lock state is payout-only. Allocation stays on the live pool draw so a
  // lock toggle cannot reallocate anyone else.
  if (e.sm) return e.bipmCalc * e.vp;
  return e.bipmCalc * e.vp * pool.vicScale;
}

/** NSW pool allocation of one employee — see getVicAlloc. */
export function getNswAlloc(e: CalcEmployee, pool: PoolState): number {
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

/** The figures an admin's pool cards show. See poolCardTotals. */
export interface PoolCardTotals {
  /**
   * THE FIGURE THE VIC POOL IS MEASURED AGAINST: Σ payout over VIC-home rows
   * that count in the home total (inStateHomeTotal) — i.e. excluding the
   * carve-funded part-split staff, whose money the pool is already net of.
   * The same sum capRoom bounds a grant by, so the card's Remaining and gate 4
   * are one number.
   */
  vicHome: number;
  /** The same for NSW. */
  nswHome: number;
  /** the VIC card: VIC-home payouts, less the VIC cap's shared draw */
  vic: number;
  /** the NSW card: NSW-home payouts, less the NSW cap's shared draw */
  nsw: number;
  /** Σ payout over Shared Services rows */
  shared: number;
  /** Σ payout over everyone */
  group: number;
  /** VIC cap money going to people who are not on the VIC card */
  vicOther: number;
  /** NSW cap money going to people who are not on the NSW card */
  nswOther: number;
  /**
   * vCap less the payouts the VIC cap is carrying for people whose cost splits
   * across both states — the LIVE attribution, no longer the card's headline
   * (that is lib/fy26-caps.ts's statePoolOf). See poolCardTotals.
   */
  vicPool: number;
  /** nCap less the same, for NSW. */
  nswPool: number;
  /**
   * The VIC share of the PART-SPLIT staff — those on their own ratio rather than
   * the corporate one. A different population from `vicOther`, and deliberately
   * not a breakdown of `shared`.
   */
  vicPartSplit: number;
  /** The NSW share of the same part-split staff. */
  nswPartSplit: number;
}

/**
 * What the admin pool cards display (owner decision, 26 August 2026).
 *
 * The cards group whole payouts by HOME STATE, so no shared-services person has
 * ever appeared on a state's card — while that state's CAP quietly funds their
 * vp/np fraction. `vicOther`/`nswOther` are that carried money, and each state's
 * headline figure is shown net of it.
 *
 * `st !== "VIC"` rather than `st === "SHARED"` deliberately: if a VIC-home person
 * is ever given an NSW share, their NSW money lands in `nswOther` rather than
 * disappearing — which is the gap these two cards exist to close.
 *
 * `final × vp`, not getVicAlloc: that reports the engine's pool draw with
 * discretionary amounts excluded, and a payout is a stored figure the cap funds
 * in full.
 *
 * The two figures a cap is ENFORCED against are `vicHome` / `nswHome`: Σ payout
 * over the home-state rows that count (inStateHomeTotal), measured exactly as
 * capRoom and /api/state's gate 4 measure them. Everything else here is
 * display: `vic`/`vicOther` (the whole-payout grouping, kept for the
 * reconciliation) and the part-split attribution. A "remaining" derived from
 * any of those would advertise room the save then refuses.
 */
export function poolCardTotals(
  emps: readonly CalcEmployee[],
  pool: PoolState,
  caps: Caps
): PoolCardTotals {
  // Whole payouts by state label, the grouping the reconciliation reads...
  let vicAll = 0;
  let nswAll = 0;
  // ...and the same less the carve-funded rows: what the state POOL funds.
  let vicHome = 0;
  let nswHome = 0;
  let shared = 0;
  let group = 0;
  let vicOther = 0;
  let nswOther = 0;
  // What each cap is carrying for people whose cost splits across both states.
  //
  // These charge the PAYOUT, not a locked amount — nothing here reads the lock
  // flag. So a split employee who is unlocked and re-priced moves both figures:
  // they track what is being paid today, not what was frozen at some point. That
  // is the definition working as intended, not drift to be corrected.
  let vicCarried = 0;
  let nswCarried = 0;
  // Every split row, with its attribution, kept for the part-split pass below:
  // the corporate ratio is not known until all of them have been seen.
  const splitRows: { payout: number; vp: number; fracVic: number }[] = [];
  for (const e of emps) {
    group += e.finalBonus;
    const counts = inStateHomeTotal(e);
    if (e.st === "VIC") {
      vicAll += e.finalBonus;
      if (counts) vicHome += e.finalBonus;
    } else vicOther += e.finalBonus * e.vp;
    if (e.st === "NSW") {
      nswAll += e.finalBonus;
      if (counts) nswHome += e.finalBonus;
    } else nswOther += e.finalBonus * e.np;
    if (e.st === "SHARED") shared += e.finalBonus;

    // Only a genuinely split row is apportioned; a wholly-one-state row is
    // already counted whole on its own card.
    if (isCarveFunded(e)) {
      const wVic = e.vp * pool.vicScale;
      const wNsw = e.np * pool.nswScale;
      const wSum = wVic + wNsw;
      // Weighted by what each pool would actually pay them, which is why the
      // scales are read rather than the raw split. wSum can only be 0 if BOTH
      // scales are 0 (vp and np are both positive here); the raw split is the
      // fallback then, so the payout stays wholly attributed instead of landing
      // entirely on NSW. Same two-step this had before 0442ce9 removed it.
      const fracVic = wSum > 0 ? wVic / wSum : e.vp / (e.vp + e.np);
      vicCarried += e.finalBonus * fracVic;
      nswCarried += e.finalBonus * (1 - fracVic);
      splitRows.push({ payout: e.finalBonus, vp: e.vp, fracVic });
    }
  }

  // PART-SPLIT STAFF: the split rows that are NOT on the corporate ratio.
  //
  // The corporate ratio is INFERRED from the data — the modal vp across the
  // split population — rather than read from a configured value, and that is
  // intended. A future hire on a novel split is classified as part-split
  // automatically, with nothing to remember to update; and if the corporate
  // ratio itself ever changes for everybody, the classification follows it
  // instead of stranding the whole block as "part-split". The trade is that
  // "corporate" is whatever most people share, which is exactly what it means.
  //
  // Note the state label plays no part: every split row today carries
  // st === "SHARED", so `st` cannot separate these two groups — only vp can.
  const corporateVp = modalVp(splitRows);
  let vicPartSplit = 0;
  let nswPartSplit = 0;
  for (const r of splitRows) {
    if (r.vp === corporateVp) continue;
    vicPartSplit += r.payout * r.fracVic;
    nswPartSplit += r.payout * (1 - r.fracVic);
  }

  return {
    vicHome,
    nswHome,
    vic: vicAll - vicOther,
    nsw: nswAll - nswOther,
    shared,
    group,
    vicOther,
    nswOther,
    vicPool: caps.vCap - vicCarried,
    nswPool: caps.nCap - nswCarried,
    vicPartSplit,
    nswPartSplit,
  };
}

/**
 * The ratio most of the split population shares — "corporate" by weight of
 * numbers. Undefined when nobody splits, which leaves every part-split figure
 * at 0 rather than inventing a group.
 *
 * Tie-broken deterministically: most rows wins, then the larger total payout,
 * then the lower vp. Without that, "corporate" would be whichever ratio the
 * iteration happened to reach first once two groups were the same size.
 */
function modalVp(
  rows: readonly { payout: number; vp: number }[]
): number | undefined {
  const byVp = new Map<number, { count: number; payout: number }>();
  for (const r of rows) {
    const seen = byVp.get(r.vp) ?? { count: 0, payout: 0 };
    seen.count += 1;
    seen.payout += r.payout;
    byVp.set(r.vp, seen);
  }
  let best: { vp: number; count: number; payout: number } | undefined;
  for (const [vp, { count, payout }] of byVp) {
    if (
      !best ||
      count > best.count ||
      (count === best.count && payout > best.payout) ||
      (count === best.count && payout === best.payout && vp < best.vp)
    ) {
      best = { vp, count, payout };
    }
  }
  return best?.vp;
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
