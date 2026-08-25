/**
 * A site manager's IPM re-prices their fixed bonus (owner decision, 26 August
 * 2026).
 *
 * A payout has been a STORED figure since 25 Aug 2026 — `baseAmount + daEdit`
 * (lib/schema.ts) — so an IPM edit moves the advisory Calc bonus and nothing
 * else. That is right for the pooled population: their Calc bonus carries the
 * live pool scale, and re-deriving payouts from it is the drift the stored
 * figure exists to stop. A SITE MANAGER's fixed bonus carries no scale — it is
 * package × bonus % × CPM × IPM, the workbook's "Bonus after IPM" for an SM row
 * — so for them the IPM IS the price, and a save that changes it writes the new
 * base. Nobody else is re-priced here.
 *
 * Only an UNLOCKED row moves: a lock is a payout freeze. An unlock and an IPM
 * change in one save does re-price (the lock is off once the save lands).
 *
 * Runs in /api/state after gate 2 (lib/scheme-gate.ts) — so a VIC site
 * manager's IPM can only reach here from an admin holding the grant — and
 * before the pool gates, so gate 4 and the impact dialog see the re-priced
 * figure. Pure: hands back the overrides to store and what changed, which the
 * route writes to history as its own entries.
 */
import type { Employee, Overrides } from "./schema";
import { applyOverrides, computeScalesAndBonuses } from "./calc";

export interface Reprice {
  empId: string;
  name: string;
  /** the stored base before, as the engine had been paying it */
  from: number;
  to: number;
  ipmFrom: number;
  ipmTo: number;
}

export function repriceSiteManagers(
  emps: Employee[],
  previous: Overrides,
  next: Overrides
): { overrides: Overrides; changes: Reprice[] } {
  const overrides: Overrides = { ...next };
  const changes: Reprice[] = [];

  const candidates = emps.filter((e) => {
    if (e.sm !== 1) return false;
    const ov = next[e.id];
    if (!ov || ov.locked) return false;
    const ipmBefore = previous[e.id]?.ipmEdit ?? e.ipm;
    const ipmAfter = ov.ipmEdit ?? e.ipm;
    return Math.abs(ipmBefore - ipmAfter) > 1e-9;
  });
  if (candidates.length === 0) return { overrides, changes };

  // Reuse the engine rather than restate the formula: for a site manager
  // bipmCalc is exactly pkg × bpEdit × cpm × ipmEdit, un-scaled. The scales the
  // pass computes are irrelevant to that figure, so any caps will do.
  const before = applyOverrides(emps, previous);
  computeScalesAndBonuses(before, { vCap: 1, nCap: 1, gCap: 1 });
  const after = applyOverrides(emps, next);
  computeScalesAndBonuses(after, { vCap: 1, nCap: 1, gCap: 1 });
  const wasById = new Map(before.map((e) => [e.id, e]));

  for (const e of candidates) {
    const row = after.find((r) => r.id === e.id)!;
    const was = wasById.get(e.id)!;
    const to = row.bipmCalc;
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
    });
  }
  return { overrides, changes };
}
