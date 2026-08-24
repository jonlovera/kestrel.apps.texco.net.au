/**
 * Discretionary grants: the headroom that bounds one, and the impact of making
 * it.
 *
 * Under the 24 August 2026 pool-funded DA reform (see lib/calc.ts) a
 * discretionary amount is funded from the capped pool, so it is never the pool
 * cap that a grant breaches — the cap holds by construction and the money comes
 * out of the other unlocked bonuses instead. That makes "cap minus spend" the
 * wrong bound to police: it is structurally ~$0 on a fully subscribed pool, and
 * a grant barely moves it. The bound that means something is the one the
 * business owner named (24 August 2026):
 *
 *     HEADROOM is the total that can be taken from the unlocked bonuses before
 *     any of them reaches $0.
 *
 * Locked bonuses cannot be reduced, so they are not part of it — nor are site
 * managers, whose bonus is fixed and never scaled. (A site manager can still
 * RECEIVE a grant, 24 Aug 2026: it rides on their fixed bonus off the top of
 * the pool. They just never pay for anyone else's.) That figure is exactly what
 * lib/calc.ts's getMaxDA computes (the DA at which the remaining unlocked rows'
 * scale floors at 0), per pool and per row: a row drawing on both pools is
 * bounded by whichever pool runs out first.
 *
 * Two policy knobs are deliberately NOT implemented here — decisions pending.
 * See DA_POLICY for where each one lands.
 *
 * Pure: no I/O, no data imports. Shared by the editor client (the type-time
 * limit and the live ceiling on the field), the confirmation step, and
 * /api/state (which enforces both the limit and the confirmation, and writes
 * the audit record).
 */
import { applyOverrides, computeScalesAndBonuses, getMaxDA } from "./calc";
import type { CalcEmployee, Caps, PoolState } from "./calc";
import type { Employee, Overrides } from "./schema";

/**
 * Rounding slack, in dollars. These are sums over ~150 float figures reaching
 * seven digits, so a re-saved unchanged document must not read as a fresh
 * grant, and float noise must not count as someone's bonus being reduced.
 * Same value and rationale as lib/manager-pool.ts.
 */
export const EPSILON = 0.01;

/**
 * Policy knobs the owner has explicitly reserved (24 August 2026): "Don't add a
 * per-grant approval threshold or a minimum bonus floor. Both are policy
 * decisions I'm still waiting on. Leave clean hooks for both."
 *
 * Both are null, and every consumer treats null as "no rule", so nothing below
 * changes behaviour until a figure is set here. Where each one lands:
 *
 *  - approvalThreshold — a grant at or above this needs a second approver. It
 *    belongs in the confirmation step: `daImpact` already reports the amount,
 *    so the gate is one comparison in /api/state (refuse rather than record)
 *    plus a second signature on the audit entry. Nothing else moves.
 *  - minBonusFloor — no unlocked bonus may be shaved below this. It belongs in
 *    `daHeadroom`: today's ceiling is the DA at which the remaining rows reach
 *    $0, and a floor simply moves that zero up. Set it and the ceiling tightens
 *    everywhere at once, because every caller reads the headroom from here.
 */
export interface DaPolicy {
  /** grants at or above this need a second approver; null = no threshold */
  approvalThreshold: number | null;
  /** no unlocked bonus may be shaved below this; null = no floor */
  minBonusFloor: number | null;
}

export const DA_POLICY: DaPolicy = {
  approvalThreshold: null,
  minBonusFloor: null,
};

/**
 * The ceiling on one row's discretionary amount: the most that can be taken
 * from the unlocked bonuses before any of them reaches $0.
 *
 * Infinity for a row that draws from no pool (nothing to take from, and
 * /api/state strips its DA anyway). Can be NEGATIVE when stored figures
 * already over-draw the pool, which honestly means "no room at all" — callers
 * clamp at the row's current amount rather than dragging it down.
 *
 * HOOK: DA_POLICY.minBonusFloor would raise the zero this measures down to.
 */
export function daHeadroom(e: CalcEmployee, pool: PoolState): number {
  return getMaxDA(e, pool);
}

/**
 * Hold a requested amount to the ceiling. Whole dollars, floored: the field
 * displays a rounded figure, and flooring can never round back over the limit.
 *
 * A decrease is never held back — freeing pool money cannot exhaust it — which
 * is also what keeps an inherited over-draw correctable.
 */
