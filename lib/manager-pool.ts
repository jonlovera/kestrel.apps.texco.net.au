/**
 * A manager's own pool figures — the header a scoped lead needs instead of
 * the group-level "VIC pool" card (a whole-state figure) and the filtered
 * table total, both of which were sums of finals wearing the wrong labels.
 *
 * ONE DEFINITION, FOR EVERY GRANT SHAPE (owner decision, 28 August 2026).
 *
 *   pool       What is already committed to that lead's own people, plus their
 *              PROPORTIONAL SHARE of what their states have not allocated yet:
 *
 *                pool = Σ [ ourAllocated(st) + share(st) × stateRoom(st) ]
 *
 *                                Σ committed over the rows in their budget
 *                share(st)  =   ──────────────────────────────────────────
 *                                Σ committed over every row st's pool funds
 *
 *              over st ∈ { VIC, NSW }, where `committed` is finalBonus − daEdit
 *              (the payout a row carries BEFORE anybody grants anything on top
 *              of it) and `stateRoom` is lib/calc.ts's — the state's cap net of
 *              its FY26 carve-outs, less every payout charged to it. That is
 *              the same subtraction the admin's pool card headlines and gate 4
 *              enforces, which is what keeps the two views one figure.
 *
 *              THE COMMITTED HALF IS A FLOOR, and that is the point. A share of
 *              the state's GROSS pool — what this was until 28 August 2026 —
 *              can come out below the payouts already legitimately made to the
 *              scope's own people, which reports a lead as over a cap they
 *              never spent against. See rulePool for the live numbers. A cap
 *              must never retrospectively turn a valid commitment into an
 *              overspend, so the commitment is kept and the share applies only
 *              to what is genuinely left.
 *
 *              A WHOLE-STATE grant still lands on exactly the state pool, so an
 *              admin's card and a state lead's header stay one number: they
 *              hold every row the pool funds, so share is bit-exactly 1 and
 *              ourAllocated is the state's whole home total, leaving
 *              homeTotal + (statePool − homeTotal). Several states sum their
 *              terms. The special case that used to exist for
 *              `rule.type === "state"` is gone because it is no longer special.
 *
 *              MEASURED AT THE BASELINE, not on the document being edited — see
 *              `baseline` on managerPoolFrom. The cap is "what you started with,
 *              plus your share of the room that was there", so it holds still
 *              while a lead types and their spending eats it dollar for dollar.
 *
 * WHAT THIS REPLACED, AND WHY IT HAD TO GO
 *
 * Until 28 August 2026 anything that was not a whole-state grant got Σ
 * calcBonus over its rows — the "entitlement" definition. That put the header's
 * two figures on DIFFERENT BASES: `pool` was the advisory Calc bonus column,
 * recomputed live at the current scale, while `allocated` was the stored
 * payouts. The two were equal by construction only while a payout WAS derived
 * from calcBonus, and they stopped being equal on 25 August 2026 when payouts
 * became stored figures (lib/calc.ts's baseAmount). Once /api/recalculate
 * pinned vicScale at 0.703 the gap became structural, and the header reported
 * it as a breach.
 *
 * On the live document that showed Clint Cassar (a GROUP rule — VIC + SHARED,
 * sixteen positions) $38,558 over a pool he had granted nothing from:
 *
 *   $15,880  discretionary on four VIC site managers, which only a full-access
 *            admin holding canEditVicSiteManagers can even write
 *   $22,678  twenty-one ISSUED rows whose committed amounts sit above their
 *            entitlement at the pinned scale — a one-way door by design
 *        $0  anything he did
 *
 * with $4,661 genuinely left in the VIC pool and gate 4 willing to grant it.
 * The old docblock predicted exactly this ("that leaves a lead with almost no
 * headroom at all … and every grant they tried would be refused") and treated
 * it as the acceptable cost of not handing a subset lead a whole state's cap.
 * It was not acceptable: gate 3 was refusing every lead below full access
 * against a figure that was not a budget. The proportional share gives a
 * subset lead a real budget without giving them the whole state.
 *
 * WHOSE ROWS ARE IN THE BUDGET
 *
 * `pool` and `allocated` are measured over the SAME rows — that is the whole
 * lesson above — and exactly one kind of in-scope row is left out of both:
 * ROWS NO STATE POOL FUNDS (lib/calc.ts's fundedByStatePool), meaning Shared
 * Services and the part-split staff whatever state label they carry. The FY26
 * state pools are DEFINED net of the shared-services and split-state carves
 * (lib/fy26-caps.ts), so charging those payouts to a state pool bills the same
 * money twice (docs/bonus-reconciliation.md §9). Gate 4 already declines to
 * bound them for the same reason.
 *
 * That exclusion does not touch `people`, which stays every row the rule
 * matches: a row outside the budget is still theirs to see and manage, its
 * money just comes from somewhere else.
 *
 * NESTED SCOPES ARE DELIBERATELY NOT DEDUCTED (owner decision, 28 August 2026,
 * reversing the same day's first attempt).
 *
 * Glick's seven VIC positions sit wholly inside Cassar's sixteen, so their
 * shares of the VIC pool sum to more than 100% and the same room is offered to
 * both. That was briefly treated as double-booking and deducted from the outer
 * scope. It is not: a nested manager scope is a PERMISSION boundary, not a
 * reserved funding carve-out. Cassar is accountable for every person his grant
 * authorises, Glick's twenty-five included, and a cap measured over anything
 * narrower is not his cap — it also left gate 3 unable to bound his edits to
 * those rows from his own view, which was strictly worse than the overlap it
 * was trying to fix.
 *
 * So a lead's budget is their FULL authorised state-pool-funded scope, and
 * overlapping shares are expected rather than a fault. What stops two leads
 * spending the same dollar is the state-level bound that was always the real
 * constraint: lib/calc.ts's capRoom, which measures the whole state's payouts
 * against the state pool on every write (/api/state's gate 4). Gate 3 bounds
 * each lead against their own share; gate 4 bounds everyone against the pool
 * itself, and it is the one that refuses whoever spends the last of it.
 *
 * LOCKED AND ISSUED ROWS ARE INCLUDED, as they always were. A frozen person
 * still draws from the pool their manager answers for; locking means the
 * manager cannot edit the row, not that the money left. What changed is that
 * their committed amount now sits on BOTH sides of the comparison instead of
 * only on the `allocated` side, so it no longer manufactures a breach.
 *
 * REDISTRIBUTION RELIES ON ALL OF THAT
 *
 * `remaining` is the budget lib/redistribute.ts spends: it splits that figure
 * across the people a lead has selected, by writing explicit amounts. Three
 * properties make that safe, and all three survive this change —
 *
 *  - a discretionary amount moves no WEIGHT, because the weights are committed
 *    payouts and `committed` backs the amount out. So `pool` is DA-neutral, a
 *    DA of X raises `allocated` by exactly X and lowers `remaining` by exactly
 *    X, one pass lands it on zero and a second pass distributes nothing;
 *  - `pool` does not move underneath the calculation while it runs;
 *  - and nobody outside the scope is touched.
 *
 * An earlier design funded an amount FROM the pool by moving the state scale,
 * and broke all three: `allocated` no longer rose by the amount, `remaining`
 * barely moved for a whole-state lead so poolBreach below could not bound it at
 * all, and the whole state reflowed regardless of scope. It was removed. If
 * anything ever reintroduces a scale-moving discretionary amount, this gate
 * stops being a budget and redistribution stops converging.
 *
 * What DOES move `pool` now, and did not before: another lead's committed
 * amounts, since the share's denominator is population-wide. Honest — they are
 * spending one pool between them — and it cannot happen mid-request.
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
  fundedByStatePool,
  stateRoom,
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

/** The states holding a pool of their own. Shared Services has none. */
const BUDGET_STATES = ["VIC", "NSW"] as const;
type BudgetState = (typeof BUDGET_STATES)[number];

