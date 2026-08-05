/**
 * Pure payload assembly: row filtering + FIELD STRIPPING + payload shaping.
 *
 * No I/O and no server-only imports, so the entitlement behaviour is
 * directly unit-testable. lib/scope.ts is the server wrapper that loads the
 * stored docs and delegates here. The field-stripping loop below is the
 * authoritative entitlement boundary: a field a user isn't entitled to is
 * never placed on the payload object, so it cannot reach the browser
 * regardless of any presentation configuration.
 */
import type { Dataset, Overrides } from "./schema";
import type { Scope } from "./access";
import {
  applyOverrides,
  computeScalesAndBonuses,
  type CalcEmployee,
} from "./calc";
import type {
  DashboardPayload,
  ReadonlyPayload,
  ScopedRow,
  StatePoolCard,
  UserInfo,
} from "./payload-types";

export function buildPayloadCore(
  data: Dataset,
  overrides: Overrides,
  scope: Scope,
  user: UserInfo,
  overridesVersion = 0
): DashboardPayload {
  if (scope.rule.type === "full") {
    return {
      mode: "editor",
      user,
      employees: data.emp,
      overrides,
      overridesVersion,
      caps: { vCap: data.vCap, nCap: data.nCap, gCap: data.gCap },
      cats: data.cats,
      depts: data.depts,
      mgrs: data.mgrs,
    };
  }

  // Read-only: compute over the full pool, then scope.
  const emps = applyOverrides(data.emp, overrides);
  const pool = computeScalesAndBonuses(emps, data);

  let allowed: CalcEmployee[];
  if (scope.rule.type === "state") {
    const states: string[] = scope.rule.states;
    allowed = emps.filter((e) => states.includes(e.st));
  } else {
    const ids = new Set(scope.rule.employeeIds);
    allowed = emps.filter((e) => ids.has(e.id));
  }

  const fields = new Set(scope.visibleFields);
  const rows: ScopedRow[] = allowed.map((e) => {
    const row: ScopedRow = {
      id: e.id,
      name: `${e.gn} ${e.sn}`,
      st: e.st,
      pos: e.pos,
      dept: e.dept,
      mgr: e.mgr,
      cat: e.cat,
      sm: e.sm,
      locked: e.locked,
      inPool: e.vp > 0 || e.np > 0,
    };
    if (fields.has("pkg")) row.pkg = e.pkg;
    if (fields.has("bp")) row.bp = e.bpEdit;
    if (fields.has("ipm")) row.ipm = e.ipmEdit;
    if (fields.has("bipm")) row.bipm = e.bipmCalc;
    if (fields.has("calc")) row.calc = e.calcBonus;
    if (fields.has("f25")) row.f25 = e.f25;
    if (fields.has("da")) row.da = e.daEdit;
    if (fields.has("yoy")) row.yoy = e.finalBonus - e.f25;
    if (fields.has("final")) row.final = e.finalBonus;
    return row;
  });

  // Pool cards: state users get their state card(s) like the prototype's
  // state views (total, utilisation, scale factor). Subset users get none.
  const poolCards: StatePoolCard[] = [];
  if (scope.rule.type === "state") {
    for (const st of scope.rule.states) {
      if (st === "SHARED") continue;
      const stateEmps = allowed.filter((e) => e.st === st);
      const stateBonuses = stateEmps.reduce(
        (s: number, e: CalcEmployee) => s + e.finalBonus,
        0
      );
      const avail = st === "VIC" ? pool.stateVicAvail : pool.stateNswAvail;
      poolCards.push({
        title: `${st} pool`,
        stateBonuses,
        utilPct: avail > 0 ? stateBonuses / avail : 1,
        scale: st === "VIC" ? pool.vicScale : pool.nswScale,
        scaleLabel: `${st} scale factor`,
      });
    }
  }

  // Filter option lists derived from the user's own rows only.
  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  const payload: ReadonlyPayload = {
    mode: "readonly",
    user,
    rows,
    visibleFields: scope.visibleFields,
    showStateColumn:
      scope.rule.type === "subset" ||
      (scope.rule.type === "state" && scope.rule.states.length > 1),
    poolCards,
    cats: uniq(allowed.map((e) => e.cat)),
    depts: uniq(allowed.map((e) => e.dept)),
    mgrs: uniq(allowed.map((e) => e.mgr)),
  };
  return payload;
}