export function clampDa(
  requested: number,
  current: number,
  headroom: number
): { value: number; clamped: boolean } {
  if (requested <= current) return { value: requested, clamped: false };
  if (!Number.isFinite(headroom)) return { value: requested, clamped: false };
  if (requested <= headroom + EPSILON) return { value: requested, clamped: false };
  // No room at all: hold at what is already stored rather than reducing it.
  const ceiling = Math.max(current, Math.floor(headroom));
  return { value: ceiling, clamped: true };
}

/** One row's discretionary amount changing — the thing that gets confirmed and logged. */
export interface DaGrant {
  empId: string;
  name: string;
  /** the amount before this change */
  from: number;
  /** the amount after it */
  to: number;
  /** to - from: what is actually being granted (negative when reduced) */
  amount: number;
  /** the ceiling that applied when the grant was made, for the audit record */
  headroom: number;
}

/**
 * What a set of discretionary changes does to everyone else. Every figure is
 * measured by running the engine twice and comparing, so it reports what will
 * actually happen rather than what the arithmetic implies.
 */
export interface DaImpact {
  grants: DaGrant[];
  /** Σ amount over the grants */
  granted: number;
  /** how many unlocked bonuses (other than the recipients') go down */
  reducedCount: number;
  /** average reduction across those bonuses */
  averageReduction: number;
  /** the largest single reduction anyone takes */
  largestReduction: number;
  /** Σ of every reduction */
  totalReduction: number;
  /** bonuses frozen by a lock, and so untouched by this */
  lockedUnaffected: number;
}

/** The engine's view of a document, and the pool state that goes with it. */
function run(
  emps: Employee[],
  caps: Caps,
  doc: Overrides
): { rows: CalcEmployee[]; pool: PoolState } {
  const rows = applyOverrides(emps, doc);
  const pool = computeScalesAndBonuses(rows, caps);
  return { rows, pool };
}

/**
 * The discretionary amounts that differ between two documents, with the
 * headroom each one had when it was made (measured on `stored`, i.e. before
 * the change).
 */
export function daGrants(
  emps: Employee[],
  caps: Caps,
  stored: Overrides,
  next: Overrides
): DaGrant[] {
  const before = run(emps, caps, stored);
  const byId = new Map(before.rows.map((e) => [e.id, e]));
  const grants: DaGrant[] = [];
  for (const row of run(emps, caps, next).rows) {
    const was = byId.get(row.id);
    if (!was) continue;
    if (Math.abs(row.daEdit - was.daEdit) <= EPSILON) continue;
    grants.push({
      empId: row.id,
      name: `${row.gn} ${row.sn}`,
      from: was.daEdit,
      to: row.daEdit,
      amount: row.daEdit - was.daEdit,
      headroom: daHeadroom(was, before.pool),
    });
  }
  return grants;
}

/**
 * The full picture for the confirmation step: what is being granted, and who
 * pays for it. Recipients are excluded from the reduction figures — a
 * recipient's own bonus is what the grant moves, not collateral — and so are
 * locked and site-manager rows, whose bonuses cannot move at all (they are
 * counted separately, which is the point of reporting them).
 */
export function daImpact(
  emps: Employee[],
  caps: Caps,
  stored: Overrides,
  next: Overrides
): DaImpact {
  const grants = daGrants(emps, caps, stored, next);
  const recipients = new Set(grants.map((g) => g.empId));
  const before = run(emps, caps, stored);
  const after = run(emps, caps, next);
  const wasFinal = new Map(before.rows.map((e) => [e.id, e.finalBonus]));

  let reducedCount = 0;
  let totalReduction = 0;
  let largestReduction = 0;
  let lockedUnaffected = 0;
  for (const row of after.rows) {
    if (row.locked) lockedUnaffected += 1;
    if (recipients.has(row.id) || row.locked || row.sm) continue;
    const drop = (wasFinal.get(row.id) ?? row.finalBonus) - row.finalBonus;
    if (drop <= EPSILON) continue;
    reducedCount += 1;
    totalReduction += drop;
    if (drop > largestReduction) largestReduction = drop;
  }

  return {
    grants,
    granted: grants.reduce((s, g) => s + g.amount, 0),
    reducedCount,
    averageReduction: reducedCount > 0 ? totalReduction / reducedCount : 0,
    largestReduction,
    totalReduction,
    lockedUnaffected,
  };
}
