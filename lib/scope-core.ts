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
import {
  editableColumns,
  canLockRows,
  canDownloadLetters, canAdjustVicSiteManagers,
  canRecalculatePool as canRecalcPool,
  canRevokeIssued as canRevokeIssuedFor,
  scopeOverridesView,
} from "./write-scope";
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
  UserInfo,
} from "./payload-types";
import { managerPoolFrom, countsAgainstPool } from "./manager-pool";
import { isSplit } from "./dataset-edit";

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
  /**
   * The STORED overrides document, when `overrides` is a what-if rather than
   * what is on disk (/api/preview). A lead's cap is measured from the baseline
   * so it holds still while they type — see lib/manager-pool.ts's
   * managerPoolFrom. Omitted means "the document IS the baseline", which is
   * what the page load and the tests mean.
   */
  baselineOverrides?: Overrides;
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
    baselineOverrides,
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
        // The persisted Scale Factors, so the browser's engine pass uses the
        // same stored figure the server does rather than deriving its own —
        // which is the whole point of storing them. Undefined until somebody
        // has pressed Recalculate, and undefined is meaningful: it selects the
        // advisory derivation for display and stops lib/reprice.ts re-pricing
        // any pooled payout.
        vicScale: data.vicScale,
        nswScale: data.nswScale,
      },
      // Deliberately without the scale factors: `caps` is the cap trio the
      // pool cards render and clamp against, while the engine runs on `params`
      // above — which is where the scales ride.
      caps: { vCap: data.vCap, nCap: data.nCap, gCap: data.gCap },
      canEditCaps: scope.rule.canEditCaps,
      canRecalculatePool: canRecalcPool(scope),
      canRevokeIssued: canRevokeIssuedFor(scope),
      canEditVicSiteManagers: canAdjustVicSiteManagers(scope),
      canDownloadLetter: canDownloadLetters(scope),
      cats: data.cats,
      depts: data.depts,
      mgrs: data.mgrs,
    };
  }

  // Read-only: compute over the full pool, then scope. The returned PoolState
  // is deliberately dropped — the state scales and state availability it
  // carries are group figures, and the header this payload now builds is about
  // the manager's own scope rather than a state waterfall.
  const emps = applyOverrides(data.emp, overrides);
  computeScalesAndBonuses(emps, data);

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
      inHomeTotal: countsAgainstPool(e),
    };
    // The issue stamp, when there is one. Ungated by visibleFields, unlike
    // every figure below, because it is a STATE and not a figure: a lead has
    // to be able to see that a row is committed, or they will keep typing into
    // cells the server refuses. Its `amount` is the row's Final bonus, so it is
    // withheld from a scope that cannot see Final — see below.
    if (e.issued !== undefined) {
      const { amount, ...stamp } = e.issued;
      row.issued = fields.has("final") ? { ...stamp, amount } : stamp;
    }
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
    // only populated where the cost actually divides across the two pools —
    // whatever the state label, since a VIC person can fund a slice of NSW
    // work. A clean 1/0 row has nothing to show.
    if (isSplit(e.vp)) {
      if (fields.has("vp")) row.vp = e.vp;
      if (fields.has("np")) row.np = e.np;
    }
    return row;
  });

  // The header: this manager's own pool. For a whole-state grant that IS the
  // proportional share of the state pools their people are funded by, measured
  // in committed payouts over their WHOLE authorised scope (owner decision,
  // 28 Aug 2026 — see lib/manager-pool.ts for the formula, for what it
  // replaced, and for why a nested grant is a permission boundary rather than a
  // funding carve-out). A whole-state lead's share is 1, so their budget is
  // exactly the pool card an admin sees. `allowed` is already the engine-computed
  // population narrowed by ruleMatches, so this is a filter-and-sum with no
  // second engine pass — /api/preview runs it on every keystroke burst.
  // NOTE the whole population goes in, not `allowed`. managerPoolFrom applies
  // the scope filter itself, and its share denominator is a WHOLE-POPULATION
  // sum — how much of the state pool everyone draws — so handing it the
  // pre-filtered rows would divide the lead's own draw by itself and hand them
  // a share of 1. It read `allowed` while `pool` was a sum over the scope
  // alone, where the filter was the only thing `emps` was for.
  // The baseline population, when this is a what-if over a stored document
  // (/api/preview). One extra engine pass, and it is what keeps the cap from
  // drifting under the lead as they type — see managerPoolFrom.
  let baseline = emps;
  if (baselineOverrides !== undefined && baselineOverrides !== overrides) {
    baseline = applyOverrides(data.emp, baselineOverrides);
    computeScalesAndBonuses(baseline, data);
  }
  const managerPool = managerPoolFrom(scope.rule, emps, data, baseline);

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
    canDownloadLetter: canDownloadLetters(scope),
    // the same window the write boundary enforces: their rows, their fields.
    // A lead needs this baseline so a save doesn't clear rows they never
    // touched, and the version so their save isn't a guaranteed 409.
    overrides: scopeOverridesView(scope, data.emp, overrides),
    overridesVersion,
    // the header names this user's own pool with fixed labels; sending the
    // poolTitles map would name the pools they have no business seeing
    copy: {
      schemeName: copy.schemeName,
      bannerText: copy.bannerText,
      bannerVisible: copy.bannerVisible,
      footerText: copy.footerText,
    },
    showStateColumn,
    managerPool,
    cats: uniq(allowed.map((e) => e.cat)),
    depts: uniq(allowed.map((e) => e.dept)),
    mgrs: uniq(allowed.map((e) => e.mgr)),
  };
  return payload;
}
