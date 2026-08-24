/**
 * Redistribution: spend what is left of a lead's pool across the people they
 * have SELECTED, by WRITING discretionary amounts.
 *
 * This is the whole mechanism. There is no scale involved — see lib/calc.ts's
 * header for why the alternative (funding an amount from the pool, so the
 * scale absorbs it) was abandoned: nswScale is pinned at 1 by
 * NSW_FULL_ENTITLEMENT, so scale-based redistribution was inert for every NSW
 * row, and moving a state's scale reaches every lead in that state rather than
 * only the one making the decision. Writing amounts has neither problem.
 *
 * Nothing in the app calls this except the "Redistribute the pool" button. A
 * lock, an unlock, an IPM edit or a discretionary edit deliberately leave
 * existing amounts alone: pressing the button is the ONLY thing that ever moves
 * them, so ordinary editing never disturbs figures that are already settled.
 *
 * Who takes part is a plain selection passed in — a set of ids the user ticked.
 * This module deliberately has no opinion about where that came from and stores
 * nothing: an earlier design persisted the choice on each row, which bought
 * nothing and put a saved field, a merge conflict slot and a history line
 * behind what is really just "these ones, now".
 *
 * Two properties make pressing it repeatable:
 *
 *  - `remaining` is measured WITH the current amounts already counted (it is
 *    `pool - allocated` from lib/manager-pool.ts). Distributing it therefore
 *    drives it to zero, so pressing the button twice does not double anyone's
 *    amount — the second press has nothing left to hand out.
 *  - A NEGATIVE remaining is distributed negatively, pulling the ticked rows
 *    back down. That is what lets a press reclaim an overspend: hand-typing a
 *    large amount elsewhere pushes the pool over, and the next press takes it
 *    back from the people who opted in rather than the save being refused.
 *
 * Pure, no I/O, no server-only imports, so the suite tests it directly.
 */
import { isDaEditable, type RowRule } from "./calc";

/**
 * The shape this needs from a row — RowRule plus four fields.
 *
 * Deliberately not `CalcEmployee`. The caller that matters is a LEAD's
 * dashboard, and a lead is never sent the dataset: they hold ScopedRows, whose
 * pool exposure is a single `inPool` boolean rather than vp/np. Extending
 * RowRule is what lets one definition serve both that and the server's
 * CalcEmployee (via `rowRule`), the same reasoning RowRule itself carries.
 */
export interface Redistributable extends RowRule {
  id: string;
  /** the row's current discretionary amount */
  daEdit: number;
  locked: boolean;
  /**
   * The scaled pool bonus, which shares are proportional to. Zero is a
   * legitimate value — a lead who cannot see the Calc bonus column is not sent
   * it, and then every weight is zero and the split falls back to equal shares
   * (see redistribute). That is the honest answer: without the figures there is
   * nothing to be proportional to.
   */
  calcBonus: number;
}

/** Whole dollars, and never below zero — a share is a weight, not a figure. */
function weightOf(r: Redistributable): number {
  return Math.max(0, r.calcBonus);
}

/**
 * Who takes part: selected, unlocked, and adjustable at all.
 *
 * Exported so the UI can offer a checkbox on exactly the rows this would act
 * on, rather than expressing the rule twice and letting the two drift.
 *
 * `isDaEditable` is reused rather than re-expressed so this can never admit a
 * row the Discretionary cell itself refuses — a VIC site manager, or anyone
 * drawing from no pool. A locked row is excluded because its payout is frozen;
 * writing to it would be recorded and then ignored. That is also why a locked
 * row's checkbox is disabled: the rule is enforced here either way, so the
 * disabled box is honesty rather than the boundary.
 */
export function eligible<T extends Redistributable>(
  rows: readonly T[],
  selected: ReadonlySet<string>
): T[] {
  return rows.filter(
    (r) => selected.has(r.id) && !r.locked && isDaEditable(r)
  );
}

/**
 * Split `remaining` across the eligible rows, pro-rata by calculated bonus.
 *
 * Returns the ABSOLUTE new amount for each row it touches (existing + share),
 * so a caller applies the result in one write and never has to read back its
 * own output. Rows that get nothing are absent from the map rather than
 * present with an unchanged value, so a caller can tell "no change" from
 * "changed to the same number".
 *
 * Whole dollars, summing to `remaining` EXACTLY: each share is floored, then
 * the leftover dollars go one at a time to the largest fractional parts
 * (largest remainder). Dropping the remainder the way getMaxDA floors would
 * leave Remaining a few dollars short of zero, so the card would never quite
 * read nil after a press that had in fact spent everything it could.
 */
export function redistribute<T extends Redistributable>(
  rows: readonly T[],
  remaining: number,
  selected: ReadonlySet<string>
): Map<string, number> {
  const out = new Map<string, number>();
  const target = Math.round(remaining);
  const people = eligible(rows, selected);
  if (people.length === 0 || target === 0) return out;

  const weights = people.map(weightOf);
  const totalWeight = weights.reduce((s, w) => s + w, 0);

  // Exact shares first, as real numbers. With no weight to go on — every
  // eligible row on a zero bonus — an equal split is the only honest answer;
  // proportional would be a division by zero.
  const exact = people.map((_, i) =>
    totalWeight > 0 ? (target * weights[i]) / totalWeight : target / people.length
  );

  // Floor toward zero so a negative target never over-reclaims, then hand the
  // residue out by largest fractional part. Math.trunc, not Math.floor:
  // flooring -0.5 to -1 would distribute more than the target.
  const base = exact.map((v) => Math.trunc(v));
  let residue = target - base.reduce((s, v) => s + v, 0);

  const order = people
    .map((_, i) => i)
    .sort((a, b) => {
      const fracA = Math.abs(exact[a] - base[a]);
      const fracB = Math.abs(exact[b] - base[b]);
      if (fracB !== fracA) return fracB - fracA;
      // Deterministic tie-break, so the same input always produces the same
      // split — an unstable one would rewrite people's figures on every pass.
      return weights[b] - weights[a] || (people[a].id < people[b].id ? -1 : 1);
    });

  const step = residue > 0 ? 1 : -1;
  for (let k = 0; residue !== 0 && k < order.length * 2; k++) {
    base[order[k % order.length]] += step;
    residue -= step;
  }

  people.forEach((r, i) => {
    if (base[i] === 0) return;
    out.set(r.id, r.daEdit + base[i]);
  });
  return out;
}
