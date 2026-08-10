/**
 * Pure snapshot policy helpers (testable without the store).
 */

/**
 * Every save gets its own snapshot.
 *
 * This used to coalesce 'edit' snapshots within a five-minute window, because
 * a debounced autosave fired on every keystroke burst and snapshotting each
 * one would evict the whole 50-slot window in minutes. Saving is now an
 * explicit button press, so one save is exactly one deliberate act and
 * deserves exactly one restore point — which is what the walkthrough asked
 * for. The helper stays so the policy has one obvious home if it ever needs
 * to change again.
 */
export function shouldCoalesce(): boolean {
  return false;
}
