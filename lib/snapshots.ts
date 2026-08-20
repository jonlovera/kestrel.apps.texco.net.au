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
  clearColumnConfig,
  loadCopy,
  saveCopy,
  clearCopy,
  loadSnapshots,
  pushSnapshot,
  appendHistory,
  loadAccessOverlay,
  saveAccessOverlay,
} from "./store";
import { loadParams, saveParams, clearParams } from "./store";
import { shouldCoalesce } from "./snapshots-core";
import { ColumnConfigSchema } from "./columns";
import { CopySchema } from "./copy";
import { ParamsSchema } from "./params-apply";
import { AccessRuleSchema } from "./access-rules";
import { z } from "zod";

/**
 * Take a full point-in-time snapshot of everything mutable. Called BEFORE
 * every mutating action. Never throws for 'edit'/'autosave' saves (a snapshot
 * failure must not block a bonus edit); rethrows for explicit admin actions
 * so the action aborts rather than running unprotected.
 */
export async function takeSnapshot(actor: string, reason: string): Promise<void> {
  try {
    const [dataset, overrides, overridesVersion, columns, copy, params, access, recent] =
      await Promise.all([
        getDataset(),
        loadOverrides(),
        loadOverridesVersion(),
        loadColumnConfig(),
        loadCopy(),
        loadParams(),
        loadAccessOverlay(),
        loadSnapshots(1),
      ]);
    const now = new Date().toISOString();
    if (shouldCoalesce(recent[0], actor, reason, new Date(now))) return;

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
        access,
      },
    };
    await pushSnapshot(snapshot);
  } catch (err) {
    if (reason === "edit" || reason === "autosave") {
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

  // Restore means EVERYTHING goes back — including the documents that did
  // not exist yet when the snapshot was taken. A snapshot holding null (or
  // nothing) for one of these recorded "no stored doc", so the doc is
  // cleared back to its defaults rather than silently left at today's
  // values. That used to keep today's caps and company modifier across an
  // old restore, which is a wrong set of figures wearing a restored label.
  const cols = ColumnConfigSchema.safeParse(target.state.columns);
  if (cols.success) await saveColumnConfig(cols.data);
  else await clearColumnConfig();
  const params = ParamsSchema.safeParse(target.state.params);
  if (params.success) await saveParams(params.data);
  else await clearParams();
  const copy = CopySchema.safeParse(target.state.copy);
  if (copy.success) await saveCopy(copy.data);
  else await clearCopy();

  // Access rules. Older snapshots carry no `access` at all — for those,
  // access is left alone (there is nothing recorded to restore to), which is
  // exactly the old behaviour. When the snapshot does carry the overlay, it
  // is restored with one guard: the restoring admin keeps the access they
  // hold RIGHT NOW, whatever the snapshot says. A restore must never be able
  // to lock out the person performing it, or hand them a different grant as
  // a side effect of their own click.
  if (target.state.access !== undefined && target.state.access !== null) {
    const AccessOverlay = z.record(z.string(), AccessRuleSchema);
    const parsed = AccessOverlay.safeParse(target.state.access);
    if (parsed.success) {
      const restored = { ...parsed.data };
      const current = await loadAccessOverlay();
      if (current[actor]) restored[actor] = current[actor];
      else delete restored[actor];
      await saveAccessOverlay(restored);
    } else {
      console.error(
        `[snapshots] snapshot ${ts} carries an unreadable access overlay; access left as is`
      );
    }
  }

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
