/**
 * Types for the data that crosses the server → client boundary.
 * Types only — no runtime code, safe to import anywhere.
 */
import type { Employee, Overrides } from "./schema";
import type { NumericField } from "./access-types";
import type { ColumnConfig, PayloadColumn } from "./columns";
import type { Copy } from "./copy";
import type { Params } from "./params-apply";

export interface UserInfo {
  name: string;
  email: string;
  /** human-readable scope label shown in the header */
  scopeLabel: string;
}

/** One row as a read-only user receives it: only permitted fields present. */
export interface ScopedRow {
  id: string;
  name: string;
  st: "VIC" | "NSW" | "SHARED";
  pos: string;
  dept: string;
  mgr: string;
  cat: string;
  sm: 0 | 1;
  locked: boolean;
  /** whether the row participates in any pool (drives the DA '—' rendering) */
  inPool: boolean;
  pkg?: number;
  bp?: number;
  ipm?: number;
  bipm?: number;
  calc?: number;
  f25?: number;
  da?: number;
  yoy?: number;
  final?: number;
}

/**
 * The unified row the table renders in both modes. Editors get the extra pool
 * weights; read-only users get exactly their `ScopedRow`.
 */
export interface DisplayRow extends ScopedRow {
  vp?: number;
  np?: number;
  /** the source name halves, so edit mode can write them back separately */
  gn?: string;
  sn?: string;
}

export interface StatePoolCard {
  title: string;
  stateBonuses: number;
  /**
   * The state's own pool after shared services have been allocated out of it —
   * what these employees actually draw from, and what the utilisation bar is a
   * proportion of. Deliberately NOT the raw state cap plus a shared-services
   * deduction: that breakdown is group information a state lead has no call to
   * see. The group cap never appears in a read-only payload at all.
   */
  available: number;
  utilPct: number;
  /** omitted server-side when the 'scale' pseudo-column is hidden */
  scale?: number;
  scaleLabel?: string;
}

export interface ReadonlyPayload {
  mode: "readonly";
  user: UserInfo;
  rows: ScopedRow[];
  visibleFields: NumericField[];
  /** display columns: config-visible AND scope-visible, in config order */
  columns: PayloadColumn[];
  showScale: boolean;
  /**
   * Editable wording, minus `poolTitles`. A read-only user's card titles are
   * resolved server-side into `poolCards[].title`, so sending the map as well
   * would ship them the names of pools they can't see ("NSW pool", "Group
   * total") — no figures, but it advertises views that aren't theirs.
   */
  copy: Omit<Copy, "poolTitles">;
  showStateColumn: boolean;
  poolCards: StatePoolCard[];
  cats: string[];
  depts: string[];
  mgrs: string[];
}

export interface EditorPayload {
  mode: "editor";
  user: UserInfo;
  employees: Employee[];
  overrides: Overrides;
  /** optimistic-concurrency token; saves carrying a stale value get 409 */
  overridesVersion: number;
  /** the same, for inline dataset edits (a separate document) */
  datasetVersion: number;
  /**
   * The company modifier already folded into `employees[].bipm` by
   * applyParams. The client divides by it before sending an edited After-IPM
   * figure, so what gets stored is the source value.
   */
  companyModifier: number;
  /** display columns: config-visible (editors are scope-visible on all) */
  columns: PayloadColumn[];
  /**
   * The whole stored config, hidden columns included — the column menu needs
   * to offer what isn't currently shown. Editors only; a read-only user gets
   * the resolved `columns` list and nothing more.
   */
  columnConfig: ColumnConfig;
  showScale: boolean;
  /** editable wording (presentation only — never gates data) */
  copy: Copy;
  /** editable on the pool cards; `caps` mirrors the first three */
  params: Params;
  caps: { vCap: number; nCap: number; gCap: number };
  cats: string[];
  depts: string[];
  mgrs: string[];
}

export type DashboardPayload = ReadonlyPayload | EditorPayload;
