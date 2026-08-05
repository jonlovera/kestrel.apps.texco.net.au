import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { scopeForUser, allRules } from "@/lib/access";
import { getBonusData } from "@/lib/data";
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
  const employees = getBonusData().emp.map((e) => ({
    id: e.id,
    name: `${e.gn} ${e.sn}`,
    st: e.st,
  }));

  console.log(
    `[audit] pageview page=admin email=${email} ts=${new Date().toISOString()}`
  );

  return (
    <AccessManager
      initialRules={list}
      employees={employees}
      me={email.toLowerCase()}
    />
  );
}
