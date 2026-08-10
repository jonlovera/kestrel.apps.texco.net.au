import "server-only";
import { NextResponse } from "next/server";
import { resolveViewer } from "./view-as";
import type { Scope } from "./access";

/**
 * The gates every mutating route repeats. Each route still authorises
 * independently — that is the point; this only removes the copy-paste.
 */

export interface Guarded {
  email: string;
  scope: Scope;
}

/**
 * Full access required. Resolves through the view-as layer, so an admin
 * looking at a lead's view is treated as that lead — which is what makes most
 * of the write blocking fall out for free rather than needing a check per
 * route.
 */
export async function requireEditor(
  action: string
): Promise<Guarded | { response: NextResponse }> {
  const { actor, scope } = await resolveViewer();

  if (!actor || !scope) {
    return {
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  if (!scope.canEdit) {
    console.log(
      `[audit] DENIED ${action} email=${actor} scope=${scope.rule.type} ts=${new Date().toISOString()}`
    );
    return {
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }
  return { email: actor, scope };
}

/**
 * Anything that persists. Same as requireEditor, plus: nothing may be written
 * while viewing as someone else.
 *
 * The explicit refusal earns its place on /api/state, which a state lead IS
 * allowed to call — so without it, an admin viewing as a lead could save, and
 * the history would name the wrong person. Everywhere else the scope check
 * above already refuses.
 */
export async function requireWriter(
  action: string
): Promise<Guarded | { response: NextResponse }> {
  const { actor, scope, viewingAs } = await resolveViewer();

  if (!actor || !scope) {
    return {
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  if (viewingAs) {
    console.log(
      `[audit] DENIED ${action} email=${actor} reason=viewing-as target=${viewingAs} ts=${new Date().toISOString()}`
    );
    return {
      response: NextResponse.json(
        {
          error:
            "You're viewing as someone else. Exit that view before making changes.",
        },
        { status: 403 }
      ),
    };
  }
  return { email: actor, scope };
}

export function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store, max-age=0");
  return res;
}
