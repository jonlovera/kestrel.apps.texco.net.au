import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDataset, getParams } from "@/lib/data";
import { requireWriter, noStore } from "@/lib/api-guard";
import { saveStoredDatasetCas, appendHistory, loadOverrides, seedOverrideBases } from "@/lib/store";
import { takeSnapshot } from "@/lib/snapshots";
import { applyDatasetPatch, DatasetPatchSchema } from "@/lib/dataset-edit";
import { applyParams } from "@/lib/params-apply";
import { applyOverrides, computeScalesAndBonuses } from "@/lib/calc";

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
    // Hand back the current roster too, so the client can adopt the latest
    // figures in place instead of force-reloading the page (which used to
    // throw away the user's unsaved override scratch as collateral).
    const latest = applyParams(data, params);
    return noStore(
      NextResponse.json(
        {
          error: "Version conflict, someone else changed the data",
          current: cas.current,
          employees: latest.emp,
          cats: data.cats,
          depts: data.depts,
          mgrs: data.mgrs,
        },
        { status: 409 }
      )
    );
  }
  // A payout is a STORED figure (lib/schema.ts), so a person who has just been
  // added needs one written before anything reads them — otherwise they fall
  // back to the advisory calculation, which is the last derivation left in the
  // model. The figure stored is the one they were going to be paid anyway
  // (their entitlement at the prevailing scale), so nobody's money moves; it is
  // recorded rather than re-derived on every read. No version bump, so open
  // editors keep their unsaved work — see seedOverrideBases.
  if (patch.op === "add") {
    try {
      const effectiveNow = applyParams(result.dataset, params);
      const stored = await loadOverrides();
      const priced = applyOverrides(effectiveNow.emp, stored);
      computeScalesAndBonuses(priced, effectiveNow);
      const added = priced.find((e) => e.id === patch.employee.id);
      if (added) {
        await seedOverrideBases({ [added.id]: added.calcBonus });
      }
    } catch (err) {
      // The roster save already succeeded and is the point of the request. An
      // unpriced row still reads correctly through the fallback, so this is
      // worth a loud log and not a failed response.
      console.error("[dataset-write] failed to store a base for the new row:", err);
    }
  }

  await appendHistory(result.history);

  console.log(
    `[audit] dataset-write email=${email} emp=${"id" in body.patch ? body.patch.id : body.patch.employee.id} op=${body.patch.op} version=${cas.version} ts=${new Date().toISOString()}`
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
  if (companyModifier === 1 || companyModifier <= 0) return patch;
  // A new person's After IPM arrives as a displayed figure too — storing it
  // unscaled would silently skew their derived company modifier.
  if (patch.op === "add") {
    return {
      ...patch,
      employee: { ...patch.employee, bipm: patch.employee.bipm / companyModifier },
    };
  }
  if (patch.op !== "field" || patch.field !== "bipm") return patch;
  return { ...patch, value: patch.value / companyModifier };
}

