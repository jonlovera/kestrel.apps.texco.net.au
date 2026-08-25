/**
 * Discretionary grants: the headroom that bounds one, and the impact of making
 * it.
 *
 * A discretionary amount sits ON TOP of the pool calculation (see lib/calc.ts,
 * owner decision 25 August 2026): the recipient's final rises by exactly the
 * amount, nobody else's bonus moves, and the pool total rises with it. So the
 * bound that means something is the cap itself — the one the owner named:
 *
 *     HEADROOM is the room left under the caps the pool cards measure against,
 *     so a grant is refused automatically at the point its pool would pass its
 *     cap.
 *
 * That is exactly what lib/calc.ts's getMaxDA computes, measured off Σ final
 * the same way the cards are. WHICH caps is the CapBound argument: an admin is
 * bounded by the row's home-state cap and the group cap, whichever binds first,
 * while a scoped lead is bounded by the home-state cap alone — the group cap is
 * one they are never sent, and it is structurally the tighter of the two, so it
 * refused every grant they made without ever telling them by how much (see
 * CapBound in lib/calc.ts for the arithmetic). A locked row has no headroom at
 * all (its payout is frozen), and a row with no applicable cap has none to
 * overrun; for a lead the remaining constraint there is their own pool, which
 * lib/manager-pool.ts's poolBreach enforces.
 *
 * The impact figures below are still measured by running the engine twice, so
 * they report what actually happens rather than what the model implies. Under
 * this model that means nobody else's bonus is reduced — the reduction fields
 * come back structurally 0 — and what the confirmation step has to show is the
 * effect on the pools instead (see DaPoolImpact).
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
import type { PoolState } from "./calc";
import type { CalcEmployee, CapBound, Caps } from "./calc";
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
 *  - minBonusFloor — no unlocked bonus may be shaved below this. Moot while a
 *    discretionary amount sits on top of the pool (25 August 2026): a grant
 *    shaves nobody, so no floor can bind. It belongs in `daHeadroom` if the
 *    funding model ever moves back inside the pools — set it there and the
 *    ceiling tightens everywhere at once, because every caller reads the
 *    headroom from here.
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
 * The ceiling on one row's discretionary amount: the most it may hold before
 * the row's pool passes its cap.
 *
 * Takes the whole population because the bound is measured off the pool totals
 * (see getMaxDA), not off one row — pass the rows the engine has just run over.
 *
 * WHICH caps apply depends on who is asking (lib/calc.ts's CapBound). An admin
 * is bounded by the home-state cap and the group cap; a SCOPED LEAD by their
 * home-state cap alone, so they are judged against the pool their own header
 * shows rather than by a group cap they are never sent. The default is "both",
 * so a caller that has not thought about it gets the stricter bound.
 *
 * Infinity when no cap is left to bound the row — it draws from no pool, or it
 * is a Shared Services row under "state". Can be NEGATIVE when stored figures
 * already exceed a cap, which honestly means "no room at all" — callers hold
 * at the row's current amount rather than dragging it down.
 *
 * HOOK: DA_POLICY.minBonusFloor would tighten this if a floor were ever set
 * on how far a redistribution may push a bonus down.
 */
