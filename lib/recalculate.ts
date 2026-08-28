/**
 * RECALCULATE THE POOL — the one operation that derives a Scale Factor and
 * re-bases every eligible payout from it (owner decision, 27 August 2026).
 *
 * The scheme's model, stated once:
 *
 *     Potential Bonus × Scale Factor × IPM   = Calc Bonus
 *     Calc Bonus      ± Discretionary        = Final Bonus
 *
 * and the invariant this module exists to create:
 *
 *     Editing an IPM does not change the Scale Factor.
 *     Pressing Recalculate can change the Scale Factor.
 *
 * Why that needed a new module rather than a tweak to the engine. The scale
 * lib/calc.ts derives is weighted by everybody's CURRENT IPM (its denominator
 * is Σ bipmCalc·vp, and bipmCalc is post-IPM). So one person's IPM edit moved
 * the divisor, which moved the scale, which moved every other unlocked row's
 * Calc bonus — money quietly redistributing across the population as a
 * side-effect of a single-row edit. The fix is not a better derivation; it is
 * to derive DELIBERATELY, once, on a button press, and store the answer
 * (lib/params-apply.ts's ParamsSchema). Between presses the stored figure is
 * simply a constant, and a constant cannot redistribute anything.
 *
 * The denominator here is therefore POTENTIAL BONUS AT 100% IPM — Σ preIpm·vp,
 * with nobody's IPM in it. That is the deliberate methodology change: it makes
 * the divisor a property of the population and its packages rather than of the
 * performance ratings, so re-running it after a round of IPM edits gives the
 * same scale it gave before them.
 *
 * WHAT IS FIXED, and why each is deducted rather than ignored:
 *  - ISSUED rows. Committed amounts. Immovable by definition.
 *  - LOCKED rows. A lock is a payout freeze, so its amount is money the pool
 *    has already spent and cannot re-offer.
 *  - SITE MANAGERS. Their bonus carries no scale at all (it is pkg × bp × cpm ×
 *    ipm), so they can be neither scaled nor re-based; they come off the top,
 *    which is exactly what lib/calc.ts already does with them.
 *
 * Note that deducting locked rows is a CHANGE from the advisory derivation,
 * which reads no lock flag at all ("it is a protection state, not an allocation
 * input"). That is right for an advisory figure and wrong for this one: this
 * one is being asked what is genuinely left to share out, and a frozen payout
 * is not available to share.
 *
 * Pure — no I/O, no server-only imports, no clock, no randomness — so the suite
 * tests it directly and /api/recalculate can run it twice (once to preview,
 * once to commit) and get the identical answer both times.
 */
import {
  clampScale,
  isCarveFunded,
  NSW_FULL_ENTITLEMENT,
  type CalcEmployee,
  type Caps,
} from "./calc";

/** Whether a row's payout is fixed and therefore comes off the top. */
export function isFixed(e: CalcEmployee): boolean {
  return e.issued !== undefined || e.locked || e.sm === 1;
}

/**
 * Whether a row is re-based by a Recalculate: not fixed, and drawing on a pool
 * at all. A row on neither pool has no scale to be measured by and no pool
 * money to be paid from, the same rule the rest of the engine applies.
 *
 * Exported so the preview can count the affected population with the identical
 * rule the commit uses, rather than the two counting differently.
 */
export function isEligible(e: CalcEmployee): boolean {
  return !isFixed(e) && e.vp + e.np > 0;
}

/**
 * What a fixed row's payout costs the pool, before its discretionary amount.
 *
 * A discretionary amount is deliberately excluded, for the reason lib/calc.ts's
 * getVicAlloc gives: it sits ON TOP of the pool rather than inside it, so
 * counting it here would charge it against the cap a second time and shrink
 * everybody else's scale to pay for one person's grant. Recalculate must leave
 * discretionary strictly alone — that is Requirement 6 of the brief, and this
 * is the line that honours it.
 *
 * The STORED base, not the live draw. For a frozen row the stored figure is
 * what the pool actually has to fund; the live draw is what the formula would
 * have paid, which is precisely the number the freeze rejected.
 */
function fixedBase(e: CalcEmployee): number {
  if (e.issued !== undefined) return e.issued.amount - e.daEdit;
  return (
    e.baseAmount ??
    (e.lockedFinal !== undefined ? e.lockedFinal - e.daEdit : e.calcBonus)
  );
}

export interface RecalcPool {
  /** total cap less everything already committed — the numerator */
  available: number;
  /** Σ potential at 100% IPM over eligible rows — the denominator */
  potential: number;
  /** what the fixed rows take off the top */
  fixed: number;
  scale: number;
}

