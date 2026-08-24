import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { saveParams, appendHistory } from "@/lib/store";
import { getParams } from "@/lib/data";
import { takeSnapshot } from "@/lib/snapshots";
import { ParamsSchema, canChangeCaps } from "@/lib/params-apply";
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
  // The redistribute tick is grouped with the caps deliberately: it changes
  // every unlocked row's figure, so it takes the same grant a cap change does.
  const capsChanged =
    parsed.data.vCap !== previous.vCap ||
    parsed.data.nCap !== previous.nCap ||
    parsed.data.gCap !== previous.gCap ||
    (parsed.data.redistribute === true) !== (previous.redistribute === true);

  if (capsChanged && !canChangeCaps(scope)) {
    return NextResponse.json(
      { error: "You don't have permission to change the pool caps." },
      { status: 403 }
    );
  }

  const params = canChangeCaps(scope)
    ? parsed.data
    : {
        ...parsed.data,
        vCap: previous.vCap,
        nCap: previous.nCap,
        gCap: previous.gCap,
        redistribute: previous.redistribute,
      };

  const changes: string[] = [];
  if ((previous.redistribute === true) !== (params.redistribute === true))
    changes.push(
      `Always redistribute ${params.redistribute ? "on" : "off"} (discretionary amounts ${params.redistribute ? "now funded from the pool" : "now sit on top of the pool"})`
    );
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

  await takeSnapshot(email, "params");
  await saveParams(params);
  await appendHistory([
    {
      ts: new Date().toISOString(),
      actor: email,
      kind: "params",
      summary: `Changed scheme parameters: ${changes.join("; ")}`,
    },
  ]);
  console.log(
    `[audit] params-change by=${email} ${changes.join("; ")} ts=${new Date().toISOString()}`
  );
  revalidatePath("/");

  return noStore(NextResponse.json({ ok: true, params }));
}
