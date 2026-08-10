import "server-only";
import type { Snapshot } from "./schema";
import { getDataset } from "./data";
import {
  loadOverrides,
  loadOverridesVersion,
  saveOverridesForce,
  saveStoredDataset,
  loadColumnConfig,
  saveColumnConfig,
  loadCopy,
  saveCopy,
  loadSnapshots,
  pushSnapshot,
  appendHistory,
} from "./store";
import { loadParams, saveParams } from "./store";
import { shouldCoalesce } from "./snapshots-core";
import { ColumnConfigSchema } from "./columns";
import { CopySchema } from "./copy";
import { ParamsSchema } from "./params-apply";

/**
 * Take a full point-in-time snapshot of everything mutable. Called BEFORE
 * every mutating action. Never throws for 'edit' saves (a snapshot failure
 * must not block a bonus edit); rethrows for explicit admin actions so the
 * action aborts rather than running unprotected.
 */
export async function takeSnapshot(actor: string, reason: string): Promise<void> {
  try {
    const [dataset, overrides, overridesVersion, columns, copy, params] =
      await Promise.all([
        getDataset(),
        loadOverrides(),
        loadOverridesVersion(),
        loadColumnConfig(),
        loadCopy(),
        loadParams(),
      ]);
    const now = new Date().toISOString();
    if (shouldCoalesce()) return;

    const snapshot: Snapshot = {
      ts: now,
      actor,
      reason,
      state: {
        dataset,
        overrides,
        overridesVersion,
        params,
        columns,
        copy,
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
  // Force-write bumps the version so open editors 409 and reload.
  await saveOverridesForce(target.state.overrides);
  const cols = ColumnConfigSchema.safeParse(target.state.columns);
  if (cols.success) await saveColumnConfig(cols.data);
  const params = ParamsSchema.safeParse(target.state.params);
  if (params.success) await saveParams(params.data);
  // absent in older snapshots than the editable wording — leave copy alone
  const copy = CopySchema.safeParse(target.state.copy);
  if (copy.success) await saveCopy(copy.data);

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
