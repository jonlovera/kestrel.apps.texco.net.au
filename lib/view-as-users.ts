import "server-only";
import { cookies } from "next/headers";
import { allRules, scopeForUser, type Scope } from "./access";
import { describeEditing, type GrantingRule } from "./access-rules";
import { appendHistory } from "./store";
import { resolveViewer, VIEW_AS_COOKIE } from "./view-as";
import { viewAsTarget, canActOn } from "./view-as-core";

/**
 * Who a person can view as, and the actions that start and stop it.
 *
 * The candidates are the access list rather than the company directory: those
 * are the only people whose view of this app differs from anyone else's, and
 * everyone else would just show the "no access" page.
 *
 * A full-access actor gets the whole list (read-only views, as always).
 * Anyone else gets exactly the people on their own rule's `canActAs` — the
 * per-target delegation, whose views they can also edit.
 */

export interface ViewableUser {
  email: string;
  /** what they can see, in the same words the access screen uses */
  summary: string;
}

function summarise(rule: GrantingRule): string {
  if (rule.type === "full") return "Full access";
  // Picking who to view as is largely a question of what they can do, so the
  // grant is part of the line rather than something you discover afterwards.
  const editing = describeEditing(rule);
  if (rule.type === "state") return `${rule.states.join(" + ")} · ${editing}`;
  if (rule.type === "group") {
    const where = rule.states.length ? rule.states.join(" + ") : "all states";
    const who = rule.positions.length ? rule.positions.join(", ") : "all roles";
    return `${where} · ${who} · ${editing}`;
  }
  const n = rule.employeeIds.length;
  return `${n} employee${n === 1 ? "" : "s"} · ${editing}`;
}

export async function listViewableUsers(
  actor: string,
  actorScope: Scope | null
): Promise<ViewableUser[]> {
  if (!actorScope) return [];
  const rules = await allRules();
  const delegated = new Set(
    actorScope.canEdit ? [] : actorScope.rule.canActAs.map((e) => e.toLowerCase())
  );
  return Object.entries(rules)
    .filter(
      ([email]) =>
        email !== actor.toLowerCase() &&
        (actorScope.canEdit || delegated.has(email))
    )
    .map(([email, eff]) => ({
      email,
      // for a non-admin, every candidate is one they were delegated, so say
      // what that means up front rather than leaving it to be discovered
      summary:
        summarise(eff.rule) + (actorScope.canEdit ? "" : " · you can make changes"),
    }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

/**
 * Start viewing as someone. Authorised by the same decision `resolveViewer`
 * makes before honouring the cookie (lib/view-as-core.ts), so a forged
 * cookie and a forged form post are inert in exactly the same way.
 */
export async function startViewAs(target: string): Promise<void> {
  const { actor, actorScope } = await resolveViewer();
  if (!actor) return;

  const email = target.trim().toLowerCase();
  if (viewAsTarget(actorScope, actor, email) !== email || !email) return;

  (await cookies()).set(VIEW_AS_COOKIE, email, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60, // an hour; a lapse mid-edit is made safe by /api/state's viewFor check
  });

  const canAct = canActOn(actorScope, await scopeForUser(email));
  await appendHistory([
    {
      ts: new Date().toISOString(),
      actor,
      kind: "access",
      summary: `Started viewing the dashboard as ${email} (${canAct ? "can edit" : "read-only"})`,
      target: email,
    },
  ]);
  console.log(
    `[audit] view-as-start actor=${actor} target=${email} canAct=${canAct} ts=${new Date().toISOString()}`
  );
}

/** Stop. Never permission-checked — exiting must always be possible. */
export async function stopViewAs(): Promise<void> {
  const { actor, viewingAs } = await resolveViewer();
  (await cookies()).delete(VIEW_AS_COOKIE);

  if (actor && viewingAs) {
    await appendHistory([
      {
        ts: new Date().toISOString(),
        actor,
        kind: "access",
        summary: `Stopped viewing as ${viewingAs}`,
        target: viewingAs,
      },
    ]);
    console.log(
      `[audit] view-as-stop actor=${actor} target=${viewingAs} ts=${new Date().toISOString()}`
    );
  }
}
