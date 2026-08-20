import { NextResponse } from "next/server";
import { resolveViewer } from "@/lib/view-as";
import { loadOverridesVersion } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * The overrides document's version number and nothing else — a bare integer,
 * so any signed-in scope may ask. The dashboard probes this on its autosave
 * tick to notice "a colleague has saved" without attempting a write.
 */
export async function GET() {
  const { actor, scope } = await resolveViewer();
  if (!actor || !scope) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const res = NextResponse.json({ version: await loadOverridesVersion() });
  res.headers.set("Cache-Control", "no-store, max-age=0");
  return res;
}