/**
 * The payout a row carries BEFORE any grant — finalBonus less its
 * discretionary amount. The share's weight, and the reason `pool` cannot move
 * when somebody types an amount.
 */
function committed(e: CalcEmployee): number {
  return e.finalBonus - e.daEdit;
}

/**
 * Whether one in-scope row's payout is charged to this rule's budget — and so
 * whether the row's own draw is what `pool` was built from. False only for a
 * row no state pool funds; see the module header, including why a row held by
 * a nested grant is NOT excluded. Exported so lib/scope-core.ts can send the
 * same verdict to the browser as `inHomeTotal`, where the lead's ceiling and
 * the redistribution budget re-measure this sum without the engine.
 *
 * Takes the row alone: nothing about the RULE changes the answer, which is the
 * point — every lead's budget covers their whole authorised scope.
 */
export function countsAgainstPool(e: CalcEmployee): boolean {
  return fundedByStatePool(e);
}

/**
 * Does this rule NAME a state, as opposed to merely happening to hold rows in
 * it? Only consulted when a state's pool has nothing drawing on it at all, to
 * decide whether the whole thing is this scope's headroom: a NSW lead whose
 * state is empty holds every row NSW funds — vacuously, all none of them — and
 * their budget is the NSW pool, not zero. A subset names no state, so an empty
 * state is not theirs; a group with no states listed means "any", so it is.
 */
