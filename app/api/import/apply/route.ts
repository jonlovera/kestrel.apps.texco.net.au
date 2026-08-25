import { NextResponse } from "next/server";
import { adjustAllowance } from "@/lib/write-scope";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireWriter } from "@/lib/api-guard";
import { getDataset } from "@/lib/data";
import { applyParams, defaultParams } from "@/lib/params-apply";
import { applyOverrides, computeScalesAndBonuses } from "@/lib/calc";
import {
  loadOverrides,
  saveStoredDataset,
  saveOverridesForce,
  loadParams,
  saveParams,
  appendHistory,
} from "@/lib/store";
import { takeSnapshot } from "@/lib/snapshots";
import { EmployeeSchema, type Overrides } from "@/lib/schema";
import {
  buildImportPreview,
  candidateDataset,
  filterImportedLocks,
  seedImportedBases,
} from "@/lib/import-parse";
import { fmt } from "@/lib/fmt";

export const dynamic = "force-dynamic";

const ApplySchema = z.object({
  rows: z.array(EmployeeSchema).min(1).max(10_000),
  confirmRemovals: z.boolean().optional(),
  totalAfter: z.number(), // echoed from the preview, for the history entry
  // The sheet's "Locked Amount" column, echoed back from the preview the
  // same way `rows` is — re-filtered against the candidate roster below
  // rather than trusted, the same defence-in-depth reasoning as re-deriving
  // `candidate` itself.
  lockedAmounts: z.record(z.string(), z.number()).default({}),
  // Pool caps read from the model workbook, echoed back from the preview the
  // same way lockedAmounts is (the apply route never re-parses the original
  // file — only the already-parsed rows are available here).
  caps: z
    .object({ vCap: z.number().positive(), nCap: z.number().positive(), gCap: z.number().positive() })
    .optional(),
});

/**
 * Commit a previously-previewed import: snapshot first, replace the source
 * dataset, prune overrides of removed employees. Never partial — all
 * validation re-runs here.
 */
