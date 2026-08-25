/**
 * Pricing a discretionary grant that arrives in the same save as a lock.
 *
 * The filename is historical. This module used to hold the lock/unlock
 * "transition normalizers": one froze a new lock at the row's current payout
 * (`freezeNewLocks`), the other back-filled a discretionary amount on unlock so
 * the total held steady (`preserveUnlockPayouts`). Both are gone as of 25 August
 * 2026, and neither is coming back — they existed only because a payout changed
 * when the lock flag did, which was the actual defect. A payout is now a stored
 * figure that no lock transition reads (see lib/calc.ts), so locking and
 * unlocking write one boolean and move no money. Nothing to freeze, nothing to
 * preserve.
 *
 * What is left is a different question, and a real one.
 */
import { applyOverrides, computeScalesAndBonuses } from "./calc";
import type { CalcEmployee } from "./calc";
import type { Dataset, Overrides } from "./schema";

/**
 * The rows a save's discretionary grant is priced against, for /api/state's
 * headroom gate.
 *
 * getMaxDA reports no room at all for a locked row, because a locked row is
 * settled and nothing should be topping it up. That is right for a row locked in
 * an earlier save, and wrong for a row being granted and locked in the same save
 * — an ordinary grant that happens to be signed off in the same click. Judging
 * that row with its own new lock applied refused it with "at most $0", and the
 * only way through was to unlock, save, lock, and save again to record identical
 * numbers.
 *
 * So a lock this save is creating is released for the measurement, everything
 * else left as the save has it — including other rows' locks, whose stored
 * payouts are what the pool actually holds.
 */
export function rowsForGrantJudgement(
  data: Dataset,
  next: Overrides,
  previous: Overrides,
  empId: string
): CalcEmployee[] {
  const lockIsNew =
    (next[empId]?.locked ?? false) && !(previous[empId]?.locked ?? false);
  const doc: Overrides = lockIsNew
    ? { ...next, [empId]: { ...(next[empId] ?? {}), locked: false } }
    : next;
  const rows = applyOverrides(data.emp, doc);
  computeScalesAndBonuses(rows, data);
  return rows;
}
