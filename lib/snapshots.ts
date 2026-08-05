import "server-only";
import type { Snapshot } from "./schema";
import { getDataset } from "./data";
import {
  loadOverrides,
  saveOverrides,
  saveStoredDataset,
  loadSnapshots,
  pushSnapshot,
  appendHistory,
} from "./store";
import { shouldCoalesce } from "./snapshots-core";

/**
 * Take a full point-in-time snapshot of everything mutable. Called BEFORE
 * every mutating action. Never throws for 'edit' saves (a snapshot failure
 * must not block a bonus edit); rethrows for explicit admin actions so the
 * action aborts rather than running unprotected.
 */
export async function takeSnapshot(actor: string, reason: string): Promise<void> {
  try {
    const [dataset, overrides, existing] = await Promise.all([
      getDataset(),
      loadOverrides(),
      loadSnapshots(1),
    ]);
    const now = new Date().toISOString();
    if (shouldCoalesce(existing[0], actor, reason, now)) return;

    const snapshot: Snapshot = {
      ts: now,
      actor,
      reason,
      state: {
        dataset,
        overrides,
        params: null, // populated once the params doc exists
        columns: null, // populated once the column-config doc exists
      },
    };
    await pushSnapshot(snapshot);
  } catch (err) {
    if (reason === "edit") {
      console.error("[snapshots] failed to snapshot before edit (continuing):", err);
      return;
    }
    throw err;
  }
}

/**
 * Restore a snapshot by timestamp. Takes a 'pre-restore' snapshot first so
 * the restore itself can be undone.
 */
export async function restoreSnapshot(ts: string, actor: string): Promise<void> {
  const snapshots = await loadSnapshots();
  const target = snapshots.find((s) => s.ts === ts);
  if (!target) throw new Error("Snapshot not found");

  await takeSnapshot(actor, "pre-restore");

  await saveStoredDataset(target.state.dataset);
  await saveOverrides(target.state.overrides);
  // params/columns are restored verbatim when present (later steps write them)

  await appendHistory([
    {
      ts: new Date().toISOString(),
      actor,
      kind: "restore",
      summary: `Restored snapshot from ${new Date(target.ts).toLocaleString("en-AU")} (taken by ${target.actor}, reason: ${target.reason})`,
    },
  ]);
  console.log(
    `[audit] restore by=${actor} snapshot=${ts} ts=${new Date().toISOString()}`
  );
}
