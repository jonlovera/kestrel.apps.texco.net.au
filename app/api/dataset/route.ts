import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "@/auth";
import { scopeForUser } from "@/lib/access";
import { getDataset, getParams } from "@/lib/data";
import {
  loadOverrides,
  saveStoredDatasetCas,
  saveOverridesForce,
  appendHistory,
} from "@/lib/store";
import { takeSnapshot } from "@/lib/snapshots";
import { applyDatasetPatch, DatasetPatchSchema } from "@/lib/dataset-edit";
import { applyParams } from "@/lib/params-apply";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  version: z.number().int().min(0),
  patch: DatasetPatchSchema,
});

/**
 * Inline edits to the source dataset: a figure, the pool split, or adding /
 * removing a person. Full-access users only.
 *
 * One patch per request — unlike /api/state (debounced autosave of the whole
 * overrides doc), these are deliberate, infrequent changes, so each gets its
 * own snapshot point, history entry and version bump.
 *
 * The client works in DISPLAYED figures: the dashboard's employees come from
 * getEffectiveDataset(), whose bipm has already been scaled by the company
 * modifier. Any bipm arriving here is therefore divided back out before it is
 * stored, so what lands in the dataset is always the source figure. (Identity
 * while the modifier is 1, which is today's default.)
 */
export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email;
  const scope = await scopeForUser(email);

  if (!email || !scope) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!scope.canEdit) {
    console.log(
      `[audit] DENIED dataset-write email=${email} scope=${scope.rule.type} ts=${new Date().toISOString()}`
    );
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const [data, params, overrides] = await Promise.all([
    getDataset(),
    getParams(),
    loadOverrides(),
  ]);

  const patch = unscale(body.patch, params.companyModifier);
  const result = applyDatasetPatch(
    data,
    patch,
    overrides,
    email,
    new Date().toISOString()
  );
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
  // Force-write bumps the overrides version too, so other open editors 409
  // and reload rather than resurrecting a removed person's figures. This
  // client gets the new version back so its own next save isn't a false 409.
  const overridesVersion = result.overridesChanged
    ? await saveOverridesForce(result.overrides)
    : undefined;
  await appendHistory(result.history);

  console.log(
    `[audit] dataset-write email=${email} op=${body.patch.op} version=${cas.version} ts=${new Date().toISOString()}`
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
      overrides: result.overridesChanged ? result.overrides : undefined,
      overridesVersion,
    })
  );
}

/** Convert displayed figures back to stored ones (see the note above). */
function unscale(
  patch: z.infer<typeof DatasetPatchSchema>,
  companyModifier: number
): z.infer<typeof DatasetPatchSchema> {
  if (companyModifier === 1 || companyModifier <= 0) return patch;
  if (patch.op === "field" && patch.field === "bipm") {
    return { ...patch, value: patch.value / companyModifier };
  }
  if (patch.op === "add") {
    return {
      ...patch,
      employee: {
        ...patch.employee,
        bipm: patch.employee.bipm / companyModifier,
      },
    };
  }
  // A pkg edit scales bipm by a RATIO, which the modifier cancels out of.
  return patch;
}

function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store, max-age=0");
  return res;
}