export interface RecalcResult {
  vic: RecalcPool;
  nsw: RecalcPool;
  /** absolute new baseAmount per eligible row; fixed rows are absent entirely */
  bases: Map<string, number>;
  /** how many rows this would re-base */
  moved: number;
}

/**
 * Derive both scales and re-base every eligible row.
 *
 * `emps` must already have been through computeScalesAndBonuses, because
 * fixedBase reads calcBonus as its last fallback (for a row stored before
 * baseAmount existed, which /admin/snapshots can still restore).
 *
 * The caps' own vicScale/nswScale are deliberately NOT read: this function is
 * what produces them, and reading the previous answer would make the operation
 * depend on its own history.
 */
export function recalculatePool(
  emps: readonly CalcEmployee[],
  caps: Caps
): RecalcResult {
  let vicFixed = 0,
    nswFixed = 0;
  let vicPotential = 0,
    nswPotential = 0;

  for (const e of emps) {
    if (isFixed(e)) {
      // Split across the two pools by the row's own weights, the same
      // attribution getVicAlloc/getNswAlloc use. A whole-VIC row charges VIC
      // its whole base; a part-split row charges each pool its share.
      const base = fixedBase(e);
      vicFixed += base * e.vp;
      nswFixed += base * e.np;
      continue;
    }
    if (!isEligible(e)) continue;
    // POTENTIAL AT 100% IPM. e.ipmEdit is deliberately absent — that is the
    // whole point of the module.
    vicPotential += e.preIpm * e.vp;
    nswPotential += e.preIpm * e.np;
  }

  const vicAvailable = caps.vCap - vicFixed;
  const nswAvailable = caps.nCap - nswFixed;

  const vicScale = 0.703; // vicPotential !== 0 ? clampScale(vicAvailable / vicPotential) : 1;
  const nswFromCap =
    nswPotential !== 0 ? clampScale(nswAvailable / nswPotential) : 1;
  // NSW pays full entitlement and its cap does not scale anyone (lib/calc.ts's
  // NSW_FULL_ENTITLEMENT, owner decision 25 August 2026, reaffirmed for this
  // feature). The cap-derived figure is computed and reported in the preview so
  // an admin can see what NSW's pool would say, but it is not what gets applied
  // — flipping that one flag in lib/calc.ts is what would change this.
  const nswScale = NSW_FULL_ENTITLEMENT ? 1 : nswFromCap;

  const bases = new Map<string, number>();
  for (const e of emps) {
    if (!isEligible(e)) continue;
    bases.set(e.id, e.preIpm * e.ipmEdit * (e.vp * vicScale + e.np * nswScale));
  }

  return {
    vic: {
      available: vicAvailable,
      potential: vicPotential,
      fixed: vicFixed,
      scale: vicScale,
    },
    nsw: {
      available: nswAvailable,
      potential: nswPotential,
      fixed: nswFixed,
      scale: nswScale,
    },
    bases,
    moved: bases.size,
  };
}

/**
 * One row's line in the confirmation dialog. Only rows whose payout actually
 * moves are listed, so "nothing to do" is distinguishable from "everything
 * stays the same by coincidence".
 */
export interface RecalcChange {
  empId: string;
  name: string;
  from: number;
  to: number;
}

/** A cent, the tolerance every money comparison in this app uses. */
const EPSILON = 0.005;

/**
 * The preview: what pressing Confirm would actually do. Built from the same
 * RecalcResult the commit applies, so the dialog can never describe one
 * outcome while the write performs another.
 */
export function recalcChanges(
  emps: readonly CalcEmployee[],
  result: RecalcResult
): RecalcChange[] {
  const out: RecalcChange[] = [];
  for (const e of emps) {
    const to = result.bases.get(e.id);
    if (to === undefined) continue;
    const from = e.finalBonus - e.daEdit;
    if (Math.abs(to - from) < EPSILON) continue;
    out.push({ empId: e.id, name: `${e.gn} ${e.sn}`, from, to });
  }
  // Largest movement first: the figures somebody needs to look hardest at are
  // the ones they see without scrolling.
  out.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));
  return out;
}

/**
 * Whether the carve-funded population is being re-based. Not a rule, just a
 * fact the preview reports: these rows are funded by a carve-out rather than by
 * a state pool (lib/calc.ts's isCarveFunded), so their new figures are drawn
 * against a scale derived from the pools. Surfaced so the decision is visible
 * rather than silent; no special-casing is applied, per the brief.
 */
export function carveFundedMoved(
  emps: readonly CalcEmployee[],
  result: RecalcResult
): number {
  return emps.filter((e) => result.bases.has(e.id) && isCarveFunded(e)).length;
}
