import "server-only";
import { cookies } from "next/headers";
import { auth } from "@/auth";
import { scopeForUser, type Scope } from "./access";

/**
 * "View as" — see the dashboard exactly as another person sees it.
 *
 * ~/Sites/tools does this as full impersonation: its middleware calls
 * `Auth::setUser`, so the impersonator *becomes* the target and can act as
 * them. Kestrel's is deliberately view-only. Every figure here is written into
 * history and snapshotted against an actor, and a change recorded against
 * someone who did not make it would make that record worse than useless.
 *
 * The security property that matters:
 *
 *   The cookie is honoured ONLY when the real signed-in user is full-access.
 *
 * That check — not the cookie's httpOnly flag — is the boundary. A state lead
 * who forges the cookie gets nothing, because their own scope is re-derived
 * from their session on every request and the cookie is discarded before it is
 * ever consulted.
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
}

/**
 * Who is this request being rendered for? The single answer used by pages and
 * by the API guards, so the view and the permissions can never disagree.
 */
export async function resolveViewer(): Promise<Viewer> {
  const session = await auth();
  const actor = session?.user?.email?.toLowerCase() ?? null;
  if (!actor) {
    return { actor: null, viewingAs: null, scope: null, actorScope: null };
  }

  const actorScope = await scopeForUser(actor);
  const empty = { actor, viewingAs: null, scope: actorScope, actorScope };

  // Only a full-access user may view as anyone. Everyone else gets their own
  // scope and the cookie is never read.
  if (!actorScope?.canEdit) return empty;

  const target = (await cookies()).get(VIEW_AS_COOKIE)?.value?.toLowerCase();
  if (!target || target === actor) return empty;

  const targetScope = await scopeForUser(target);
  if (!targetScope) {
    // They have no access at all. That is a legitimate thing to want to see —
    // it is what a new starter hits — so report it rather than falling back.
    return { actor, viewingAs: target, scope: null, actorScope };
  }
  return { actor, viewingAs: target, scope: targetScope, actorScope };
}

/** True while this request is rendering somebody else's view. */
export async function isViewingAs(): Promise<boolean> {
  return (await resolveViewer()).viewingAs !== null;
}
