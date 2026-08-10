import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { saveCopy, appendHistory } from "@/lib/store";
import { takeSnapshot } from "@/lib/snapshots";
import { CopySchema } from "@/lib/copy";
import { requireWriter, noStore } from "@/lib/api-guard";

export const dynamic = "force-dynamic";

/**
 * Save the dashboard's wording, edited in place in edit mode. Display only,
 * same guarantee as the column config (lib/copy.test.ts). Last-write-wins for
 * the same reasons as /api/columns.
 */
export async function POST(req: Request) {
  const guard = await requireWriter("copy-write");
  if ("response" in guard) return guard.response;
  const { email } = guard;

  const parsed = CopySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          parsed.error.issues
            .map((i) => `${i.path.join(".") || "value"}: ${i.message}`)
            .join("; ") || "Invalid wording",
      },
      { status: 400 }
    );
  }
  const copy = parsed.data;

  await takeSnapshot(email, "copy");
  await saveCopy(copy);
  await appendHistory([
    {
      ts: new Date().toISOString(),
      actor: email,
      kind: "copy",
      summary: `Changed dashboard wording (scheme name "${copy.schemeName}", banner ${
        copy.bannerVisible ? `"${copy.bannerText}"` : "hidden"
      })`,
    },
  ]);
  console.log(`[audit] copy-change by=${email} ts=${new Date().toISOString()}`);
  revalidatePath("/");

  return noStore(NextResponse.json({ ok: true, copy }));
}
