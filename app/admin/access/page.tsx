import { redirect } from "next/navigation";
import { allRules } from "@/lib/access";
import { resolveViewer } from "@/lib/view-as";
import { getDataset, getEffectiveDataset } from "@/lib/data";
import { loadOverrides } from "@/lib/store";
import { applyOverrides, computeScalesAndBonuses } from "@/lib/calc";
import {
  capIsStatePool,
  managerPoolFrom,
  maxAdditionalAllocation,
  suggestedAllowance,
} from "@/lib/manager-pool";
import { canChangeCaps } from "@/lib/params-apply";
import AccessManager, { type AllocationInfo } from "@/components/AccessManager";

export const metadata = { title: "Texco" };
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const { actor, scope } = await resolveViewer();
  if (!actor) redirect("/login");
  if (!scope) redirect("/no-access");
  if (!scope.canEdit) redirect("/");
  const email = actor;

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

  // Per-scope bonus-allocation figures for the editor's "Bonus allocation"
  // section. One engine pass over the WHOLE population, then measured per rule —
  // managerPoolFrom applies the scope filter itself and its share denominator is
  // a whole-population sum, so handing it pre-filtered rows would make every
  // share 1 (see its docblock).
  const effective = await getEffectiveDataset();
  const emps = applyOverrides(effective.emp, await loadOverrides());
  computeScalesAndBonuses(emps, effective);

  const allocation: Record<string, AllocationInfo> = {};
  for (const { email: em, rule } of list) {
    if (rule.type === "full") continue;
    const p = managerPoolFrom(rule, emps, effective);
    const wholeState = capIsStatePool(rule);
    const peers = list
      .filter((r) => r.email !== em && r.rule.type !== "full")
      .map((r) => r.rule);
    allocation[em] = {
      allocated: p.allocated,
      // What the field shows: the unused half of the ceiling they hold, or null
      // when no allowance has ever been granted.
      allowance: rule.allocationCap === undefined ? null : p.remaining,
      cap: rule.allocationCap ?? null,
      wholeState,
      // For a whole-state scope these three are the authoritative state figures
      // rather than a share of anything, which is exactly what the read-only
      // rows are meant to say.
      suggested: wholeState ? p.remaining : suggestedAllowance(rule, emps, effective),
      max: wholeState ? p.remaining : maxAdditionalAllocation(rule, peers, emps, effective),
      setBy: rule.allocationCapBy ?? null,
      setAt: rule.allocationCapAt ?? null,
    };
  }

  console.log(
    `[audit] pageview page=admin email=${email} ts=${new Date().toISOString()}`
  );

  return (
    <AccessManager
      initialRules={list}
      employees={employees}
      positions={positions}
      me={email.toLowerCase()}
      allocation={allocation}
      canSetAllocation={canChangeCaps(scope)}
    />
  );
}
