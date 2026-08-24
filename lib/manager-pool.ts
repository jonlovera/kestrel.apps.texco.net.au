/**
 * A manager's own pool figures — the header a scoped lead needs instead of
 * the group-level "VIC pool" card (a whole-state figure) and the filtered
 * table total, both of which were sums of finals wearing the wrong labels.
 *
 * Definitions (per the stakeholder spec, adjudicated Aug 2026):
 *
 *   pool       Σ calcBonus over EVERY in-scope row. `calcBonus` at the live
 *              scale is the one honest "draw from the pool" figure in the
 *              engine: over unlocked non-site-manager rows it partitions the
 *              post-locks, post-site-manager pool to the cent (see
 *              lib/calc.ts — the scale is (avail - locked) / unlockedDemand by
 *              construction), a site manager's is their fixed unscaled draw,
 *              and a locked row's is what that row would draw at the live
 *              scale. Deliberately NOT derived from the group waterfall
 *              (cap - site managers - locked), which does not reconcile for a
 *              scope that is a subset of a state.
 *
 *              Two exclusions people expect here are deliberately absent:
 *
 *              LOCKED ROWS ARE INCLUDED. A locked person still draws from
 *              their manager's pool — locking only means the manager cannot
 *              edit the row, not that the money left the pool. Excluding them
 *              lands near half the figure ($555,733 against Clint Cassar's
 *              57 rows, 27 of them locked).
 *
 *              SHARED SERVICES ARE NOT FILTERED OUT HERE, and neither is
 *              anyone else whose cost splits across the two pools. The scope
 *              rule is the exclusion: 24 of the 25 SHARED rows in the
 *              21 Aug 2026 capture fall outside a lead like Clint's grant and
 *              never reach this sum. The 25th is Peter Clements (National
 *              EHSQ Manager, vp 0.7/np 0.3), in scope by position and
 *              counted — a split is a statement about which caps fund him,
 *              not a reason to drop his $51,392 draw from the pool his
 *              manager is accountable for. A literal `st !== "SHARED"` test
 *              breaks the reconciliation by exactly that amount, and testing
 *              the split instead breaks it for every VIC employee who does a
 *              portion of NSW work.
 *
 *   allocated  Σ finalBonus over ALL in-scope rows, through the shared
 *              sumAllocated — the same function the table's "Total bonuses"
 *              footer calls, so the header and the footer can never disagree
 *              about what a total is.
 *   remaining  pool - allocated (the header paints it red at or below 0).
 *   people     the in-scope row count.
 *
 * Note what remaining is made of: with no locks and no discretionary
 * adjustments, pool and allocated are equal by construction (finalBonus IS
 * calcBonus on every unlocked row), so a manager's headroom comes entirely
 * from locked rows frozen BELOW their live entitlement, plus any
 * under-subscribed pool. It is normally thin, which is why poolBreach names
 * the unabsorbable amount rather than clamping quietly.
 *
 * Since the 24 August 2026 pool-funded DA reform (see lib/calc.ts), a DA is
 * inside the pool draw again, with two consequences for these figures:
 *  - An in-scope DA shrinks every other unlocked row's calcBonus state-wide,
 *    so `pool` itself moves with a DA edit. In-scope LOCKED rows' live
 *    calcBonus shrinks too while their frozen final does not, so a DA of X
 *    can reduce `remaining` by more than X when the scope holds locked rows.
 *  - A scoped DA is absorbed by the whole state, including out-of-scope
 *    rows. poolBreach deliberately polices only the manager's own pool; the
 *    state cap itself is protected by the engine (clampScale floors the
 *    remaining rows' scale at 0, so the cap cannot be overdrawn by scaled
 *    bonuses) and by the editor's getMaxDA clamp at type time.
 *
 * Pure: one engine pass over the whole population (the scale is a
 * whole-population fact), then the scope filter — the same ruleMatches the
 * read boundary (lib/scope-core.ts) and write boundary (lib/write-scope.ts)
 * use, so the rows counted here are exactly the rows they see and may edit.
 */
import type { Dataset, Overrides } from "./schema";
import type { Scope } from "./access";
import type { GrantingRule } from "./access-rules";
import { ruleMatches } from "./access-rules";
import {
  applyOverrides,
  computeScalesAndBonuses,
  sumAllocated,
  type CalcEmployee,
} from "./calc";

export interface ManagerPool {
  pool: number;
  allocated: number;
  remaining: number;
  people: number;
}

/**
 * The figures, from rows the engine has ALREADY been run over. The read path
 * takes this one: lib/scope-core.ts has computed the population and filtered
 * it before it needs a header, and /api/preview re-runs that on every
 * keystroke burst — a second engine pass there would be pure waste.
 */
export function managerPoolFrom(
  rule: GrantingRule,
  emps: readonly CalcEmployee[]
): ManagerPool {
  const mine = emps.filter((e) => ruleMatches(rule, e));
  const pool = mine.reduce((s, e) => s + e.calcBonus, 0);
  const allocated = sumAllocated(mine, (e) => e.finalBonus);
  return { pool, allocated, remaining: pool - allocated, people: mine.length };
}

/**
 * Run the engine, then measure. For callers holding a dataset and an
 * overrides document rather than computed rows — the write gate below, and the
 * tests. `data` must already have its params folded in (getEffectiveDataset /
 * applyParams); the caps are read straight off it.
 */
export function managerPool(
  scope: Scope,
  data: Dataset,
  overrides: Overrides
): ManagerPool {
  const emps = applyOverrides(data.emp, overrides);
  computeScalesAndBonuses(emps, data);
  return managerPoolFrom(scope.rule, emps);
}

export interface PoolBreach {
  /** how far the save's allocation would exceed the manager's pool */
  over: number;
  /** the breach already present in the stored document, for comparison */
  wasOver: number;
}

/**
 * Rounding slack, in dollars. These are sums over ~150 float figures reaching
 * seven digits; re-saving an unchanged document must not trip the gate on
 * accumulated noise, so a breach has to get worse by more than a cent to
 * count.
 */
const EPSILON = 0.01;

/** How far over their pool this document puts the manager (0 if not over). */
function overBy(scope: Scope, data: Dataset, doc: Overrides): number {
  return Math.max(0, -managerPool(scope, data, doc).remaining);
}

/**
 * Would this save push the manager FURTHER above their pool?
 *
 * Null when it wouldn't — which deliberately includes a save that holds or
 * reduces a breach that was already stored. A manager can inherit an
 * over-pool state they did not create (an admin moves a cap, or locks a row
 * above its entitlement); a plain "refuse while over" gate would then lock
 * them out of saving the very correction that fixes it. So the comparison is
 * against the stored document, not against zero.
 *
 * Null for a full-access scope: an admin allocates against the group caps,
 * which the pool cards already report, and has no manager pool to breach.
 */
export function poolBreach(
  scope: Scope,
  data: Dataset,
  next: Overrides,
  stored: Overrides
): PoolBreach | null {
  if (scope.rule.type === "full") return null;
  const wasOver = overBy(scope, data, stored);
  const over = overBy(scope, data, next);
  if (over <= wasOver + EPSILON) return null;
  return { over, wasOver };
}
