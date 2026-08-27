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
  loadSnapshotByTs,
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
 * Everything mutable, as it stands right now.
 *
 * ONE definition of "everything", shared by the snapshot taken before each
 * change and by the backup an admin downloads (/api/backup). Expressing it
 * twice is how a backup quietly stops carrying a document that snapshots
 * gained — the failure would only show up when someone restored from it.
 */
export async function captureState(): Promise<Snapshot["state"]> {
  const [dataset, overrides, overridesVersion, columns, copy, params, access] =
    await Promise.all([
      getDataset(),
      loadOverrides(),
      loadOverridesVersion(),
      loadColumnConfig(),
      loadCopy(),
      loadParams(),
      loadAccessOverlay(),
    ]);
  return { dataset, overrides, overridesVersion, params, columns, copy, access };
}

/**
 * Take a full point-in-time snapshot of everything mutable. Called BEFORE
 * every mutating action. Never throws for 'edit'/'autosave' saves (a snapshot
 * failure must not block a bonus edit); rethrows for explicit admin actions
 * so the action aborts rather than running unprotected.
 */
export async function takeSnapshot(actor: string, reason: string): Promise<void> {
  try {
    const [state, recent] = await Promise.all([captureState(), loadSnapshots(1)]);
    const now = new Date().toISOString();
    if (shouldCoalesce(recent[0], actor, reason, new Date(now))) return;

    await pushSnapshot({ ts: now, actor, reason, state });
  } catch (err) {
    if (reason === "edit" || reason === "autosave") {
      console.error("[snapshots] failed to snapshot before edit (continuing):", err);
      return;
    }
    throw err;
  }
}

/**
 * Put a captured state back, whatever it was captured into.
 *
 * Shared by restoring a stored snapshot and restoring an uploaded backup
 * file, because every careful thing below applies equally to both and is
 * silent when it goes wrong. `source` names where the state came from, for
 * the history entry and the audit line — the only thing the two callers
 * differ on.
 *
 * Does NOT take the pre-restore snapshot: that is the caller's job, because
 * only the caller knows whether it has already validated what it is about to
 * apply. Does NOT touch the history log either — an audit trail a restore can
 * overwrite is not an audit trail, so the entry appended here is the record
 * that a restore happened rather than a replacement for what came before.
 */
export async function applyState(
  state: Snapshot["state"],
  actor: string,
  source: string
): Promise<void> {
  await saveStoredDataset(state.dataset);
  // Force-write bumps the version so open editors 409 and reload.
  await saveOverridesForce(state.overrides);

  // Restore means EVERYTHING goes back — including the documents that did
  // not exist yet when the snapshot was taken. A snapshot holding null (or
  // nothing) for one of these recorded "no stored doc", so the doc is
  // cleared back to its defaults rather than silently left at today's
  // values. That used to keep today's caps and company modifier across an
  // old restore, which is a wrong set of figures wearing a restored label.
  const cols = ColumnConfigSchema.safeParse(state.columns);
  if (cols.success) await saveColumnConfig(cols.data);
  else await clearColumnConfig();
  const params = ParamsSchema.safeParse(state.params);
  if (params.success) await saveParams(params.data);
  else await clearParams();
  const copy = CopySchema.safeParse(state.copy);
  if (copy.success) await saveCopy(copy.data);
  else await clearCopy();

  // Access rules. Older snapshots carry no `access` at all — for those,
  // access is left alone (there is nothing recorded to restore to), which is
  // exactly the old behaviour. When the state does carry the overlay, it
  // is restored with one guard: the restoring admin keeps the access they
  // hold RIGHT NOW, whatever it says. A restore must never be able
  // to lock out the person performing it, or hand them a different grant as
  // a side effect of their own click. That matters more for an uploaded file
  // than it ever did for a stored snapshot: the file's overlay is whatever
  // someone put in it.
  if (state.access !== undefined && state.access !== null) {
    const AccessOverlay = z.record(z.string(), AccessRuleSchema);
    const parsed = AccessOverlay.safeParse(state.access);
    if (parsed.success) {
      const restored = { ...parsed.data };
      const current = await loadAccessOverlay();
      if (current[actor]) restored[actor] = current[actor];
      else delete restored[actor];
      await saveAccessOverlay(restored);
    } else {
      console.error(
        `[snapshots] ${source} carries an unreadable access overlay; access left as is`
      );
    }
  }

  await appendHistory([
    {
      ts: new Date().toISOString(),
      actor,
      kind: "restore",
      summary: `Restored ${source}`,
    },
  ]);
  console.log(
    `[audit] restore by=${actor} source="${source}" ts=${new Date().toISOString()}`
  );
}

/**
 * Restore a snapshot by timestamp. Takes a 'pre-restore' snapshot first so
 * the restore itself can be undone.
 */
export async function restoreSnapshot(ts: string, actor: string): Promise<void> {
  const target = await loadSnapshotByTs(ts);
  if (!target) throw new Error("Snapshot not found");

  await takeSnapshot(actor, "pre-restore");
  await applyState(
    target.state,
    actor,
    `snapshot from ${new Date(target.ts).toLocaleString("en-AU")} (taken by ${target.actor}, reason: ${target.reason})`
  );
}
