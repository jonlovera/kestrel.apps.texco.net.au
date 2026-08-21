import { NextResponse } from "next/server";
import { resolveViewer } from "@/lib/view-as";
import { getEffectiveDataset, getParams } from "@/lib/data";
import { loadOverrides, loadColumnConfig, loadCopy } from "@/lib/store";
import { buildPayloadCore } from "@/lib/scope-core";
import { sanitiseOverrideWrite } from "@/lib/write-scope";
import { OverridesSchema, type Overrides } from "@/lib/schema";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * What-if, without handing over the pool.
 *
 * A lead changing one IPM re-scales everyone in that state, so they have to
 * see the effect before saving — that interactive loop is the point of the
 * tool. But recalculating in their browser would mean shipping them the whole
 * dataset and both caps, and a lead is not entitled to the group pool.
 *
 * So the engine runs here instead: scratch overrides in, the same
 * scope-stripped rows they already receive out. Nothing is persisted, nothing
 * is snapshotted, and nothing is published — this is a calculator, not a save.
 *
 * Admins don't need it (they hold the dataset already and compute locally),
 * but they're allowed through so there is one code path to reason about.
 */
export async function POST(req: Request) {
  // Through the view-as layer, so an admin checking a lead's view sees that
  // lead's what-if rather than an editor payload with no rows in it.
  const { actor, scope } = await resolveViewer();
  if (!actor || !scope) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const email = actor;

  let incoming: Overrides;
  try {
    incoming = z
      .object({ overrides: OverridesSchema })
      .parse(await req.json()).overrides;
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const [data, params, stored, columnConfig, copy] = await Promise.all([
    getEffectiveDataset(),
    getParams(),
    loadOverrides(),
    loadColumnConfig(),
    loadCopy(),
  ]);

  // The same gate the real save uses. A preview that honoured edits the save
  // would refuse would be worse than no preview at all — it would show figures
  // that can never be committed.
  const { overrides } = sanitiseOverrideWrite(scope, data.emp, incoming, stored);

  const payload = buildPayloadCore(
    data,
    overrides,
    scope,
    { name: "", email, scopeLabel: scope.label },
    { columnConfig, copy, companyModifier: params.companyModifier }
  );

  // Only the recalculated figures go back. Sending the whole payload again
  // would be harmless but wasteful, and this runs on every keystroke burst.
  const res = NextResponse.json(
    payload.mode === "readonly"
      ? { rows: payload.rows, poolCards: payload.poolCards }
      : { rows: [], poolCards: [] }
  );
  res.headers.set("Cache-Control", "no-store, max-age=0");
  return res;
}
