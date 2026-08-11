import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDataset, getParams } from "@/lib/data";
import { requireWriter, noStore } from "@/lib/api-guard";
import { saveStoredDatasetCas, appendHistory } from "@/lib/store";
import { takeSnapshot } from "@/lib/snapshots";
import { applyDatasetPatch, DatasetPatchSchema } from "@/lib/dataset-edit";
import { applyParams } from "@/lib/params-apply";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  version: z.number().int().min(0),
  patch: DatasetPatchSchema,
});

/**
 * The remaining dataset edits: After IPM (which finance calls "Bonus"), and
 * the VIC/NSW split for Shared Services staff. Full-access users only — a
 * lead may set Discretionary for their own people, never this: none of these
 * are "your own row" changes, and the split specifically moves dollars
 * between pools a lead has no visibility of.
 *
 * One patch per request: these are deliberate, infrequent changes, so each
 * gets its own snapshot point, history entry and version bump.
 *
 * The client works in DISPLAYED figures: the dashboard's employees come from
 * getEffectiveDataset(), whose bipm has already been scaled by the company
 * modifier. Any bipm arriving here is therefore divided back out before it is
 * stored, so what lands in the dataset is always the source figure. (Identity
 * while the modifier is 1, which is today's default.) The split is never
 * scaled by the modifier in the first place — see unscale below.
 */
export async function POST(req: Request) {
  const guard = await requireWriter("dataset-write");
  if ("response" in guard) return guard.response;
  const { email } = guard;

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const [data, params] = await Promise.all([getDataset(), getParams()]);

  const patch = unscale(body.patch, params.companyModifier);
  const result = applyDatasetPatch(data, patch, email, new Date().toISOString());
  if (!result.ok) {
    return NextResponse.json(
      { error: result.errors[0], errors: result.errors },
      { status: 400 }
    );
  }

  // Snapshot before touching anything, then save with optimistic concurrency:
  // a stale version means someone else changed the roster since this client
  // loaded — 409, never silently clobber.
  await takeSnapshot(email, "dataset");
  const cas = await saveStoredDatasetCas(result.dataset, body.version);
  if (!cas.ok) {
    console.log(
      `[audit] dataset-write CONFLICT email=${email} sent=${body.version} current=${cas.current} ts=${new Date().toISOString()}`
    );
    return noStore(
      NextResponse.json(
        {
          error: "Version conflict — someone else changed the data",
          current: cas.current,
        },
        { status: 409 }
      )
    );
  }
  await appendHistory(result.history);

  console.log(
    `[audit] dataset-write email=${email} emp=${body.patch.id} version=${cas.version} ts=${new Date().toISOString()}`
  );
  revalidatePath("/");

  // Hand back the new roster so the dashboard recalculates in place.
  const effective = applyParams(result.dataset, params);
  return noStore(
    NextResponse.json({
      ok: true,
      version: cas.version,
      employees: effective.emp,
      cats: result.dataset.cats,
      depts: result.dataset.depts,
      mgrs: result.dataset.mgrs,
    })
  );
}

/**
 * Convert the displayed figure back to the stored one (see the note above).
 *
 * Only `bipm` is a dollar figure the company modifier scales. `vp`/`np` are a
 * 0–1 fraction and are never touched by it — dividing a split by the modifier
 * would corrupt it the moment the modifier isn't 1.
 */
function unscale(
  patch: z.infer<typeof DatasetPatchSchema>,
  companyModifier: number
): z.infer<typeof DatasetPatchSchema> {
  if (patch.field !== "bipm" || companyModifier === 1 || companyModifier <= 0) {
    return patch;
  }
  return { ...patch, value: patch.value / companyModifier };
}