export async function POST(req: Request) {
  const guard = await requireWriter("import-apply");
  if ("response" in guard) return guard.response;
  const { email, scope } = guard;

  let body: z.infer<typeof ApplySchema>;
  try {
    body = ApplySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }
  const ids = new Set(body.rows.map((r) => r.id));
  if (ids.size !== body.rows.length) {
    return NextResponse.json({ error: "Duplicate employee ids" }, { status: 400 });
  }

  const [current, overrides] = await Promise.all([getDataset(), loadOverrides()]);
  // Re-derived here rather than trusted from the client: the preview already
  // sends back the filtered rows, but re-filtering means a permanently
  // excluded person can never end up saved regardless of what the request
  // actually contains — the same reasoning as re-validating everything else
  // on this route rather than trusting what was previewed.
  const candidate = candidateDataset(current, body.rows, body.caps);
  const preview = buildImportPreview(current.emp, candidate.emp, overrides);
  if (preview.removedWithData.length > 0 && !body.confirmRemovals) {
    return NextResponse.json(
      {
        error:
          "This import removes employees who have entered data — confirm the removals to proceed",
        removedWithData: preview.removedWithData,
      },
      { status: 409 }
    );
  }

  await takeSnapshot(email, "import");
  await saveStoredDataset(candidate);
  const survivingIds = new Set(candidate.emp.map((e) => e.id));
  let survivingOverrides: Overrides = Object.fromEntries(
    Object.entries(overrides).filter(([id]) => survivingIds.has(id))
  );

  // The sheet's "Locked Amount" column becomes a lock override, the same
  // mechanism the dashboard's own Lock button writes to — overwriting
  // whatever lock state that id already had, since the spreadsheet is
  // authoritative for this figure the same way it is for every other
  // imported one. Site-manager and out-of-pool rows are skipped: they can't
  // be locked (the rule /api/state enforces on every save), so a lock written
  // here would be invisible in the UI and stripped, then reported as
  // "Unlocked" in history, by the next ordinary save.
  //
  // The amount lands in `baseAmount`, not the retired `lockedFinal`: it is a
  // payout the spreadsheet is stating, and a payout is `baseAmount + daEdit`
  // (lib/schema.ts). Backing the row's own discretionary amount out of it keeps
  // the total exactly what the sheet says. The lock itself is now just the
  // boolean — it carries no figure.
  // The importer's own allowance decides whether a sheet lock on a VIC site
  // manager is honoured — the same grant /api/state applies to a typed one.
  const importedLocks = filterImportedLocks(
    candidate.emp,
    body.lockedAmounts,
    adjustAllowance(scope)
  );
  const skippedLocks = Object.keys(body.lockedAmounts).filter(
    (id) => survivingIds.has(id) && !importedLocks.some(([kept]) => kept === id)
  ).length;
  const lockedAmountById = new Map(importedLocks);
  for (const [id] of importedLocks) {
    survivingOverrides[id] = { ...survivingOverrides[id], locked: true };
  }

  // Every row leaves an import with a stored payout. An existing row keeps the
  // one it had — a new roster moves the advisory calculation, never a settled
  // payout, which is the whole point of storing it (recalculation happens when
  // somebody presses Redistribute, never as a side effect of importing). A row
  // the sheet locked takes the sheet's figure, and a row new to the roster takes
  // its entitlement at the prevailing scale.
  {
    // Price against the caps that will actually be in force once this import
    // finishes, not the ones on the way out. A saved params doc shadows the
    // dataset's caps, and the block below updates it from the sheet — so when
    // the sheet carries caps, those are the effective ones, and reading the
    // stored doc here would price a new row against caps about to be replaced.
    const storedParams = (await loadParams()) ?? defaultParams(candidate);
    const effectiveParams = body.caps
      ? {
          ...storedParams,
          vCap: candidate.vCap,
          nCap: candidate.nCap,
          gCap: candidate.gCap,
        }
      : storedParams;
    const effective = applyParams(candidate, effectiveParams);
    const priced = applyOverrides(effective.emp, survivingOverrides);
    computeScalesAndBonuses(priced, effective);
    survivingOverrides = seedImportedBases(priced, survivingOverrides, lockedAmountById);
  }

  // Force-write bumps the version so open editors reload cleanly.
  await saveOverridesForce(survivingOverrides);

  // A saved params doc shadows the dataset's caps (applyParams overwrites
  // them on every read), so an import that carries caps from the model
  // workbook must update that doc too — otherwise the effective caps
  // silently stay whatever the Parameters screen last said, while the
  // history entry below claims they changed.
  if (body.caps) {
    const params = await loadParams();
    if (
      params &&
      (params.vCap !== candidate.vCap ||
        params.nCap !== candidate.nCap ||
        params.gCap !== candidate.gCap)
    ) {
      await saveParams({
        ...params,
        vCap: candidate.vCap,
        nCap: candidate.nCap,
        gCap: candidate.gCap,
      });
    }
  }

  const capsChanged =
    body.caps &&
    (body.caps.vCap !== current.vCap || body.caps.nCap !== current.nCap || body.caps.gCap !== current.gCap);
  const capsNote = capsChanged
    ? ` — pool caps changed to VIC ${fmt(candidate.vCap)} / NSW ${fmt(candidate.nCap)} / Group ${fmt(candidate.gCap)}`
    : "";

  await appendHistory([
    {
      ts: new Date().toISOString(),
      actor: email,
      kind: "import",
      summary: `Imported ${candidate.emp.length} employees (${preview.added.length} added, ${preview.removed.length} removed, ${importedLocks.length} locked${skippedLocks > 0 ? `, ${skippedLocks} sheet lock${skippedLocks === 1 ? "" : "s"} ignored for unlockable rows` : ""}) — total pool now ${fmt(body.totalAfter)}${capsNote}`,
    },
  ]);
  console.log(
    `[audit] import-apply email=${email} rows=${candidate.emp.length} added=${preview.added.length} removed=${preview.removed.length} locked=${importedLocks.length} locksSkipped=${skippedLocks} capsChanged=${!!capsChanged} ts=${new Date().toISOString()}`
  );
  revalidatePath("/");

  const res = NextResponse.json({ ok: true });
  res.headers.set("Cache-Control", "no-store, max-age=0");
  return res;
}
