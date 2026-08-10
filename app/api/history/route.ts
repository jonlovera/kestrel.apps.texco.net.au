import { NextResponse } from "next/server";
import { resolveViewer } from "@/lib/view-as";
import { loadHistory } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Change history — full-access users only. */
export async function GET() {
  const { actor: email, scope } = await resolveViewer();

  if (!email || !scope) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!scope.canEdit) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const entries = await loadHistory();
  const res = NextResponse.json({ entries });
  res.headers.set("Cache-Control", "no-store, max-age=0");
  return res;
}
