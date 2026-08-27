import { NextResponse } from "next/server";
import { getEffectiveDataset, getParams } from "@/lib/data";
import { requireWriter, noStore } from "@/lib/api-guard";
import {
  loadOverrides,
  loadOverridesVersion,
  saveOverridesCas,
  saveParams,
  appendHistory,
} from "@/lib/store";
import { takeSnapshot } from "@/lib/snapshots";
import { canRecalculatePool } from "@/lib/write-scope";
import { applyOverrides, computeScalesAndBonuses } from "@/lib/calc";
import {
  carveFundedMoved,
  recalcChanges,
  recalculatePool,
} from "@/lib/recalculate";
import type { Overrides } from "@/lib/schema";
import { fmt } from "@/lib/fmt";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * RECALCULATE THE POOL — the only operation that changes the Scale Factor.
 *
 * The invariant the whole feature exists to create:
 *
 *   Editing an IPM does not change the Scale Factor.
 *   Pressing Recalculate can change the Scale Factor.
 *
 * So this route does two writes, and they belong together in one press:
 *  1. the derived Scale Factors, onto the params document — from then on the
 *     engine READS that figure instead of deriving one (lib/calc.ts's Caps),
 *     which is what makes every later IPM edit a single-row event;
 *  2. a new `baseAmount` for every eligible row, all at once.
 *
 * `preview: true` runs exactly the same computation and writes nothing, so the
 * confirmation dialog can never describe an outcome different from the one
 * Confirm performs. It is deliberately the same code path rather than a
 * cheaper estimate.
 *
 * Its own permission (`canRecalculatePool`), NOT implied by full access — see
 * lib/access-rules.ts. Enforced here regardless of what the client believes.
 *
 * What it deliberately does not touch: discretionary amounts (they sit on top
 * of the pool and are nobody else's business), locked rows, issued rows, and
 * the caps.
 */
export async function POST(req: Request) {
  const guard = await requireWriter("recalculate-pool");
  if ("response" in guard) return guard.response;
  const { email, scope } = guard;

  if (!canRecalculatePool(scope)) {
    console.log(
      `[audit] recalculate DENIED email=${email} reason=not-granted ts=${new Date().toISOString()}`
    );
    return noStore(
      NextResponse.json(
        { error: "You don't have permission to recalculate the pool." },
        { status: 403 }
      )
    );
  }

  let preview: boolean;
  let clientVersion: number | undefined;
  try {
    const body = z
      .object({
        preview: z.boolean().optional().default(true),
        /**
         * The overrides version the client holds. Required to commit, so a
         * Recalculate racing somebody else's save is refused rather than
         * silently overwriting it — the same contract /api/state has.
         */
        version: z.number().int().min(0).optional(),
      })
      .parse(await req.json().catch(() => ({})));
    preview = body.preview;
    clientVersion = body.version;
  } catch {
    return noStore(
      NextResponse.json({ error: "Invalid payload" }, { status: 400 })
    );
  }

  const [data, params, previous] = await Promise.all([
    getEffectiveDataset(),
    getParams(),
    loadOverrides(),
  ]);

  // Price the population as it stands. recalculatePool needs finalBonus and
  // calcBonus resolved, because a fixed row's deduction is its stored base and
  // the last fallback for that is the advisory figure.
  const emps = applyOverrides(data.emp, previous);
  const before = computeScalesAndBonuses(emps, data);
  const result = recalculatePool(emps, data);
  const changes = recalcChanges(emps, result);

  const summary = {
    scaleFrom: { vic: before.vicScale, nsw: before.nswScale },
    scaleTo: { vic: result.vic.scale, nsw: result.nsw.scale },
    /** true when no scale has ever been stored — the first press */
    firstRun: params.vicScale === undefined && params.nswScale === undefined,
    vic: result.vic,
    nsw: result.nsw,
    eligible: result.moved,
    moving: changes.length,
    carveFunded: carveFundedMoved(emps, result),
    totalBefore: emps.reduce((s, e) => s + e.finalBonus, 0),
    totalAfter: emps.reduce(
      (s, e) => s + (result.bases.get(e.id) ?? e.finalBonus - e.daEdit) + e.daEdit,
      0
    ),
    changes: changes.slice(0, 200),
    truncated: Math.max(0, changes.length - 200),
  };

  if (preview) {
    return noStore(NextResponse.json({ ok: true, preview: true, ...summary }));
  }

  if (clientVersion === undefined) {
    return noStore(
      NextResponse.json(
        { error: "Missing version — reload the dashboard and try again." },
        { status: 400 }
      )
    );
  }

  // Nothing to do is not a failure, but it must not leave a snapshot and a
  // history line claiming a change that did not happen.
  if (changes.length === 0 && summary.scaleTo.vic === summary.scaleFrom.vic) {
    return noStore(
      NextResponse.json({ ok: true, unchanged: true, ...summary })
    );
  }

  // Snapshot BEFORE either write. A Recalculate moves every eligible payout at
  // once, so the restore point is the whole of the undo story for it.
  await takeSnapshot(email, "recalculate");

  const next: Overrides = { ...previous };
  for (const [id, base] of result.bases) {
    next[id] = { ...next[id], baseAmount: base };
  }

  const cas = await saveOverridesCas(next, clientVersion);
  if (!cas.ok) {
    const current = await loadOverridesVersion();
    console.log(
      `[audit] recalculate CONFLICT email=${email} sent=${clientVersion} current=${current} ts=${new Date().toISOString()}`
    );
    return noStore(
      NextResponse.json(
        {
          error:
            "Someone else saved changes since you loaded. Reload and run the recalculation again.",
          current,
        },
        { status: 409 }
      )
    );
  }

  // The scale is written only AFTER the bases land. If the order were reversed
  // and the CAS then failed, the scheme would be left holding a scale that no
  // payout had been derived from — the exact inconsistency this feature is
  // meant to remove.
  await saveParams({
    ...params,
    vicScale: result.vic.scale,
    nswScale: result.nsw.scale,
  });

  const ts = new Date().toISOString();
  const pct = (n: number) => `${(n * 100).toFixed(4)}%`;
  await appendHistory([
    {
      ts,
      actor: email,
      kind: "params",
      summary:
        `Recalculated the pool: VIC scale ${pct(before.vicScale)} → ${pct(result.vic.scale)}` +
        `, NSW scale ${pct(before.nswScale)} → ${pct(result.nsw.scale)}` +
        `; re-based ${changes.length} ${changes.length === 1 ? "bonus" : "bonuses"}` +
        ` (${fmt(summary.totalBefore)} → ${fmt(summary.totalAfter)} total)` +
        `; VIC pool ${fmt(result.vic.available)} over potential ${fmt(result.vic.potential)}`,
      field: "vicScale",
      from: Number(before.vicScale.toFixed(8)),
      to: Number(result.vic.scale.toFixed(8)),
    },
  ]);

  console.log(
    `[audit] recalculate email=${email} vicScale=${result.vic.scale} nswScale=${result.nsw.scale} rebased=${changes.length} version=${cas.version} ts=${ts}`
  );

  return noStore(
    NextResponse.json({ ok: true, version: cas.version, ...summary })
  );
}
