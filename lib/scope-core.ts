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
import { ruleMatches } from "./access-rules";
import { editableColumns, canLockRows, scopeOverridesView } from "./write-scope";
import { NUMERIC_FIELDS } from "./access-types";
import {
  DEFAULT_COLUMNS,
  effectiveColumns,
  normalizeConfig,
  type ColumnConfig,
} from "./columns";
import { DEFAULT_COPY, type Copy } from "./copy";
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

export interface PayloadOptions {
  overridesVersion?: number;
  columnConfig?: ColumnConfig;
  copy?: Copy;
  /** optimistic-concurrency token for inline dataset edits (editors only) */
  datasetVersion?: number;
  /**
   * The company modifier already folded into `data` by applyParams. Editors
   * need it to convert a displayed After-IPM figure back to the stored one.
   */
  companyModifier?: number;
}

export function buildPayloadCore(
  data: Dataset,
  overrides: Overrides,
  scope: Scope,
  user: UserInfo,
  opts: PayloadOptions = {}
): DashboardPayload {
  const {
    overridesVersion = 0,
    columnConfig = DEFAULT_COLUMNS,
    copy = DEFAULT_COPY,
    datasetVersion = 0,
    companyModifier = 1,
  } = opts;
  const normalizedConfig = normalizeConfig(columnConfig);

  if (scope.rule.type === "full") {
    return {
      mode: "editor",
      user,
      employees: data.emp,
      overrides,
      overridesVersion,
      datasetVersion,
      companyModifier,
      columns: effectiveColumns(columnConfig, NUMERIC_FIELDS),
      columnConfig: normalizedConfig,
      copy,
      params: {
        vCap: data.vCap,
        nCap: data.nCap,
        gCap: data.gCap,
        companyModifier,
      },
      caps: { vCap: data.vCap, nCap: data.nCap, gCap: data.gCap },
      canEditCaps: scope.rule.canEditCaps,
      cats: data.cats,
      depts: data.depts,
      mgrs: data.mgrs,
    };
  }

  // Read-only: compute over the full pool, then scope.
  const emps = applyOverrides(data.emp, overrides);
  const pool = computeScalesAndBonuses(emps, data);

  // one definition of "in scope", shared with the write boundary
  // (lib/write-scope.ts) so the two can never disagree about whose row it is
  const allowed: CalcEmployee[] = emps.filter((e) => ruleMatches(scope.rule, e));

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
    if (fields.has("elig")) row.elig = e.elig;
    if (fields.has("totalPkg")) row.totalPkg = e.totalPkg;
    if (fields.has("pkg")) row.pkg = e.pkg;
    if (fields.has("bp")) row.bp = e.bpEdit;
    if (fields.has("potential")) row.potential = e.preIpm;
    if (fields.has("ipm")) row.ipm = e.ipmEdit;
    if (fields.has("bipm")) row.bipm = e.bipmCalc;
    if (fields.has("calc")) row.calc = e.calcBonus;
    if (fields.has("f25")) row.f25 = e.f25;
    if (fields.has("da")) row.da = e.daEdit;
    if (fields.has("yoy")) row.yoy = e.finalBonus - e.f25;
    if (fields.has("final")) row.final = e.finalBonus;
    // Gated by visibleFields like every other numeric field, and additionally
    // only ever populated for a Shared Services row — a VIC or NSW employee
    // is 100% one pool already, so there is nothing to show or edit.
    if (e.st === "SHARED") {
      if (fields.has("vp")) row.vp = e.vp;
      if (fields.has("np")) row.np = e.np;
    }
    return row;
  });

  // Pool cards: state users get their state card(s) like the prototype's
  // state views (pool available, total allocated, remaining). Subset users get none.
  // Which pools this user is entitled to a summary of. A group rule scoped to
  // a state gets that state's card, the same as a plain state rule — a subset
  // rule gets none, because an arbitrary list of people has no pool of its own.
  const cardStates =
    scope.rule.type === "state" || scope.rule.type === "group"
      ? scope.rule.states
      : [];
  const poolCards: StatePoolCard[] = [];
  {
    for (const st of cardStates) {
      if (st === "SHARED") continue;
      const stateEmps = allowed.filter((e) => e.st === st);
      const stateBonuses = stateEmps.reduce(
        (s: number, e: CalcEmployee) => s + e.finalBonus,
        0
      );
      const avail = st === "VIC" ? pool.stateVicAvail : pool.stateNswAvail;
      const card: StatePoolCard = {
        // resolved here, so renaming a pool card reaches state leads too
        title: st === "VIC" ? copy.poolTitles.vic : copy.poolTitles.nsw,
        stateBonuses,
        available: avail,
        utilPct: avail > 0 ? stateBonuses / avail : 1,
      };
      poolCards.push(card);
    }
  }

  // Filter option lists derived from the user's own rows only.
  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  // A single-state read-only user's State column would be the same value on
  // every row, so it is dropped regardless of the presentation config — the
  // behaviour this view has always had.
  const showStateColumn =
    scope.rule.type === "subset" ||
    (scope.rule.type === "state" && scope.rule.states.length > 1);
  const columns = effectiveColumns(columnConfig, scope.visibleFields).filter(
    (c) => c.key !== "state" || showStateColumn
  );
  const payload: ReadonlyPayload = {
    mode: "readonly",
    user,
    rows,
    visibleFields: scope.visibleFields,
    columns,
    canEditFields: editableColumns(scope),
    canLock: canLockRows(scope),
    // the same window the write boundary enforces: their rows, their fields.
    // A lead needs this baseline so a save doesn't clear rows they never
    // touched, and the version so their save isn't a guaranteed 409.
    overrides: scopeOverridesView(scope, data.emp, overrides),
    overridesVersion,
    // pool titles are already baked into poolCards[].title above; sending the
    // map too would name the pools this user has no business seeing
    copy: {
      schemeName: copy.schemeName,
      bannerText: copy.bannerText,
      bannerVisible: copy.bannerVisible,
      footerText: copy.footerText,
    },
    showStateColumn,
    poolCards,
    cats: uniq(allowed.map((e) => e.cat)),
    depts: uniq(allowed.map((e) => e.dept)),
    mgrs: uniq(allowed.map((e) => e.mgr)),
  };
  return payload;
}
