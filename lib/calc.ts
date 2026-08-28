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
import type { Employee, EmployeeOverride, Overrides } from "./schema";

/** The issue stamp as the engine carries it. See lib/schema.ts. */
export type IssuedStamp = NonNullable<EmployeeOverride["issued"]>;

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
  /**
   * Set once the row's bonus has been ISSUED. Present = committed: finalBonus
   * is this amount and nothing derives it, which is what protects it from a
   * Recalculate, an IPM edit, a discretionary edit and an unlock alike.
   */
  issued?: IssuedStamp;
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
  /**
   * THE PERSISTED SCALE FACTORS (owner decision, 27 August 2026). Present once
   * somebody has pressed Recalculate; absent until then.
   *
   * When present, computeScalesAndBonuses USES these instead of deriving its
   * own. That is the whole point: a derived scale moves whenever anybody's IPM
   * moves (the denominator below is weighted by IPM), so one person's edit
   * re-priced the entire population's Calc bonus column. A stored scale cannot
   * move, so an IPM edit reaches exactly one row and the difference lands in
   * Remaining Pool instead of being spread across everyone else.
   *
   * Only /api/recalculate ever writes one, into the params document, from
   * lib/recalculate.ts — which derives it from POTENTIAL BONUS AT 100% IPM
   * rather than from the post-IPM figures the fallback below uses. The two are
   * deliberately different formulas: the fallback is the pre-existing advisory
   * derivation, kept so that every figure on screen is bit-identical to what it
   * was before this existed, and so lib/calc-golden.test.ts still pins it.
   *
   * Absent means "no authoritative scale yet". Note what that does NOT mean:
   * the fallback is for DISPLAY only and must never re-price a payout — see
   * lib/reprice.ts, which declines to touch a pooled row until one is stored.
   */
  vicScale?: number;
  nswScale?: number;
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
export function clampScale(x: number): number {
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
export const NSW_FULL_ENTITLEMENT: boolean = true;

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
  /**
   * The issue stamp, once the row's bonus has been ISSUED (lib/schema.ts).
   * PRESENT means committed: the amount must not move again, so every
   * predicate below refuses the row — the lock, the IPM and the discretionary
   * cells all go read-only, "Unlock all" skips it (it filters on isLockable),
   * and a redistribution passes it over (lib/redistribute.ts reads
   * isDaEditable).
   *
   * Typed as the stamp's IDENTIFYING half rather than as a boolean or as the
   * whole stamp, so that both row shapes carrying one satisfy RowRule
   * structurally and can be handed straight to the predicates, exactly as they
   * already are for sm/st/inPool: a server-side CalcEmployee carries the full
   * stamp, while a lead's ScopedRow may have had `amount` withheld with Final
   * (lib/scope-core.ts). Neither predicate reads the amount — presence is the
   * entire question — so requiring it here would be a type demanding data the
   * decision does not use. Optional, so every caller building a rule from
   * source data alone keeps compiling and keeps meaning "not issued".
   */
  issued?: { at: string; by: string };
}

/**
 * What a caller is additionally permitted to touch, beyond the scheme's
 * default rule. Today one thing: the VIC site managers, by an explicit grant
 * on a full-access rule (`canEditVicSiteManagers`, lib/access-rules.ts —
 * owner decision, 26 August 2026). Derived from a Scope by
 * lib/write-scope.ts's adjustAllowance; the engine itself passes
 * ENGINE_ALLOWANCE, because stored data has already been through the gate.
 */
export interface AdjustAllowance {
  vicSiteManagers: boolean;
}
export const NO_ALLOWANCE: AdjustAllowance = { vicSiteManagers: false };
/**
 * What the ENGINE honours when it reads the stored overrides: everything the
 * scheme can ever permit. The boundary is the write — /api/state's gate 2
 * (lib/scheme-gate.ts) reverts an unauthorised change to the stored value, so
 * a figure on a VIC site manager is there because someone holding the grant
 * put it there, and the payout must follow it whoever is looking.
 */