function coversState(rule: GrantingRule, st: BudgetState): boolean {
  if (rule.type !== "state" && rule.type !== "group") return false;
  return (
    rule.states.length === 0 ||
    (rule.states as readonly string[]).includes(st)
  );
}

/**
 * The budget: for each state this scope draws on, the payouts already committed
 * to ITS OWN people there, plus its share of what that state has actually not
 * allocated yet.
 *
 *   cap(st) = ourAllocated(st) + share(st) × stateRoom(st)
 *
 * This is the correction of 28 August 2026. It used to be
 * `statePool(st) × share(st)` — a slice of the state's GROSS pool — and that
 * could come out BELOW the payouts already legitimately committed to the
 * scope's own people, reporting a lead as over a cap they had never spent
 * against. On the live document it showed Clint Cassar a $1,021,810 cap against
 * $1,024,893 of standing commitments, $15,880 of which sits on VIC site
 * managers only a full-access admin may touch. A cap must never retrospectively
 * turn a valid commitment into an overspend, so the commitment is the FLOOR and
 * the share applies only to the room that is genuinely left.
 *
 * `stateRoom` is lib/calc.ts's, which is the same subtraction /api/state's
 * gate 4 (capRoom) and the admin's own pool card perform. It is deliberately
 * not derived from the scope's rows: a lead's share has to be a share of the
 * state's real position, not of a figure only their own view can see.
 *
 * A WHOLE-STATE grant still lands on exactly the state pool, so an admin's card
 * and a state lead's header stay one number: they hold every row the pool
 * funds, so share is 1 and ourAllocated is the state's whole home total, giving
 * homeTotal + (statePool - homeTotal).
 *
 * NEGATIVE room is passed straight through rather than clamped to zero. If a
 * state is genuinely over its cap, saying so is the honest answer and is what
 * keeps a whole-state lead identical to the authoritative figure; fabricating
 * room is how a pool gets overspent. What that costs the lead is only new
 * net-positive spending, which is the intended outcome — poolBreach still lets
 * a neutral or reducing save through.
 *
 * The fallback matters. A scope no state pool funds at all — a hypothetical
 * Shared-Services-only grant — would otherwise get a budget of 0 and be dead
 * on arrival, every amount refused with no room to be had anywhere. It keeps
 * the pre-28-August entitlement figure instead, which is a defensible answer
 * for rows whose funding lives outside both state pools, and gate 4 gives them
 * no state bound either. Nobody holds such a grant today.
 */
/**
 * The per-state share arithmetic, and what it produces.
 *
 * `ourAllocated` — Σ payout over the scope's own rows that this state's pool
 * funds. Its commitment floor.
 * `shareOfRoom`  — its share of what the state has NOT allocated yet, the
 * share weighted by committed payouts and the room taken from lib/calc.ts's
 * `stateRoom` (the figure gate 4 and the admin's card both read).
 * `funded`       — whether any state pool reaches this scope at all.
 */
