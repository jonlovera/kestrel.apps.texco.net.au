/**
 * What figure a newly locked row is frozen at.
 *
 * Locking freezes a payout, so the frozen number IS the payout — which makes it
 * the last figure that should ever be taken on trust from a browser. It used to
 * be: /api/state accepted whatever `lockedFinal` arrived and computed one only
 * when the field was missing. That cost a lead their discretionary amount. Their
 * lock freezes the last figure /api/preview handed back, that preview is
 * debounced 350ms, and a lock clicked inside the window froze the total from
 * BEFORE the amount was typed — then paid it for good, with the amount still
 * sitting in its own column and nothing on screen to say where the money went.
 * An admin never hit it, because their lock reads the local engine
 * synchronously.
 *
 * So the server computes it, from the document actually being saved: the row's
 * own lock released, everything else as it stands, and the resulting finalBonus
 * (not calcBonus — the frozen figure is the actual payout, discretionary amount
 * included).
 *
 * Only rows whose lock is NEW in this save are touched. A row locked in an
 * earlier save keeps its stored figure: that is a historical record of what was
 * frozen at the time, and recomputing it would silently repay it at today's
 * figures.
 *
 * Pure apart from writing `lockedFinal` into `next`, which is the shape the
 * route needs (the sanitised document goes on to the pool gate and the save).
 */
import { applyOverrides, computeScalesAndBonuses } from "./calc";
import type { Dataset, Overrides } from "./schema";

export function freezeNewLocks(
  data: Dataset,
  next: Overrides,
  previous: Overrides
): string[] {
  const frozen: string[] = [];
  for (const [id, ov] of Object.entries(next)) {
    if (!ov.locked || previous[id]?.locked) continue;
    // this row unlocked, so the engine prices it as it would be paid; every
    // other row's state is left exactly as this save has it
    const doc: Overrides = { ...next, [id]: { ...ov, locked: false } };
    const emps = applyOverrides(data.emp, doc);
    computeScalesAndBonuses(emps, data);
    const row = emps.find((e) => e.id === id);
    if (!row) continue;
    ov.lockedFinal = row.finalBonus;
    frozen.push(id);
  }
  return frozen;
}

/**
 * Unlock is also number-neutral: preserve the row's frozen payout first, then
 * remove the freeze state.
 *
 * The carried value is persisted as the row's discretionary amount in the same
 * transition, so a no-op save/reload or an unrelated edit cannot snap the row
 * back to a derived figure.
 */
export function preserveUnlockPayouts(
  data: Dataset,
  next: Overrides,
  previous: Overrides
): string[] {
  const ids = Object.entries(previous)
    .filter(([id, prev]) => prev.locked && !(next[id]?.locked ?? false))
    .map(([id]) => id);
  if (ids.length === 0) return [];

  const beforeRows = applyOverrides(data.emp, previous);
  computeScalesAndBonuses(beforeRows, data);
  const beforeById = new Map(beforeRows.map((e) => [e.id, e]));

  // Price the post-unlock document exactly as it stands now (locks already
  // toggled, before any carry values are written) so each unlocked row can be
  // translated to the equivalent unlocked DA at this instant.
  const afterRows = applyOverrides(data.emp, next);
  computeScalesAndBonuses(afterRows, data);
  const afterById = new Map(afterRows.map((e) => [e.id, e]));

  const preserved: string[] = [];
  for (const id of ids) {
    const was = beforeById.get(id);
    const now = afterById.get(id);
    if (!was || !now) continue;
    const keep = was.finalBonus;
    const daEdit = keep - now.calcBonus;
    next[id] = { ...(next[id] ?? {}), locked: false, daEdit };
    delete next[id].lockedFinal;
    preserved.push(id);
  }
  return preserved;
}

/**
 * One transition normalizer for /api/state:
 *  - new locks are frozen from the row's current displayed payout
 *  - unlocks preserve their frozen payout as the unlocked baseline
 */
export function normalizeLockTransitions(
  data: Dataset,
  next: Overrides,
  previous: Overrides
): { frozen: string[]; preserved: string[] } {
  const frozen = freezeNewLocks(data, next, previous);
  const preserved = preserveUnlockPayouts(data, next, previous);
  return { frozen, preserved };
}
