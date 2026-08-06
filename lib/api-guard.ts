import "server-only";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { scopeForUser } from "./access";

/**
 * The full-access gate every mutating route repeats. Returns the actor's email
 * or the response to send instead — each route still authorises independently,
 * which is the point; this only removes the copy-paste.
 */
export async function requireEditor(
  action: string
): Promise<{ email: string } | { response: NextResponse }> {
  const session = await auth();
  const email = session?.user?.email;
  const scope = await scopeForUser(email);

  if (!email || !scope) {
    return {
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  if (!scope.canEdit) {
    console.log(
      `[audit] DENIED ${action} email=${email} scope=${scope.rule.type} ts=${new Date().toISOString()}`
    );
    return {
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }
  return { email };
}

export function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store, max-age=0");
  return res;
}
