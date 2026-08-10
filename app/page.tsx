import { redirect } from "next/navigation";
import { resolveViewer } from "@/lib/view-as";
import { buildDashboardPayload } from "@/lib/scope";
import { listViewableUsers } from "@/lib/view-as-users";
import DashboardClient from "@/components/DashboardClient";
import type { DashboardPayload } from "@/lib/payload-types";

// Bland on purpose — browser tab titles end up in history and window lists.
export const metadata = { title: "Texco" };
export const dynamic = "force-dynamic";

/**
 * The columns the person being viewed may type into, named as their own table
 * names them, for the View as banner.
 *
 * Taken from the payload rather than re-derived, so it can never drift from
 * the cells actually rendered, and read through `columns` so a renamed
 * heading reaches the banner too. A full-access target reports nothing: their
 * view is the editor view, whose affordances all commit on blur and are
 * therefore switched off while a view is active.
 */
function describeWritableColumns(payload: DashboardPayload): string[] {
  if (payload.mode !== "readonly") return [];
  const byKey = new Map<string, string>(
    payload.columns.map((c) => [c.key, c.label])
  );
  return payload.canEditFields.map((k) => byKey.get(k) ?? k);
}

export default async function DashboardPage() {
  // Resolves through the view-as layer: an admin looking at a lead's view is
  // rendered exactly as that lead, from the same payload builder.
  const { actor, viewingAs, scope, actorScope } = await resolveViewer();
  if (!actor) redirect("/login"); // proxy already enforces this; belt-and-braces

  if (!scope) {
    // No access — either genuinely, or because they are viewing as somebody
    // who has none, which is a legitimate thing to want to check.
    if (viewingAs) redirect("/view-as/none");
    console.log(
      `[audit] pageview email=${actor} scope=NONE ts=${new Date().toISOString()}`
    );
    redirect("/no-access");
  }

  const payload = await buildDashboardPayload(scope, {
    name: viewingAs ?? actor,
    email: viewingAs ?? actor,
    scopeLabel: scope.label,
  });

  console.log(
    `[audit] pageview email=${actor}${viewingAs ? ` viewing-as=${viewingAs}` : ""} scope=${scope.rule.type} rows=${
      payload.mode === "editor" ? payload.employees.length : payload.rows.length
    } ts=${new Date().toISOString()}`
  );

  return (
    <DashboardClient
      /**
       * Not redundant: this key is what makes View as work.
       *
       * Starting or stopping a view is a server-action redirect, which is a
       * soft navigation, so React would otherwise reconcile the existing
       * DashboardClient rather than remount it and every piece of its state
       * would survive the switch. Nearly all of that state is seeded by
       * useState initialisers that branch on `payload.mode`, and those run
       * only at mount: an admin's editor mount seeds the read-only rows and
       * pool cards to [], so a lead's view rendered on that same instance
       * came out empty while its header, columns and banner (read straight
       * off the payload) looked perfectly correct.
       *
       * Changing the key when the viewer or the mode changes forces a clean
       * mount, so the initialisers re-run against the payload in hand. Both
       * parts are stable within a session, so this costs no extra remounts.
       */
      key={`${viewingAs ?? actor}:${payload.mode}`}
      payload={payload}
      viewAs={{
        actor,
        viewingAs,
        // only a full-access actor may start a view; everyone else gets nothing
        candidates: actorScope?.canEdit ? await listViewableUsers(actor) : [],
        targetCanEdit: describeWritableColumns(payload),
      }}
    />
  );
}
