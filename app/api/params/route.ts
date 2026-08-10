import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { saveParams, appendHistory } from "@/lib/store";
import { getParams } from "@/lib/data";
import { takeSnapshot } from "@/lib/snapshots";
import { ParamsSchema } from "@/lib/params-apply";
import { fmt } from "@/lib/fmt";
import { requireWriter, noStore } from "@/lib/api-guard";

export const dynamic = "force-dynamic";

/**
 * Save the pool caps and the company modifier, edited straight on the pool
 * cards. Unlike the presentation docs these DO move every figure, so the
 * history entry spells out exactly what changed.
 *
 * The caller sees the impact before saving without a preview pane: the
 * dashboard runs the same engine client-side, so the cards recalculate as the
 * number is typed. `/admin/params` used to do that in a separate panel.
 */
export async function POST(req: Request) {
  const guard = await requireWriter("params-write");
  if ("response" in guard) return guard.response;
  const { email } = guard;

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
  const params = parsed.data;
  const previous = await getParams();

  const changes: string[] = [];
  if (previous.vCap !== params.vCap)
    changes.push(`VIC cap ${fmt(previous.vCap)} → ${fmt(params.vCap)}`);
  if (previous.nCap !== params.nCap)
    changes.push(`NSW cap ${fmt(previous.nCap)} → ${fmt(params.nCap)}`);
  if (previous.gCap !== params.gCap)
    changes.push(`Group cap ${fmt(previous.gCap)} → ${fmt(params.gCap)}`);
  if (previous.companyModifier !== params.companyModifier)
    changes.push(
      `company modifier ${previous.companyModifier} → ${params.companyModifier}`
    );

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
