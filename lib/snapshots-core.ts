/**
 * Pure snapshot policy helpers (testable without the store).
 */

/**
 * Debounced override saves fire on every keystroke burst; snapshotting each
 * one would evict the whole 50-slot window in minutes. An 'edit' snapshot is
 * skipped when the newest snapshot is the same actor + reason within the
 * coalescing window. Every other reason (import, params, columns, access,
 * restore) always snapshots.
 */
export const EDIT_COALESCE_MS = 5 * 60 * 1000;

export function shouldCoalesce(
  newest: { ts: string; actor: string; reason: string } | undefined,
  actor: string,
  reason: string,
  nowIso: string
): boolean {
  if (reason !== "edit") return false;
  if (!newest) return false;
  if (newest.actor !== actor || newest.reason !== "edit") return false;
  return (
    new Date(nowIso).getTime() - new Date(newest.ts).getTime() <
    EDIT_COALESCE_MS
  );
}
