import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { scopeForUser, allRules } from "@/lib/access";
import { getDataset } from "@/lib/data";
import AccessManager from "@/components/AccessManager";

export const metadata = { title: "Texco" };
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) redirect("/login");

  const scope = await scopeForUser(email);
  if (!scope) redirect("/no-access");
  if (!scope.canEdit) redirect("/");

  const rules = await allRules();
  const list = Object.entries(rules)
    .map(([em, eff]) => ({ email: em, rule: eff.rule, source: eff.source }))
    .sort((a, b) => a.email.localeCompare(b.email));

  // id + name only — needed for the subset picker (admins are full-access).
  const dataset = await getDataset();
  const employees = dataset.emp.map((e) => ({
    id: e.id,
    name: `${e.gn} ${e.sn}`,
    st: e.st,
    pos: e.pos,
  }));
  // roles a group rule can name, with how many people hold each, so "all VIC
  // site managers" can be picked rather than typed
  const counts = new Map<string, number>();
  for (const e of dataset.emp) counts.set(e.pos, (counts.get(e.pos) ?? 0) + 1);
  const positions = [...counts.entries()]
    .map(([pos, count]) => ({ pos, count }))
    .sort((a, b) => b.count - a.count || a.pos.localeCompare(b.pos));

  console.log(
    `[audit] pageview page=admin email=${email} ts=${new Date().toISOString()}`
  );

  return (
    <AccessManager
      initialRules={list}
      employees={employees}
      positions={positions}
      me={email.toLowerCase()}
    />
  );
}