function stateShares(
  rule: GrantingRule,
  budgeted: readonly CalcEmployee[],
  emps: readonly CalcEmployee[],
  caps: Caps
): { ourAllocated: number; shareOfRoom: number; funded: boolean } {
  let ourAllocated = 0;
  let shareOfRoom = 0;
  let funded = false;
  for (const st of BUDGET_STATES) {
    const room = stateRoom(st, emps, caps);
    if (room === null) continue;

    let all = 0;
    for (const e of emps) {
      if (e.st === st && fundedByStatePool(e)) all += committed(e);
    }
    let ours = 0;
    let mineHere = 0;
    for (const e of budgeted) {
      if (e.st !== st) continue;
      ours += committed(e);
      mineHere += e.finalBonus;
    }

    // Nothing draws on this pool at all. A rule that NAMES the state holds all
    // none of its rows and so holds all of its room; anything else gets no
    // claim on a pool it only reaches by accident. Stated as a share so the one
    // formula covers it, and so there is no division by zero.
    const share = all <= 0 ? (coversState(rule, st) ? 1 : 0) : ours / all;
    if (share <= 0) continue;
    funded = true;
    ourAllocated += mineHere;
    // `ours / all` is bit-exactly 1 for a whole-state grant (the two sums run
    // over the same rows in the same order), which is what makes that lead's
    // cap bit-exactly the figure on the admin's card.
    shareOfRoom += share * room;
  }
  return { ourAllocated, shareOfRoom, funded };
}

/**
 * Whether this scope's cap IS the authoritative state pool, rather than an
 * admin-set figure. True for a whole-state grant and nothing else.
 *
 * A state lead holds every row their states' pools fund, so their share is 1
 * and their cap comes out at exactly the pool — the same number on the admin's
 * card, in gate 4 and in their own header. That identity is not an admin's to
 * override, so /admin shows those three figures read-only and
 * `allocationCap` is ignored for them (owner decision, 28 August 2026).
 *
 * Deliberately the rule TYPE and not "does this scope happen to hold 100% of a
 * state today". A group rule that covers a whole state by coincidence is still
 * a group rule, and next week's new starter would silently change what its cap
 * means. Exported so lib/scope-core.ts and /admin's editor decide it the same
 * way.
 */
export function capIsStatePool(rule: GrantingRule): boolean {
  return rule.type === "state";
}

/**
 * The additional allocation this scope WOULD get under the derived formula —
 * its share of the state room, and nothing else.
 *
 * This used to be half of the cap itself. It is now only a SUGGESTION, offered
 * in /admin beside the allowance field so an admin has a defensible starting
 * figure ("your slice of what VIC has left is $545"). Nothing applies it
 * automatically: the whole point of the change on 28 August 2026 is that the
 * figure a lead spends against is one a person decided, not one the arithmetic
 * regenerates behind them.
 *
 * Meaningless for a whole-state scope, whose room is not a share of anything —
 * use their ManagerPool.remaining instead, which IS the state's room.
 */
export function suggestedAllowance(
  rule: GrantingRule,
  emps: readonly CalcEmployee[],
  caps: Caps
): number {
  const budgeted = emps.filter(
    (e) => ruleMatches(rule, e) && countsAgainstPool(e)
  );
  return stateShares(rule, budgeted, emps, caps).shareOfRoom;
}

/**
 * The budget.
 *
 * A WHOLE-STATE grant is unchanged: its own commitments plus its share of the
 * state's remaining room, which for a share of 1 is exactly the state pool.
 *
 * Anything narrower — a group or a subset — takes the ADMIN'S FIGURE.
 * `allocationCap` is the ceiling Dee set (lib/access-rules.ts), and absent
 * means no allowance has been granted, so the cap is exactly what is already
 * committed to their people and there is no new money to spend. That is the
 * point: the derived share regenerated after every save, handing the allowance
 * back each time, and no amount of arithmetic can decide how much a lead ought
 * to be trusted with. `suggestedAllowance` above is what /admin offers instead.
 *
 * Note what is NOT here any more: the Shared-Services-only fallback to Σ
 * calcBonus. Such a scope now reads cap 0 / allocated 0 / remaining 0 until an
 * admin grants it an allowance, which is a better answer than a budget nobody
 * chose — and there is no such grant today.
 */