export function daHeadroom(
  e: CalcEmployee,
  emps: readonly CalcEmployee[],
  caps: Caps,
  bound: CapBound = "both"
): number {
  return getMaxDA(e, emps, caps, bound);
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
 * Where a set of grants leaves each pool the dashboard shows a card for — the
 * figures the confirmation step is really about, now that a grant adds to a
 * pool total instead of redistributing inside it.
 *
 * Measured exactly as the cards are (Σ final by home state, and Σ final over
 * everyone for the group), so what is confirmed is what the person then sees.
 */
export interface DaPoolImpact {
  /** which card: a home state, or the group total */
  key: "VIC" | "NSW" | "SHARED" | "GROUP";
  /** Σ final for that card before the grants */
  before: number;
  /** Σ final for that card after them */
  after: number;
  /** its cap — null for Shared Services, which has no cap of its own */
  cap: number | null;
}

/**
 * What a set of discretionary changes does. Every figure is measured by running
 * the engine twice and comparing, so it reports what will actually happen
 * rather than what the arithmetic implies.
 */
export interface DaImpact {
  grants: DaGrant[];
  /** Σ amount over the grants */
  granted: number;
  /** the pools these grants move, and where they leave them */
  pools: DaPoolImpact[];
  /**
   * How many unlocked bonuses (other than the recipients') go down. Zero when
   * every amount in the change sits on top of the pool; non-zero as soon as one
   * is funded FROM it, because that moves the state scale under everyone.
   * Always measured by running the engine twice, never assumed — which is why
   * it started reporting real figures the moment the per-row flag landed,
   * with no change to this module's logic.
   */
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

/**
 * The engine's view of a document: the rows with every final resolved, which is
 * what both the headroom bound and the impact figures are measured off.
 */
function run(
  emps: Employee[],
  caps: Caps,
  doc: Overrides
): { rows: CalcEmployee[]; pool: PoolState } {
  const rows = applyOverrides(emps, doc);
  // The pool state comes back too: under the redistribute model the headroom
  // bound is measured off it, not off the rows.
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
      headroom: daHeadroom(was, before.rows, caps),
    });
  }
  return grants;
}

/**
 * The full picture for the confirmation step: what is being granted, and where
 * it leaves each pool it touches.
 *
 * The reduction figures are measured, never assumed (recipients excluded — a
 * recipient's own bonus is what the grant moves, not collateral — and so are
 * locked and site-manager rows, whose bonuses cannot move at all). They come
 * back 0 when every amount in the change sits on top of the pool, and report
 * real figures as soon as one is funded from it. Measuring rather than assuming
 * is what made the per-row funding flag visible here with no change to this
 * function.
 *
 * Note that `recipients` is derived from `grants`, and a funding flip with an
 * unchanged amount IS a grant (see daGrants) — so the row whose funding moved
 * is correctly excluded from the collateral count rather than being reported as
 * a victim of its own change.
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
    pools: poolImpacts(before.rows, after.rows, caps, recipients),
    reducedCount,
    averageReduction: reducedCount > 0 ? totalReduction / reducedCount : 0,
    largestReduction,
    totalReduction,
    lockedUnaffected,
  };
}

/**
 * The pool cards a set of grants actually moves: every recipient's home state,
 * plus the group total (which every grant moves by construction). Shared
 * Services is included when someone there is granted — it has no cap, but the
 * total still moves and hiding it would misreport where the money went.
 */
function poolImpacts(
  beforeRows: CalcEmployee[],
  afterRows: CalcEmployee[],
  caps: Caps,
  recipients: Set<string>
): DaPoolImpact[] {
  if (recipients.size === 0) return [];
  const states = new Set(
    afterRows.filter((e) => recipients.has(e.id)).map((e) => e.st)
  );
  const sum = (rows: CalcEmployee[], of: (e: CalcEmployee) => boolean) =>
    rows.reduce((s, e) => (of(e) ? s + e.finalBonus : s), 0);
  const caveats: Record<string, number | null> = {
    VIC: caps.vCap,
    NSW: caps.nCap,
    SHARED: null,
  };
  const pools: DaPoolImpact[] = [];
  for (const st of ["VIC", "NSW", "SHARED"] as const) {
    if (!states.has(st)) continue;
    pools.push({
      key: st,
      before: sum(beforeRows, (e) => e.st === st),
      after: sum(afterRows, (e) => e.st === st),
      cap: caveats[st],
    });
  }
  pools.push({
    key: "GROUP",
    before: sum(beforeRows, () => true),
    after: sum(afterRows, () => true),
    cap: caps.gCap,
  });
  return pools;
}
