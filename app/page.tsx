import { redirect } from "next/navigation";
import { resolveViewer } from "@/lib/view-as";
import { buildDashboardPayload } from "@/lib/scope";
import { listViewableUsers } from "@/lib/view-as-users";
import DashboardClient from "@/components/DashboardClient";

// Bland on purpose — browser tab titles end up in history and window lists.
export const metadata = { title: "Texco" };
export const dynamic = "force-dynamic";

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
      payload={payload}
      viewAs={{
        actor,
        viewingAs,
        // only a full-access actor may start a view; everyone else gets nothing
        candidates: actorScope?.canEdit ? await listViewableUsers(actor) : [],
      }}
    />
  );
}
