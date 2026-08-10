import "server-only";
import { cookies } from "next/headers";
import { allRules } from "./access";
import { appendHistory } from "./store";
import { resolveViewer, VIEW_AS_COOKIE } from "./view-as";

/**
 * Who an admin can view as, and the actions that start and stop it.
 *
 * The candidates are the access list rather than the company directory: those
 * are the only people whose view of this app differs from anyone else's, and
 * everyone else would just show the "no access" page.
 */

export interface ViewableUser {
  email: string;
  /** what they can see, in the same words the access screen uses */
  summary: string;
}

function summarise(rule: {
  type: string;
  states?: readonly string[];
  positions?: readonly string[];
  employeeIds?: readonly string[];
}): string {
  if (rule.type === "full") return "Full access";
  if (rule.type === "state") return `${(rule.states ?? []).join(" + ")}`;
  if (rule.type === "group") {
    const where = rule.states?.length ? rule.states.join(" + ") : "all states";
    const who = rule.positions?.length ? rule.positions.join(", ") : "all roles";
    return `${where} · ${who}`;
  }
  const n = rule.employeeIds?.length ?? 0;
  return `${n} employee${n === 1 ? "" : "s"}`;
}

export async function listViewableUsers(actor: string): Promise<ViewableUser[]> {
  const rules = await allRules();
  return Object.entries(rules)
    .filter(([email]) => email !== actor.toLowerCase())
    .map(([email, eff]) => ({ email, summary: summarise(eff.rule) }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

/**
 * Start viewing as someone. Refuses unless the caller is genuinely
 * full-access — the same check `resolveViewer` makes before honouring the
 * cookie, so a forged one is inert either way.
 */
export async function startViewAs(target: string): Promise<void> {
  const { actor, actorScope } = await resolveViewer();
  if (!actor || !actorScope?.canEdit) return;

  const email = target.trim().toLowerCase();
  if (!email || email === actor) return;

  (await cookies()).set(VIEW_AS_COOKIE, email, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60, // an hour is longer than anyone needs to check a view
  });

  await appendHistory([
    {
      ts: new Date().toISOString(),
      actor,
      kind: "access",
      summary: `Started viewing the dashboard as ${email} (read-only)`,
      target: email,
    },
  ]);
  console.log(
    `[audit] view-as-start actor=${actor} target=${email} ts=${new Date().toISOString()}`
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
