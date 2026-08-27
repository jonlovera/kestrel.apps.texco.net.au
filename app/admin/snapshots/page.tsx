import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveViewer } from "@/lib/view-as";
import {
  loadSnapshotPage,
  loadOverrides,
  loadColumnConfig,
  loadCopy,
  loadParams,
  loadAccessOverlay,
} from "@/lib/store";
import { getDataset } from "@/lib/data";
import { restoreSnapshot, takeSnapshot, applyState } from "@/lib/snapshots";
import { BackupSchema, describeBackupProblem } from "@/lib/backup";
import { snapshotPageWindow } from "@/lib/snapshots-core";
import { diffSnapshotStates, type SnapshotDiffSummary } from "@/lib/snapshot-diff";
import type { Overrides, Snapshot } from "@/lib/schema";
import SnapshotList from "@/components/SnapshotList";

export const metadata = { title: "Texco" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

/**
 * Rows whose override entry actually does something, split into manual edits
 * and locks so the bulk (the lock an import writes for every locked workbook
 * row) is visibly not per-save editing activity. The document keeps an entry
 * for every row ever touched — unlocking leaves `{locked: false}` behind —
 * so a raw key count reads as if one save edited half the company; those
 * leftovers count in neither number. A row can hold both an edit and a lock
 * and then counts in both.
 */
function countOverrides(overrides: Overrides): { edited: number; locked: number } {
  let edited = 0;
  let locked = 0;
  for (const o of Object.values(overrides)) {
    if (o.bpEdit !== undefined || o.ipmEdit !== undefined || o.daEdit !== undefined)
      edited++;
    if (o.locked === true) locked++;
  }
  return { edited, locked };
}

async function requireAdminPage() {
  const { actor, scope } = await resolveViewer();
  if (!actor) redirect("/login");
  if (!scope) redirect("/no-access");
  if (!scope.canEdit) redirect("/");
  return actor;
}

export default async function SnapshotsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const email = await requireAdminPage();

  const { page: rawPage } = await searchParams;
  const requested = Math.max(1, Math.floor(Number(rawPage) || 1));
  const window = snapshotPageWindow(requested, PAGE_SIZE);

  // The live state, assembled the same way takeSnapshot assembles a snapshot
  // (getDataset, not getEffectiveDataset — snapshots store the source data,
  // params are a separate part), so the newest row diffs like-for-like.
  const [pageData, dataset, overrides, columns, copy, params, access] =
    await Promise.all([
      loadSnapshotPage(window.offset, window.limit),
      getDataset(),
      loadOverrides(),
      loadColumnConfig(),
      loadCopy(),
      loadParams(),
      loadAccessOverlay(),
    ]);
  const { total } = pageData;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (requested > pageCount) {
    redirect(pageCount === 1 ? "/admin/snapshots" : `/admin/snapshots?page=${pageCount}`);
  }
  const page = requested;

  // When not on page 1, the first fetched row is only the diff partner for
  // the page's first visible row (see snapshotPageWindow); it is not shown.
  const snapshots = window.leadingPartner
    ? pageData.snapshots.slice(1)
    : pageData.snapshots;
  const partner = window.leadingPartner ? pageData.snapshots[0] : undefined;

  const currentState: Snapshot["state"] = {
    dataset,
    overrides,
    params,
    columns,
    copy,
    access,
  };

  // Snapshots are PRE-mutation and listed newest-first, so what row i's
  // actor/reason changed is the difference between row i and the next-newer
  // state — the live state for the newest row of page 1, the carried-along
  // partner row for the first row of any later page.
  const changesFor = (i: number): SnapshotDiffSummary => {
    try {
      const newer =
        i > 0
          ? snapshots[i - 1].state
          : (partner?.state ?? currentState);
      return diffSnapshotStates(snapshots[i].state, newer);
    } catch (err) {
      // One malformed old snapshot must not cost the whole page.
      console.error(`[snapshots] diff failed for ${snapshots[i].ts}:`, err);
      return { headline: "Couldn't summarise this change", lines: [], more: 0 };
    }
  };

  async function restoreAction(formData: FormData) {
    "use server";
    // authorise independently — server actions don't inherit page checks
    const actor = await requireAdminPage();
    const ts = String(formData.get("ts") ?? "");
    await restoreSnapshot(ts, actor);
    revalidatePath("/");
    revalidatePath("/admin/snapshots");
  }

  /**
   * Take a snapshot on demand.
   *
   * Snapshots are otherwise a side effect of changing something, so there was
   * no way to mark a restore point BEFORE doing something risky. `reason` is a
   * free string on SnapshotSchema and shouldCoalesce only ever coalesces
   * `autosave`, so "manual" always lands even when nothing has changed since
   * the last one — which is the case this exists for.
   *
   * No history entry: the snapshot appears in the list below with this actor
   * and reason, and that IS the record.
   */
  async function snapshotAction() {
    "use server";
    const actor = await requireAdminPage();
    await takeSnapshot(actor, "manual");
    revalidatePath("/admin/snapshots");
  }

  /**
   * Restore everything from an uploaded backup file.
   *
   * The most dangerous control in the app: it rewrites every figure and every
   * access rule from a file the server has no way to authenticate. Three
   * things stand between a misclick and that —
   *
   *  1. the typed confirmation the form requires before it will submit;
   *  2. full validation BEFORE anything is written, so a bad file changes
   *     nothing rather than half-changing everything;
   *  3. a pre-restore snapshot, so this is as undoable as any other restore.
   *
   * applyState carries the guard that matters most: whatever the file says
   * about access, the admin running it keeps the access they hold right now.
   * A backup whose overlay omits them cannot lock them out of their own app.
   */
  async function restoreBackupAction(formData: FormData) {
    "use server";
    const actor = await requireAdminPage();

    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return { error: "Choose a backup file first." };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      return { error: "That file isn't valid JSON. Nothing has been changed." };
    }

    const parsed = BackupSchema.safeParse(raw);
    if (!parsed.success) {
      return { error: describeBackupProblem(raw) };
    }

    await takeSnapshot(actor, "pre-restore");
    await applyState(
      parsed.data.state,
      actor,
      `backup file taken ${new Date(parsed.data.takenAt).toLocaleString("en-AU")} by ${parsed.data.takenBy}`
    );
    revalidatePath("/");
    revalidatePath("/admin/snapshots");
    return { ok: true as const };
  }

  console.log(
    `[audit] pageview page=admin/snapshots email=${email} ts=${new Date().toISOString()}`
  );

  return (
    <SnapshotList
      snapshots={snapshots.map((s, i) => ({
        ts: s.ts,
        actor: s.actor,
        reason: s.reason,
        employees: s.state.dataset.emp.length,
        ...countOverrides(s.state.overrides),
        changes: changesFor(i),
      }))}
      page={page}
      pageCount={pageCount}
      total={total}
      restoreAction={restoreAction}
      snapshotAction={snapshotAction}
      restoreBackupAction={restoreBackupAction}
    />
  );
}
