/**
 * Pure snapshot policy helpers (testable without the store).
 */

/** How long one autosave restore point stands in for the next ones. */
const COALESCE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Whether this save can ride on the previous snapshot instead of taking a
 * fresh one.
 *
 * A manual Save ("edit") is one deliberate act and always gets its own
 * restore point. The 3-minute autosave ("autosave") is not deliberate, and
 * snapshotting every tick would evict the whole 50-slot window in hours, so
 * consecutive autosaves by the SAME person within ten minutes coalesce onto
 * the newest existing restore point — whether that was an earlier autosave
 * or their own manual Save. A different actor, a stale window, or any other
 * reason ("dataset", "pre-restore", …) always snapshots.
 */
export function shouldCoalesce(
  prev: { ts: string; actor: string; reason: string } | undefined,
  actor: string,
  reason: string,
  now: Date
): boolean {
  if (reason !== "autosave") return false;
  if (!prev) return false;
  if (prev.actor !== actor) return false;
  if (prev.reason !== "autosave" && prev.reason !== "edit") return false;
  const prevTs = Date.parse(prev.ts);
  if (Number.isNaN(prevTs)) return false;
  return now.getTime() - prevTs < COALESCE_WINDOW_MS;
}
