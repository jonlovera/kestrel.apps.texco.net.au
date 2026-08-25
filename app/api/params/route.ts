import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { saveParams, appendHistory } from "@/lib/store";
import { getParams } from "@/lib/data";
import { takeSnapshot } from "@/lib/snapshots";
import { ParamsSchema, canChangeCaps, capsWarning } from "@/lib/params-apply";
import { requireWriter, noStore } from "@/lib/api-guard";

export const dynamic = "force-dynamic";

/**
 * Save the company modifier, and — for the admins explicitly granted it —
 * the pool caps too. Both move every figure downstream, so the history
 * entry spells out exactly what changed.
 *
 * Caps used to be unconditionally uneditable here: any vCap/nCap/gCap in the
 * request were silently discarded and the stored values kept, regardless of
 * who was asking. That's now a real permission (`canEditCaps` on a
 * full-access rule, lib/access-rules.ts) rather than a blanket no. A caller
 * without it keeps the old graceful behaviour UNLESS they actually tried to
 * change a cap, in which case they're told no rather than left thinking it
 * saved — the old silent-discard was fine when nothing could ever send a
 * cap change; now something can, and pretending it worked would be worse
 * than refusing it.
 */
export async function POST(req: Request) {
  const guard = await requireWriter("params-write");
  if ("response" in guard) return guard.response;
  const { email, scope } = guard;

  const parsed = ParamsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          "Values out of range — caps must be positive (VIC/NSW up to $50M) and the company modifier between 0.1 and 2.",
      },
      { status: 400 }
    );
  }
  const previous = await getParams();
  const capsChanged =
    parsed.data.vCap !== previous.vCap ||
    parsed.data.nCap !== previous.nCap ||
    parsed.data.gCap !== previous.gCap;

  if (capsChanged && !canChangeCaps(scope)) {
    return NextResponse.json(
      { error: "You don't have permission to change the pool caps." },
      { status: 403 }
    );
  }

  const params = canChangeCaps(scope)
    ? parsed.data
    : { ...parsed.data, vCap: previous.vCap, nCap: previous.nCap, gCap: previous.gCap };

  const changes: string[] = [];
  if (previous.companyModifier !== params.companyModifier)
    changes.push(
      `company modifier ${previous.companyModifier} → ${params.companyModifier}`
    );
  if (previous.vCap !== params.vCap) changes.push(`VIC cap ${previous.vCap} → ${params.vCap}`);
  if (previous.nCap !== params.nCap) changes.push(`NSW cap ${previous.nCap} → ${params.nCap}`);
  if (previous.gCap !== params.gCap) changes.push(`Group cap ${previous.gCap} → ${params.gCap}`);

  if (changes.length === 0) {
    return noStore(NextResponse.json({ ok: true, params, unchanged: true }));
  }

  // The group cap is the sum of the two state caps (FY26: 2,959,288.48 =
  // 1,593,574.32 + 1,365,714.16). A save that leaves them disagreeing is how
  // both of the August 2026 cap corruptions got in unnoticed — one state cap
  // overwritten with a pool figure while the group cap kept the truth. A
  // WARNING, deliberately not a refusal: the card editors commit one field at
  // a time, so a legitimate correction is necessarily mid-way inconsistent
  // for one save. It goes into the history line, where the next reader sees
  // it, and back to the caller, who is looking at the cards right now.
  const warning = capsWarning(params);
  const summary =
    `Changed scheme parameters: ${changes.join("; ")}` +
    (warning ? ` — WARNING: ${warning}` : "");

  await takeSnapshot(email, "params");
  await saveParams(params);
  await appendHistory([
    {
      ts: new Date().toISOString(),
      actor: email,
      kind: "params",
      summary,
    },
  ]);
  console.log(
    `[audit] params-change by=${email} ${changes.join("; ")}${
      warning ? ` warning="${warning}"` : ""
    } ts=${new Date().toISOString()}`
  );
  revalidatePath("/");

  return noStore(
    NextResponse.json(warning ? { ok: true, params, warning } : { ok: true, params })
  );
}
