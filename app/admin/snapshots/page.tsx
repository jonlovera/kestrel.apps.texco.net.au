import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveViewer } from "@/lib/view-as";
import {
  loadSnapshots,
  loadOverrides,
  loadColumnConfig,
  loadCopy,
  loadParams,
  loadAccessOverlay,
} from "@/lib/store";
import { getDataset } from "@/lib/data";
import { restoreSnapshot } from "@/lib/snapshots";
import { diffSnapshotStates, type SnapshotDiffSummary } from "@/lib/snapshot-diff";
import type { Overrides, Snapshot } from "@/lib/schema";
import SnapshotList from "@/components/SnapshotList";

export const metadata = { title: "Texco" };
export const dynamic = "force-dynamic";

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

export default async function SnapshotsPage() {
  const email = await requireAdminPage();

  // The live state, assembled the same way takeSnapshot assembles a snapshot
  // (getDataset, not getEffectiveDataset — snapshots store the source data,
  // params are a separate part), so the newest row diffs like-for-like.
  const [snapshots, dataset, overrides, columns, copy, params, access] =
    await Promise.all([
      loadSnapshots(),
      getDataset(),
      loadOverrides(),
      loadColumnConfig(),
      loadCopy(),
      loadParams(),
      loadAccessOverlay(),
    ]);
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
  // state — the live state for the newest row.
  const changesFor = (i: number): SnapshotDiffSummary => {
    try {
      return diffSnapshotStates(
        snapshots[i].state,
        i === 0 ? currentState : snapshots[i - 1].state
      );
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
      restoreAction={restoreAction}
    />
  );
}