function rulePool(
  rule: GrantingRule,
  budgeted: readonly CalcEmployee[],
  emps: readonly CalcEmployee[],
  caps: Caps
): number {
  const { ourAllocated, shareOfRoom } = stateShares(rule, budgeted, emps, caps);
  // A FULL rule takes the derived branch too. Not because an admin has a
  // manager pool — poolBreach returns null for them and nothing shows them
  // this figure — but because they hold every row, so the derived answer is
  // the state pools themselves, which is the only honest thing to return for a
  // scope that is the whole scheme. There is nowhere to hang an allowance on a
  // full rule and no reason to.
  if (rule.type === "full" || capIsStatePool(rule)) {
    return ourAllocated + shareOfRoom;
  }
  return rule.allocationCap ?? ourAllocated;
}

/**
 * A scope's UNUSED reservation: how much of its admin-set cap is not yet
 * committed. Zero for a scope with no cap set, and never negative — a scope
 * that has somehow overshot its ceiling is holding nothing back for later.
 */
function unusedAllocation(
  rule: GrantingRule,
  emps: readonly CalcEmployee[]
): number {
  if (rule.type === "full" || rule.allocationCap === undefined) return 0;
  let allocated = 0;
  for (const e of emps) {
    if (ruleMatches(rule, e) && countsAgainstPool(e)) allocated += e.finalBonus;
  }
  return Math.max(0, rule.allocationCap - allocated);
}

/** The states whose pools fund any of this scope's rows. */
function statesDrawnOn(
  rule: GrantingRule,
  emps: readonly CalcEmployee[]
): BudgetState[] {
  return BUDGET_STATES.filter((st) =>
    emps.some(
      (e) => e.st === st && fundedByStatePool(e) && ruleMatches(rule, e)
    )
  );
}

/**
 * The most additional allocation an admin may reserve for one scoped lead —
 * the bound /api/access refuses a save against.
 *
 *   max = Σ_st [ stateRoom(st) − Σ_{OTHER scopes holding a cap in st} unused ]
 *
 * NOTE WHAT IS NOT SUBTRACTED: this lead's own unused reservation. `stateRoom`
 * is the cap less PAYOUTS, and a reservation is not a payout, so their existing
 * allowance is still sitting inside that room — subtracting it as well would
 * charge them for it twice and quietly shrink what an admin may re-grant. It is
 * the whole reason `peers` excludes the lead being edited rather than covering
 * everybody. Worked shape: a lead holding $675 unused where the state has
 * $5,000 nobody has reserved may be raised to $5,675, not $5,000.
 *
 * A peer spanning two states has its unused reservation subtracted from BOTH,
 * which over-counts. Deliberately the conservative direction — it can only ever
 * refuse a grant that might have fitted, never allow one that cannot — and no
 * scope draws on more than one state today.
 *
 * Can be NEGATIVE when reservations already exceed the room, which honestly
 * means "nothing more may be reserved"; callers compare against it rather than
 * clamping.
 */
export function maxAdditionalAllocation(
  rule: GrantingRule,
  peers: readonly GrantingRule[],
  emps: readonly CalcEmployee[],
  caps: Caps
): number {
  let max = 0;
  for (const st of statesDrawnOn(rule, emps)) {
    const room = stateRoom(st, emps, caps);
    if (room === null) continue;
    let reserved = 0;
    for (const peer of peers) {
      if (statesDrawnOn(peer, emps).includes(st)) {
        reserved += unusedAllocation(peer, emps);
      }
    }
    max += room - reserved;
  }
  return max;
}

