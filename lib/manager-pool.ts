/**
 * A manager's own pool figures — the header a scoped lead needs instead of
 * the group-level "VIC pool" card (a whole-state figure) and the filtered
 * table total, both of which were sums of finals wearing the wrong labels.
 *
 * Definitions (per the stakeholder spec, adjudicated Aug 2026):
 *
 *   pool       THE STATE CAP, for a lead whose grant is a whole state or
 *              states (owner decision, 25 August 2026). A state lead's scope
 *              IS that state's card — ruleMatches tests the same `st` the
 *              dashboard groups its pool cards by — so their budget is that
 *              card's cap and their headroom is the room under it, exactly the
 *              figure an admin sees on the card. Several states sum their
 *              caps. Shared Services has no cap of its own, so a rule
 *              covering it falls back to the entitlement sum below for those
 *              rows only.
 *
 *              For every other grant shape it stays the entitlement sum: a
 *              group rule ("fifteen delivery positions inside VIC") or a
 *              subset covers part of a state, so the state's cap would be a
 *              budget for several hundred people they are not accountable
 *              for — the very thing this module was written to stop handing
 *              them. Their pool is therefore still:
 *
 *              Σ calcBonus over EVERY in-scope row. `calcBonus` at the live
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
 * Note what remaining is made of, and why the state-cap definition matters.
 * A discretionary amount moves no scale, so `pool` never moves with a DA edit,
 * a DA of X raises `allocated` by exactly X and lowers `remaining` by exactly
 * X, and nobody outside the scope is touched. On the entitlement
 * definition that leaves a lead with almost no headroom at all — with no locks
 * and no DA, pool and allocated are equal by construction (finalBonus IS
 * calcBonus on every unlocked row), so their room comes only from locked rows
 * frozen BELOW their live entitlement — and every grant they tried would be
 * refused. Against the state cap their headroom is the real room under the
 * cap, the same room the editor's getMaxDA clamp and /api/state's headroom
 * gate allow, so the three agree instead of the lead's own gate being the
 * tightest by an accident of arithmetic.
 *
 * REDISTRIBUTION RELIES ON ALL OF THAT
 *
 * `remaining` is the budget lib/redistribute.ts spends: it splits that figure
 * across the people a lead has selected, by writing explicit amounts. Every
 * property above is what makes that safe and is worth keeping true —
 *
 *  - each dollar written lowers `remaining` by exactly a dollar, so one pass
 *    lands it on zero and a second pass distributes nothing;
 *  - `pool` does not move underneath the calculation while it runs;
 *  - and nobody outside the scope is touched, so one lead redistributing
 *    cannot move another lead's people or their `remaining`.
 *
 * An earlier design funded an amount FROM the pool by moving the state scale,
 * and broke all three: `allocated` no longer rose by the amount, `remaining`
 * barely moved for a whole-state lead so poolBreach below could not bound it at
 * all, and the whole state reflowed regardless of scope. It was removed. If
 * anything ever reintroduces a scale-moving discretionary amount, this gate
 * stops being a budget and redistribution stops converging.
 *
 * Pure: one engine pass over the whole population (the scale is a
 * whole-population fact), then the scope filter — the same ruleMatches the
 * read boundary (lib/scope-core.ts) and write boundary (lib/write-scope.ts)
 * use, so the rows counted here are exactly the rows they see and may edit.
 * That single whole-population pass is also why per-manager sub-pools are not
 * the fix: there is one scale, and overlapping scopes have no defined answer.
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
  type Caps,
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
  emps: readonly CalcEmployee[],
  caps: Caps
): ManagerPool {
  const mine = emps.filter((e) => ruleMatches(rule, e));
  const pool = rulePool(rule, mine, caps);
  const allocated = sumAllocated(mine, (e) => e.finalBonus);
  return { pool, allocated, remaining: pool - allocated, people: mine.length };
}

/** Σ calcBonus — the entitlement definition, for scopes with no cap of their own. */
function entitlement(rows: readonly CalcEmployee[]): number {
  return rows.reduce((s, e) => s + e.calcBonus, 0);
}

/**
 * The budget for one grant shape (see the module header for why they differ).
 *
 * A whole-state grant gets that state's cap, because the lead's scope is
 * precisely that state's pool card. Anything narrower gets the entitlement of
 * the rows it actually holds. Shared Services has no cap, so it contributes
 * its rows' entitlement even inside a state rule.
 */
function rulePool(
  rule: GrantingRule,
  mine: readonly CalcEmployee[],
  caps: Caps
): number {
  if (rule.type !== "state") return entitlement(mine);
  let pool = 0;
  for (const st of rule.states) {
    if (st === "VIC") pool += caps.vCap;
    else if (st === "NSW") pool += caps.nCap;
    else pool += entitlement(mine.filter((e) => e.st === st));
  }
  return pool;
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
  return managerPoolFrom(scope.rule, emps, data);
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
 *
 * This is the gate that bounds a redistribution. Because every discretionary
 * amount lands on `allocated` dollar for dollar, spending exactly `remaining`
 * leaves this at null and spending a dollar more does not — which is the whole
 * reason redistribution writes amounts rather than moving a scale.
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
