import "server-only";
import { cookies } from "next/headers";
import { auth } from "@/auth";
import { scopeForUser, type Scope } from "./access";
import { viewAsTarget, canActOn } from "./view-as-core";

/**
 * "View as" — see the dashboard exactly as another person sees it.
 *
 * ~/Sites/tools does this as full impersonation: its middleware calls
 * `Auth::setUser`, so the impersonator *becomes* the target and can act as
 * them. Kestrel never does that. Every figure here is written into history
 * and snapshotted against an actor, and a change recorded against someone
 * who did not make it would make that record worse than useless — so even
 * when a view is writable (below), what is written is always the ACTOR's
 * change, never the target's.
 *
 * The security property that matters:
 *
 *   The cookie is honoured ONLY when the actor's own scope authorises that
 *   specific target — full access for any target, or the target appearing
 *   on the actor's `canActAs` list (lib/view-as-core.ts).
 *
 * That decision — not the cookie's httpOnly flag — is the boundary. The
 * cookie is read before it (it has to be: the per-target grant needs to know
 * which target is being named), but it only ever nominates a candidate; the
 * actor's scope is re-derived from their session on every request, and a
 * forged cookie naming anyone outside the grant is inert.
 *
 * Views are read-only by default. The one exception is the per-target
 * delegation: `canActAs` on the actor's rule makes the named targets'
 * dashboards writable through /api/state, within the TARGET's own window,
 * recorded against the actor (`canAct` below carries the verdict).
 */

export const VIEW_AS_COOKIE = "kestrel_view_as";

export interface Viewer {
  /** the real signed-in person — who any write would be recorded against */
  actor: string | null;
  /** whose view is being rendered, when that isn't the actor's own */
  viewingAs: string | null;
  /** the scope the page should render with */
  scope: Scope | null;
  /** the actor's own scope, regardless of who they are viewing as */
  actorScope: Scope | null;
  /**
   * Whether the actor may write through /api/state while this view is
   * active (the per-target `canActAs` sanction). Always false outside a
   * view, and always false for an admin's blanket view.
   */
  canAct: boolean;
}

/**
 * Who is this request being rendered for? The single answer used by pages and
 * by the API guards, so the view and the permissions can never disagree.
 */
export async function resolveViewer(): Promise<Viewer> {
  const session = await auth();
  const actor = session?.user?.email?.toLowerCase() ?? null;
  if (!actor) {
    return { actor: null, viewingAs: null, scope: null, actorScope: null, canAct: false };
  }

  const actorScope = await scopeForUser(actor);
  const empty = {
    actor,
    viewingAs: null,
    scope: actorScope,
    actorScope,
    canAct: false,
  };

  const cookie = (await cookies()).get(VIEW_AS_COOKIE)?.value;
  const target = viewAsTarget(actorScope, actor, cookie);
  if (!target) return empty;

  const targetScope = await scopeForUser(target);
  if (!targetScope) {
    // They have no access at all. That is a legitimate thing to want to see —
    // it is what a new starter hits — so report it rather than falling back.
    return { actor, viewingAs: target, scope: null, actorScope, canAct: false };
  }
  return {
    actor,
    viewingAs: target,
    scope: targetScope,
    actorScope,
    canAct: canActOn(actorScope, targetScope),
  };
}
