import { NextResponse } from "next/server";
import { requireWriter, noStore } from "@/lib/api-guard";
import { captureState } from "@/lib/snapshots";
import { loadHistory } from "@/lib/store";
import { buildBackup, backupFilename } from "@/lib/backup";

export const dynamic = "force-dynamic";

/**
 * Download the whole scheme as a single file an admin can keep off-platform.
 *
 * The gap this closes: snapshots already hold everything mutable, but they
 * live in the same Neon database as the live data, so they are version history
 * rather than disaster recovery — lose the database and both go. The Excel
 * export beside this is the figures only; access rules, columns, copy and caps
 * are not in it, so the app cannot be rebuilt from one.
 *
 * requireWriter, NOT requireEditor — deliberately stricter than /api/export.
 * This file carries every salary AND the access overlay that decides who may
 * see them, so an admin part-way through a View As should not be able to pull
 * one: while viewing as someone else, the answer to "who is asking" is
 * genuinely ambiguous, and that is not a question to be ambiguous about here.
 */
export async function GET() {
  const guard = await requireWriter("backup");
  if ("response" in guard) return guard.response;
  const { email } = guard;

  const at = new Date();
  // The audit log rides along for the record but is never restored — see
  // lib/backup.ts. Capped at 2000 entries by the store, so this stays small.
  const [state, history] = await Promise.all([captureState(), loadHistory(2000)]);
  const backup = buildBackup(state, email, history, at);

  console.log(
    `[audit] backup by=${email} rows=${state.dataset.emp.length} history=${history.length} ts=${at.toISOString()}`
  );

  return noStore(
    new NextResponse(JSON.stringify(backup, null, 1), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${backupFilename(at)}"`,
      },
    })
  );
}
