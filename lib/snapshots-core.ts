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
 * with snapshots now kept forever this coalescing is the one brake on how
 * fast the list (and its storage, ~37 kB a row) grows — so consecutive
 * autosaves by the SAME person within ten minutes coalesce onto the newest
 * existing restore point, whether that was an earlier autosave or their own
 * manual Save. A different actor, a stale window, or any other reason
 * ("dataset", "pre-restore", …) always snapshots.
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

/**
 * Which rows the snapshots page needs from the store for one page.
 *
 * The "What changed" column diffs each snapshot against its NEWER
 * neighbour (snapshots are pre-mutation), so a page needs one extra row at
 * the newer edge to diff its first visible row against. Page 1 needs no
 * extra: the live state is that row's partner. The off-by-one here is easy
 * to get wrong, which is why it lives in a pure function with tests.
 */
export function snapshotPageWindow(
  page: number,
  pageSize: number
): { offset: number; limit: number; leadingPartner: boolean } {
  const p = Math.max(1, Math.floor(page));
  if (p === 1) return { offset: 0, limit: pageSize, leadingPartner: false };
  return {
    offset: (p - 1) * pageSize - 1,
    limit: pageSize + 1,
    leadingPartner: true,
  };
}
