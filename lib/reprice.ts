/**
 * AN IPM EDIT RE-PRICES THAT ONE ROW (owner decision, 27 August 2026, widening
 * the site-manager-only rule of 26 August).
 *
 *     Calc Bonus = Potential Bonus × stored Scale Factor × new IPM
 *
 * and the row's stored base becomes that figure, so its payout follows its
 * rating. What makes this safe to do for the whole population — and what it
 * used to be impossible to do safely — is that the Scale Factor is now a STORED
 * constant (lib/params-apply.ts, written only by /api/recalculate). The engine
 * used to derive it from a denominator weighted by everybody's current IPM, so
 * re-pricing off it would have let one person's rating move everybody's money.
 * Against a constant it cannot: the arithmetic below touches exactly the rows
 * whose IPM changed, and the difference falls through to Remaining Pool.
 *
 * TWO SHAPES, one rule:
 *  - A SITE MANAGER's bonus carries no scale — it is package × bonus % × CPM ×
 *    IPM, the workbook's "Bonus after IPM" for an SM row — so for them the IPM
 *    simply IS the price. Unchanged since 26 August 2026, and unchanged by the
 *    stored-scale work: they are re-priced whether or not one exists.
 *  - A POOLED row is Potential × Scale × IPM, so it can only be re-priced once
 *    there is an authoritative scale to re-price it against.
 *
 * WITH NO STORED SCALE, A POOLED ROW IS NOT RE-PRICED AT ALL. The engine still
 * derives an advisory scale for the Calc bonus column and the pool cards, but
 * that figure is explicitly not authoritative — it moves whenever anyone's IPM
 * moves, which is the very drift this feature removes — so paying anybody from
 * it would be worse than not paying them from anything. The IPM saves, the
 * advisory column moves, the payout stands, and the first Recalculate is what
 * switches re-pricing on. Deliberate, and asserted in lib/reprice.test.ts.
 *
 * Only an UNLOCKED, UN-ISSUED row moves: a lock is a payout freeze and an issue
 * is a commitment. An unlock and an IPM change in one save does re-price (the
 * lock is off once the save lands).
 *
 * Runs in /api/state after gate 2 (lib/scheme-gate.ts) — so a VIC site
 * manager's IPM can only reach here from an admin holding the grant — and
 * before the pool gates, so gate 4 and the impact dialog see the re-priced
 * figure. Pure: hands back the overrides to store and what changed, which the
 * route writes to history as its own entries.
 */
import type { Employee, Overrides } from "./schema";
import {
  applyOverrides,
  computeScalesAndBonuses,
  ENGINE_ALLOWANCE,
  isIpmEditable,
  rowRule,
  type Caps,
} from "./calc";

export interface Reprice {
  empId: string;
  name: string;
  /** the stored base before, as the engine had been paying it */
  from: number;
  to: number;
  ipmFrom: number;
  ipmTo: number;
  /** true for a site manager's fixed bonus, false for a scaled pool bonus */
  fixedBonus: boolean;
}

export function repriceOnIpm(
  emps: Employee[],
  previous: Overrides,
  next: Overrides,
  caps: Caps
): { overrides: Overrides; changes: Reprice[] } {
  const overrides: Overrides = { ...next };
  const changes: Reprice[] = [];

  // No authoritative scale yet means only site managers can be re-priced —
  // theirs is the one price that does not involve a scale. See the header.
  const scaled = caps.vicScale !== undefined || caps.nswScale !== undefined;

  const candidates = emps.filter((e) => {
    const ov = next[e.id];
    if (!ov || ov.locked || ov.issued !== undefined) return false;
    // ENGINE_ALLOWANCE, not the caller's: this asks "can this row be re-priced
    // at all", never "was this writer allowed to touch it". Authority was
    // settled upstream by /api/state's gate 2, which reverts an IPM the writer
    // may not set back to the stored value — so an IPM that reaches here has
    // already been approved, and a VIC site manager's, written by an admin
    // holding the grant, must be honoured rather than quietly dropped. Same
    // reasoning, and the same constant, as applyOverrides.
    if (!isIpmEditable(rowRule({ ...e, issued: ov.issued }), ENGINE_ALLOWANCE))
      return false;
    if (e.sm !== 1 && !scaled) return false;
    const ipmBefore = previous[e.id]?.ipmEdit ?? e.ipm;
    const ipmAfter = ov.ipmEdit ?? e.ipm;
    return Math.abs(ipmBefore - ipmAfter) > 1e-9;
  });
  if (candidates.length === 0) return { overrides, changes };

  // Reuse the engine rather than restate the formula. The caps are the real
  // ones now, not the {1,1,1} placeholder this used when only site managers
  // (whose figure carries no scale) were re-priced — a pooled row's new base
  // reads the scale, so it has to be the true one.
  const before = applyOverrides(emps, previous);
  computeScalesAndBonuses(before, caps);
  const after = applyOverrides(emps, next);
  const pool = computeScalesAndBonuses(after, caps);
  const wasById = new Map(before.map((e) => [e.id, e]));

  for (const e of candidates) {
    const row = after.find((r) => r.id === e.id)!;
    const was = wasById.get(e.id)!;
    // A site manager's fixed bonus is bipmCalc — package × bonus % × CPM × IPM,
    // un-scaled. Everyone else is that figure spread across the pools they draw
    // on, at the stored scale: Potential × Scale × IPM.
    const to = row.sm
      ? row.bipmCalc
      : row.bipmCalc * (row.vp * pool.vicScale + row.np * pool.nswScale);
    // what the engine had been paying as the base: finalBonus less the amount
    const from = was.finalBonus - was.daEdit;
    if (Math.abs(to - from) < 0.005) continue;
    overrides[e.id] = { ...overrides[e.id], baseAmount: to };
    changes.push({
      empId: e.id,
      name: `${e.gn} ${e.sn}`,
      from,
      to,
      ipmFrom: was.ipmEdit,
      ipmTo: row.ipmEdit,
      fixedBonus: row.sm === 1,
    });
  }
  return { overrides, changes };
}
