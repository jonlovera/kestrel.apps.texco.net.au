import { z } from "zod";
import { DatasetSchema, OverridesSchema, HistoryEntrySchema } from "./schema";
import type { Snapshot } from "./schema";

/**
 * The shape of a downloadable backup file.
 *
 * Pure schema and naming — no I/O, no server-only imports — so the suite can
 * hold the download and the restore to the same contract without a database.
 * That round trip is the thing worth testing here: the two halves are written
 * months apart in practice, and a backup that cannot be restored is worse than
 * no backup, because nobody finds out until they need it.
 *
 * WHAT IS IN IT, and what deliberately is not:
 *
 *  - `state` is exactly a snapshot's state (lib/snapshots.ts's captureState),
 *    so restoring a file and restoring a snapshot are the same operation.
 *  - `history` rides along for the record and is NEVER restored. Losing the
 *    database currently loses the audit log outright, which is the scenario
 *    this file exists for — but an audit trail that a restore can overwrite
 *    from an uploaded file is not an audit trail. Restoring appends its own
 *    entry instead, so the trail stays continuous.
 *  - Pageviews and anon-visits are in neither. They are capped telemetry, not
 *    state, and snapshots have always excluded them.
 *
 * IT IS NOT ENCRYPTED. It holds every salary in the company and the access
 * overlay that says who may see them, so it wants handling like the source
 * spreadsheet rather than like a download. Encrypting it would need a key the
 * app has nowhere to keep; saying so plainly is the honest alternative.
 */

/**
 * Bumped only when the shape changes in a way an older reader would get wrong.
 * The version is checked before anything is applied, so a file from a future
 * format is refused whole rather than half-restored — which is the failure
 * mode that would leave the scheme in a state nobody can name.
 */
export const BACKUP_VERSION = 1;

/**
 * The state block, matching Snapshot["state"] field for field.
 *
 * `params`/`columns`/`copy`/`access` stay `unknown` here exactly as they do on
 * SnapshotSchema: each is re-parsed against its own schema at restore time
 * (lib/snapshots.ts's applyState), and a document that fails there is cleared
 * to its defaults rather than rejected. Tightening it here would refuse a
 * whole backup over one stale sub-document.
 */
const StateSchema = z.object({
  dataset: DatasetSchema,
  overrides: OverridesSchema,
  overridesVersion: z.number().int().optional(),
  params: z.unknown().nullable(),
  columns: z.unknown().nullable(),
  copy: z.unknown().nullable().optional(),
  access: z.unknown().nullable().optional(),
});

export const BackupSchema = z.object({
  kestrelBackup: z.literal(BACKUP_VERSION),
  takenAt: z.string(),
  takenBy: z.string(),
  state: StateSchema,
  /** the audit log at the time of download; read-only, never restored */
  history: z.array(HistoryEntrySchema).optional(),
});

export type Backup = z.infer<typeof BackupSchema>;

/** "kestrel-backup-2026-08-26-1146.json" */
export function backupFilename(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return [
    "kestrel-backup-",
    at.getFullYear(),
    "-",
    p(at.getMonth() + 1),
    "-",
    p(at.getDate()),
    "-",
    p(at.getHours()),
    p(at.getMinutes()),
    ".json",
  ].join("");
}

/**
 * Turn a parse failure into something an admin can act on.
 *
 * The version mismatch is called out separately because it is the one failure
 * with an obvious cause and no obvious symptom — "invalid backup file" would
 * send someone hunting for corruption when the file is simply newer than the
 * code reading it.
 */
export function describeBackupProblem(raw: unknown): string {
  const version =
    raw && typeof raw === "object" && "kestrelBackup" in raw
      ? (raw as { kestrelBackup: unknown }).kestrelBackup
      : undefined;
  if (version === undefined) {
    return "That doesn't look like a Kestrel backup file — it has no kestrelBackup version.";
  }
  if (version !== BACKUP_VERSION) {
    return `That backup is format ${String(version)} and this app reads format ${BACKUP_VERSION}. Nothing has been changed.`;
  }
  return "That backup file couldn't be read — its contents are not in the expected shape. Nothing has been changed.";
}

/** Assemble the file's contents around a captured state. */
export function buildBackup(
  state: Snapshot["state"],
  takenBy: string,
  history: Backup["history"],
  at: Date
): Backup {
  return {
    kestrelBackup: BACKUP_VERSION,
    takenAt: at.toISOString(),
    takenBy,
    state,
    history,
  };
}
