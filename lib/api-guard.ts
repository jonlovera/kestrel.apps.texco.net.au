import "server-only";
import { NextResponse } from "next/server";
import { resolveViewer } from "./view-as";
import { writeVerdict, type WriteLevel } from "./write-scope";
import type { Scope } from "./access";

/**
 * The gates every mutating route repeats. Each route still authorises
 * independently — that is the point; this only removes the copy-paste.
 */

export interface Guarded {
  email: string;
  scope: Scope;
  /**
   * The active view's target when this write passed under an act-as
   * sanction, null otherwise. /api/state uses it to stamp history ("Clint,
   * as Jon") and to verify the client's `viewFor` safeguard.
   */
  viewingAs: string | null;
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
  return { email: actor, scope, viewingAs: null };
}

/**
 * Resolve the caller, put the decision to writeVerdict (lib/write-scope.ts),
 * and turn its answer into a response. The rule itself lives there so it can
 * be tested; this only knows how to say no over HTTP.
 */
async function gate(
  level: WriteLevel,
  action: string
): Promise<Guarded | { response: NextResponse }> {
  const { actor, scope, viewingAs, canAct } = await resolveViewer();
  const verdict = writeVerdict(level, actor, scope, viewingAs, canAct);

  // Narrowed rather than asserted: "ok" already implies both are present, and
  // a security path should not be the place where that is taken on trust.
  if (verdict === "ok" && actor && scope) {
    return { email: actor, scope, viewingAs };
  }

  if (verdict === "unauthenticated" || !actor || !scope) {
    return {
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  if (verdict === "viewing-as") {
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
  console.log(
    `[audit] DENIED ${action} email=${actor} scope=${scope?.rule.type} ts=${new Date().toISOString()}`
  );
  return {
    response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  };
}

/**
 * Anything that persists and is the admin's alone: the dataset, the pool
 * caps, the presentation, imports, and the access list itself. Full access,
 * and not while viewing as someone.
 *
 * This used to be the viewing-as check ONLY. It was written for /api/state,
 * where a lead may legitimately write, and its comment claimed it was
 * "requireEditor plus the view-as rule" — but the `canEdit` half was never
 * there. Every other route then adopted it, so a state lead signed in as
 * themselves passed it on /api/dataset, /api/params, /api/import/apply and
 * /api/access, the last of which would have let them grant themselves full
 * access. The permissive form now has its own name below, so that reaching
 * for the obvious one fails closed.
 */
export async function requireWriter(
  action: string
): Promise<Guarded | { response: NextResponse }> {
  return gate("admin", action);
}

/**
 * A write that someone without full access may also make: /api/state, and
 * nothing else.
 *
 * Deliberately weaker, and deliberately named so that it cannot be picked by
 * accident. It settles only "is this a real user, and are they themselves" —
 * which rows and which fields they may touch is decided afterwards by
 * sanitiseOverrideWrite (lib/write-scope.ts) against their own scope. A route
 * that has no such per-row boundary of its own must use requireWriter.
 */
export async function requireScopedWriter(
  action: string
): Promise<Guarded | { response: NextResponse }> {
  return gate("scoped", action);
}

export function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store, max-age=0");
  return res;
}
