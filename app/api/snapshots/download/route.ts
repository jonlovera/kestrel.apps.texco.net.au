import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { scopeForUser } from "@/lib/access";
import { loadSnapshots } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Download one snapshot as a JSON attachment. Full-access users only. */
export async function GET(req: Request) {
  const session = await auth();
  const email = session?.user?.email;
  const scope = await scopeForUser(email);
  if (!email || !scope) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!scope.canEdit) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const ts = new URL(req.url).searchParams.get("ts") ?? "";
  const snapshot = (await loadSnapshots()).find((s) => s.ts === ts);
  if (!snapshot) {
    return NextResponse.json({ error: "Snapshot not found" }, { status: 404 });
  }

  console.log(
    `[audit] snapshot-download email=${email} snapshot=${ts} ts=${new Date().toISOString()}`
  );

  const filename = `kestrel-snapshot-${ts.replace(/[:.]/g, "-")}.json`;
  return new NextResponse(JSON.stringify(snapshot, null, 1), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