export const ENGINE_ALLOWANCE: AdjustAllowance = { vicSiteManagers: true };

/**
 * The rule underneath the predicates below: a row must draw from a pool at
 * all, and a site manager must be on the NSW pool — unless the caller holds
 * the VIC site managers grant.
 *
 * The site-manager split is an owner decision (24 August 2026): NSW site
 * managers are adjustable — a discretionary amount rides on top of their fixed
 * bonus, and their bonus can be frozen — while VIC site managers are left
 * alone by default, so those 16 fixed bonuses stay untouchable to anyone not
 * explicitly granted them (26 August 2026: the grant exists, full-access
 * admins only). A site manager outside both states (none today) is excluded,
 * the conservative reading of "only NSW".
 *
 * An ISSUED row is refused before any of that: the amount has been committed,
 * and no grant makes a committed figure editable again.
 */
function isAdjustable(e: RowRule, allow: AdjustAllowance = NO_ALLOWANCE): boolean {
  if (e.issued !== undefined) return false;
  if (!e.inPool) return false;
  if (e.sm) return e.st === "NSW" || (e.st === "VIC" && allow.vicSiteManagers);
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
export function isLockable(e: RowRule, allow: AdjustAllowance = NO_ALLOWANCE): boolean {
  return isAdjustable(e, allow);
}

/**
 * Whether a row's discretionary adjustment may be edited.
 *
 * The same rule as isLockable today. Kept as its own name because they answer
 * different questions and have already diverged once: before 24 August 2026 a
 * site manager could be neither, then briefly could be adjusted but not
 * locked. Change one without checking the other at your peril.
 */
export function isDaEditable(e: RowRule, allow: AdjustAllowance = NO_ALLOWANCE): boolean {
  return isAdjustable(e, allow);
}

/**
 * Whether a row's IPM may be edited. For anyone in a pool it may — IPM moves
 * the advisory Calc bonus and, since payouts became stored figures (25 August
 * 2026), nothing else. A SITE MANAGER is the exception: their IPM RE-PRICES
 * their fixed bonus on save (lib/reprice.ts, owner decision 26 August 2026),
 * so it moves real money and is gated exactly like their lock and
 * discretionary — NSW yes, VIC only with the grant.
 *
 * Its own issued guard, because the pooled leg below returns without going
 * through isAdjustable. Since 27 August 2026 a pooled row's IPM re-prices its
 * payout too (lib/reprice.ts), so this is now a money question for everyone
 * rather than only for site managers — all the more reason an issued row is
 * out.
 */
export function isIpmEditable(e: RowRule, allow: AdjustAllowance = NO_ALLOWANCE): boolean {
  if (e.issued !== undefined) return false;
  if (e.sm) return isAdjustable(e, allow);
  return e.inPool;
}

/**
 * RowRule for an Employee-shaped row, whose pool exposure is vp/np.
 *
 * `issued` rides in as an optional extra rather than being read off `Employee`,
 * because it lives on the OVERRIDE and not on the source record: a CalcEmployee
 * and a DisplayRow both carry one and pass it straight through, while a caller
 * holding only source data passes nothing and means "not issued".
 */
export function rowRule(
  e: Pick<Employee, "sm" | "st" | "vp" | "np"> & { issued?: IssuedStamp }
): RowRule {
  return { sm: e.sm, st: e.st, inPool: e.vp + e.np > 0, issued: e.issued };
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
 * Whether a STATE POOL funds this row at all — the narrower question
 * lib/manager-pool.ts asks of a lead's budget.
 *
 * The difference from inStateHomeTotal above is Shared Services. That
 * predicate answers "does this row belong in a HOME-STATE total", and a SHARED
 * row is never in one, so it returns `true` there and lets the state filter
 * beside it do the excluding. A lead's budget has no state filter beside it —
 * a group rule can hold VIC and SHARED rows together — so it needs the
 * question asked outright, and the answer for a SHARED row is no: it is funded
 * by the shared-services carve, which the FY26 state pools are already defined
 * net of (lib/fy26-caps.ts).
 *
 * That also settles a disagreement the two sides of the app had about SHARED
 * rows: capRoom (gate 4) already returns Infinity for one, having no state cap
 * to bound it by, while the browser's clamp held it to the lead's pool because
 * inStateHomeTotal called it a home row. Both now say "no state-pool bound".
 */
export function fundedByStatePool(e: { vp: number; np: number; st: string }): boolean {
  return (e.st === "VIC" || e.st === "NSW") && !isCarveFunded(e);
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
    // The scheme's rule applied here as well — because this is the function
    // that decides what is PAID — but with ENGINE_ALLOWANCE: everything the
    // scheme can permit. A row drawing from no pool still gets nothing (there
    // is no pool for a lock or an amount to mean anything against). A VIC site
    // manager's stored lock/amount IS honoured, since 26 Aug 2026: it can only
    // be there because an admin holding the grant wrote it, and /api/state's
    // gate 2 (lib/scheme-gate.ts) reverts anyone else's attempt to the stored
    // value rather than deleting it — so the "stranded figure" this used to
    // guard against (24 Aug 2026, amounts typed into VIC site managers paid
    // while their cell rendered a dash) cannot arise: the cell that renders a
    // dash is one whose figure nobody could have written.
    // Deliberately the rule WITHOUT the issue stamp. This function answers
    // "what figures does this row carry", and issuing must not change that
    // answer: it freezes a row, it does not erase it. Feeding `issued` in here
    // would make isDaEditable false and blank the stored discretionary of every
    // issued row — a figure that is still true and still displayed. The issue
    // stamp does its work further down (finalBonus reads it directly) and in
    // the predicates every EDITING path consults.
    const issued = ov.issued;
    const rule = rowRule(e);
    // An issued row is locked whatever the flag says: issuing implies the
    // freeze, and it has to survive an "Unlock all" that cleared the boolean
    // before the stamp existed.
    const locked = issued !== undefined
      ? true
      : isLockable(rule, ENGINE_ALLOWANCE)
        ? ov.locked ?? false
        : false;
    return {
      ...e,
      bpEdit: ov.bpEdit ?? e.bp,
      ipmEdit: ov.ipmEdit ?? e.ipm,
      // Covers the source-data fallback too, which the save gate cannot reach:
      // an imported `da` on a row that may not carry one would otherwise be
      // paid with no override and no history entry behind it.
      daEdit: isDaEditable(rule, ENGINE_ALLOWANCE) ? ov.daEdit ?? e.da : 0,
      locked,
      baseAmount: ov.baseAmount,
      // Gated by the same rule as `locked` and `daEdit` above: a row the scheme
      // will not let anyone freeze must not be PAID a frozen figure either.
      // (A `lockedFinal` is only ever read as a fallback for a row with no
      // baseAmount, and every live row has one — lib/schema.ts.)
      lockedFinal: isLockable(rule, ENGINE_ALLOWANCE) ? ov.lockedFinal : undefined,
      issued,
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
  const vicScaleDerived =
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
  const nswScaleDerived = NSW_FULL_ENTITLEMENT ? 1 : nswScaleFromCap;

  // A STORED scale wins (owner decision, 27 August 2026, see Caps). Everything
  // above still runs and still means what it meant — with nothing stored these
  // two lines are the identity, which is what keeps lib/calc-golden.test.ts
  // passing untouched — but once /api/recalculate has pinned a figure, that is
  // the figure, and no edit anybody makes can move it. Only pressing
  // Recalculate again can.
  const vicScale = caps.vicScale ?? vicScaleDerived;
  const nswScale = caps.nswScale ?? nswScaleDerived;

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
    // AN ISSUED ROW IS ITS ISSUED AMOUNT, full stop. One guard ahead of the
    // whole resolution below, and it is what makes the promise in
    // lib/schema.ts's `issued` hold everywhere at once: a Recalculate cannot
    // move it, an IPM edit cannot move it, a discretionary edit cannot move it
    // and an unlock cannot move it, because none of them is consulted. The
    // stored base and the amount are still carried on the row, so the figures
    // that were true at the moment of issue stay visible.
    if (e.issued !== undefined) {
      e.finalBonus = e.issued.amount;
      return;
    }

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
 * Floored to whole CENTS — the unit a payout is stored in — not to whole
 * dollars as the prototype did. A pool's room carries cents (the caps and the
 * stored bases do), and a redistribution has to be able to spend exactly that
 * room so the card reads nil afterwards (owner decision, 26 Aug 2026); a
 * dollar floor here refused the last few cents of every such fill. What a
 * person TYPES is still held to whole dollars (lib/da-impact.ts's clampDa).
 * Returns 0 for a locked row (its
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
  return floorCents(capRoom(e, emps, caps, bound));
}

/** Round down to the cent, tolerating the float noise a sum of payouts carries. */
export function floorCents(v: number): number {
  if (!Number.isFinite(v)) return v;
  return Math.floor(v * 100 + 1e-6) / 100;
}

/**
 * Σ payout over the rows counted in one state's HOME TOTAL — the figure a state
 * pool is enforced against.
 *
 * THE one definition, so that the three places that measure a state's spending
 * cannot drift: capRoom below (/api/state's gate 4), poolCardTotals's
 * vicHome/nswHome (the admin's cards) and lib/manager-pool.ts's state room (a
 * scoped lead's cap). A lead's header being a slice of a figure the admin's
 * card did not recognise is exactly the class of bug this prevents.
 */
export function stateHomeTotal(
  st: string,
  emps: readonly CalcEmployee[]
): number {
  let total = 0;
  for (const r of emps) {
    if (r.st === st && inStateHomeTotal(r)) total += r.finalBonus;
  }
  return total;
}

/** What a state's pool is carrying for people outside its home total. */
export interface StateCarve {
  /** Shared Services rows, at this state's fraction of each payout */
  sharedServices: number;
  /** the part-split staff — split rows carrying a VIC or NSW label */
  splitState: number;
  /** the two together: everything the pool funds from outside its home total */
  total: number;
}

/**
 * THE LIVE CARVE-OUT: what this state's cap is actually paying for people its
 * home total does not count.
 *
 * The counterpart to stateHomeTotal above, and defined so the two partition the
 * state's whole draw exactly:
 *
 *     everything VIC funds  =  stateHomeTotal("VIC")  +  liveCarve("VIC").total
 *
 * Every dollar of every payout lands in exactly one of those two on each side,
 * which is what makes `cap − carve − home` a true Remaining rather than a
 * guide. A whole-pool VIC row is in the home total and contributes nothing
 * here; a Shared Services row is in neither home total and contributes its
 * `vp` share to VIC and its `np` share to NSW; a part-split row labelled VIC or
 * NSW is excluded from its own home total (inStateHomeTotal) and contributes
 * its fraction to both.
 *
 * The RAW split, deliberately, not the scale-weighted `fracVic` that
 * poolCardTotals uses for its part-split attribution: this answers "what
 * percentage of this person is each state paying for", which is the vp/np on
 * the row and the figure the two split columns show.
 *
 * The two lines are the same two the signed-off waterfall carves off each total
 * cap (lib/fy26-caps.ts), so a card's build-up still sums to its headline.
 *
 * DISPLAY ONLY. lib/fy26-caps.ts's typed constants remain what a grant is
 * BOUNDED by — see DISPLAY_CARVE_IS_LIVE there for why the two differ and what
 * it would take to close the gap.
 */
/**
 * THE CAP A STATE IS BOUND BY: its total cap less what it is live-carrying.
 *
 * ONE definition, shared by every bound and every display — the pool cards,
 * capRoom (/api/state's gate 4), stateRoom, a scoped lead's cap and the
 * discretionary ceiling all resolve through here or through liveCarve.
 *
 * It derives from the rows rather than reading a figure off `Caps`, and that is
 * the point. The carve was briefly a stored constant on Caps while the cards
 * showed the live figure, and the two drifted apart in BOTH directions: on 28
 * August 2026 a VIC card offered $6,508 of room while the field beside it
 * refused anything over $3,290, because the live carve had fallen below the
 * frozen one. A bound that is computed from the same rows the card counts
 * cannot do that.
 *
 * Null for any state that has no pool of its own — Shared Services — which is
 * what leaves such a row bounded by the group cap alone.
 */
export function stateBoundCap(
  st: string,
  emps: readonly CalcEmployee[],
  caps: Caps
): number | null {
  if (st !== "VIC" && st !== "NSW") return null;
  const cap = st === "VIC" ? caps.vCap : caps.nCap;
  // `vCarve`/`nCarve` are a TEST SEAM and nothing else: no production path sets
  // them any more (lib/data.ts and DashboardClient stopped attaching them when
  // the carve went live), so the fallback is what always runs. They survive so
  // a test can pin a carve without having to build a shared-services population
  // to imply one. If you find production code setting one, that is the bug.
  const pinned = st === "VIC" ? caps.vCarve : caps.nCarve;
  return cap - (pinned ?? liveCarve(st, emps).total);
}

export function liveCarve(
  st: "VIC" | "NSW",
  emps: readonly CalcEmployee[]
): StateCarve {
  let sharedServices = 0;
  let splitState = 0;
  for (const r of emps) {
    const share = st === "VIC" ? r.vp : r.np;
    if (share === 0) continue;
    if (r.st === "SHARED") sharedServices += r.finalBonus * share;
    else if (!inStateHomeTotal(r)) splitState += r.finalBonus * share;
  }
  return { sharedServices, splitState, total: sharedServices + splitState };
}

/**
 * What one state's pool has ACTUALLY not allocated yet: its cap net of the FY26
 * carve-outs, less every payout charged to it. The same subtraction capRoom
 * performs, and the same figure the admin's card headlines as that state's
 * Remaining.
 *
 * NEGATIVE when existing commitments already exceed the pool. Callers must not
 * clamp that away: it is the honest answer, and fabricating room from it is how
 * a pool gets overspent.
 *
 * Returns null for a state with no pool of its own (Shared Services, or
 * anything that is not VIC/NSW) — there is no room to divide because there is
 * no cap.
 */
export function stateRoom(
  st: string,
  emps: readonly CalcEmployee[],
  caps: Caps
): number | null {
  const cap = stateBoundCap(st, emps, caps);
  if (cap === null) return null;
  return cap - stateHomeTotal(st, emps);
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
  for (const r of emps) groupTotal += r.finalBonus;
  const homeTotal = stateHomeTotal(e.st, emps);
  // Back out this row's own amount so each figure measures every OTHER draw on
  // the cap, then the room is what the cap has left for this one.
  let room = bound === "both" ? caps.gCap - (groupTotal - e.daEdit) : Infinity;
  // The state cap NET of its carve-outs (Caps.vCarve / nCarve), when attached:
  // the pool the state is actually bound by. Null for a row the pool does not
  // fund. The group cap carries no carve — every payout is in the group total,
  // so nothing there is being funded from outside it.
  const stateCap = !inStateHomeTotal(e)
    ? null
    : stateBoundCap(e.st, emps, caps);
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
  /**
   * What each cap is LIVE-carrying for people outside its home total — the
   * figure the cards' build-up rows show, in place of lib/fy26-caps.ts's typed
   * constants. See liveCarve.
   */
  vicCarve: StateCarve;
  nswCarve: StateCarve;
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
    vicCarve: liveCarve("VIC", emps),
    nswCarve: liveCarve("NSW", emps),
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