/**
 * The figures, from rows the engine has ALREADY been run over. The read path
 * takes this one: lib/scope-core.ts has computed the population before it needs
 * a header, and /api/preview re-runs that on every keystroke burst — a second
 * engine pass there would be pure waste.
 *
 * `baseline` is the same population computed from the STORED document, and it
 * is what the CAP is measured from. Omit it and the document being measured is
 * its own baseline, which is what the page load means: it is measuring the
 * stored document already.
 *
 * Why the cap needs a baseline at all. Both of its halves move when somebody
 * types a discretionary amount — the committed floor goes up by the amount and
 * the state's room goes down by it — so measured on the live document the cap
 * would drift upward by (1 − share) × amount and `remaining` would fall by only
 * `share` × amount. Two things break at that point: gate 3 stops being a bound
 * a lead can spend up to exactly, and a redistribution stops converging (it
 * spends `remaining`, expecting that to drive it to zero — see
 * lib/redistribute.ts, which documents pressing the button twice as a no-op).
 * Holding the cap at the baseline keeps it still while they work, so every
 * dollar granted lowers `remaining` by exactly a dollar.
 *
 * `emps` MUST BE THE WHOLE POPULATION, not the rows already narrowed to the
 * scope. This function applies the scope filter itself, and the share's
 * denominator is a whole-population sum — how much of each state pool
 * everybody draws. Hand it pre-filtered rows and the lead's own draw is divided
 * by itself, making every share 1 and every budget the entire state pool. (That
 * is exactly what happened the first time this was wired up: a lead's header
 * read $767,964 against a true $577,226, because the caller had been passing
 * the filtered rows since back when the filter was the only thing `emps` was
 * for.)
 *
 */
export function managerPoolFrom(
  rule: GrantingRule,
  emps: readonly CalcEmployee[],
  caps: Caps,
  baseline: readonly CalcEmployee[] = emps
): ManagerPool {
  const mine = emps.filter((e) => ruleMatches(rule, e));
  const budgeted = mine.filter((e) => countsAgainstPool(e));
  const base = baseline === emps ? mine : baseline.filter((e) => ruleMatches(rule, e));
  const pool = rulePool(
    rule,
    base.filter((e) => countsAgainstPool(e)),
    baseline,
    caps
  );
  const allocated = sumAllocated(budgeted, (e) => e.finalBonus);
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
  overrides: Overrides,
  baselineOverrides?: Overrides
): ManagerPool {
  const emps = applyOverrides(data.emp, overrides);
  computeScalesAndBonuses(emps, data);
  if (baselineOverrides === undefined || baselineOverrides === overrides) {
    return managerPoolFrom(scope.rule, emps, data);
  }
  const base = applyOverrides(data.emp, baselineOverrides);
  computeScalesAndBonuses(base, data);
  return managerPoolFrom(scope.rule, emps, data, base);
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
export const EPSILON = 0.01;

/** How far over their pool this document puts the manager (0 if not over). */
function overBy(
  scope: Scope,
  data: Dataset,
  doc: Overrides,
  stored: Overrides
): number {
  return Math.max(0, -managerPool(scope, data, doc, stored).remaining);
}

/**
 * Would this save push the manager FURTHER above their pool?
 *
 * Null when it wouldn't — which deliberately includes a save that holds or
 * reduces a breach that was already stored. A manager can inherit an
 * over-pool state they did not create (an admin grants an amount on a row only
 * they can edit, or a cap moves under everyone); a plain "refuse while over"
 * gate would then lock them out of saving the very correction that fixes it. So
 * the comparison is against the stored document, not against zero. The browser
 * mirrors this, and used to not: it disabled Save on any negative Remaining at
 * all, which is how a lead ended up unable to save anything.
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
  // Both measured against the cap the STORED document implies, so the only
  // thing that moves between them is the allocation. That is what makes
  // spending exactly `remaining` land on nil and a dollar more not.
  const wasOver = overBy(scope, data, stored, stored);
  const over = overBy(scope, data, next, stored);
  if (over <= wasOver + EPSILON) return null;
  return { over, wasOver };
}
