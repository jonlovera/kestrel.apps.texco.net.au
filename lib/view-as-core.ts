/**
 * The View as decisions, as pure functions — who may open a view of whom,
 * and who may WRITE while inside one. Extracted from lib/view-as.ts (which
 * is server-only and reaches for the session and the database) so the rules
 * are directly testable, and so the resolver, the picker, the start action
 * and the suite all run the identical logic instead of hand-kept copies.
 */
import type { Scope } from "./access";

/**
 * May this actor open a view of this target at all? Returns the normalised
 * target email, or null for "render their own view".
 *
 * Two ways in: full access views anyone (the original behaviour, still
 * read-only by itself), or the target appears on the actor's own rule's
 * `canActAs` list — the per-target delegation an admin configures on the
 * access screen. The cookie only ever NAMES a candidate; this decision, made
 * against the actor's scope re-derived from their session, is the boundary.
 * A forged cookie naming anyone not covered here is inert.
 */
export function viewAsTarget(
  actorScope: Scope | null,
  actor: string,
  cookieTarget: string | null | undefined
): string | null {
  if (!actorScope) return null;
  const target = cookieTarget?.trim().toLowerCase() ?? "";
  if (!target || target === actor.toLowerCase()) return null;
  if (actorScope.canEdit) return target;
  if (actorScope.rule.canActAs.some((e) => e.toLowerCase() === target)) {
    return target;
  }
  return null;
}

/**
 * May this actor WRITE (through /api/state, the one scoped-write route)
 * while viewing this target? The sanction that turns a view editable.
 *
 * Three conditions, each load-bearing:
 *  - the target must be on the actor's `canActAs` list. Deliberately NOT
 *    `actorScope.canEdit`: an admin's blanket view of anyone stays read-only
 *    unless that person was also explicitly delegated to them.
 *  - the target's own scope must not be full access. Acting for an admin
 *    would mean writing with an admin-wide window (every row, every lock);
 *    a delegation is for a lead's window, so a full-access target's
 *    dashboard stays view-only even when listed.
 *  - both scopes must exist at all.
 *
 * What the write may touch is then the TARGET's window (sanitiseOverrideWrite
 * runs against the target's scope), and who it is recorded against is the
 * ACTOR — the two halves of "Clint edits Jon's dashboard, logged as Clint".
 */
export function canActOn(
  actorScope: Scope | null,
  targetScope: Scope | null
): boolean {
  if (!actorScope || !targetScope) return false;
  if (targetScope.canEdit) return false;
  const target = targetScope.email.toLowerCase();
  return actorScope.rule.canActAs.some((e) => e.toLowerCase() === target);
}
