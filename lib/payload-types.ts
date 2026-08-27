/**
 * Types for the data that crosses the server → client boundary.
 * Types only — no runtime code, safe to import anywhere.
 */
import type { Employee, Overrides } from "./schema";
import type { NumericField } from "./access-types";
import type { ColumnConfig, PayloadColumn } from "./columns";
import type { Copy } from "./copy";
import type { Params } from "./params-apply";
import type { ManagerPool } from "./manager-pool";

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
  /**
   * Set once this row's bonus has been ISSUED — the committed amount, with who
   * issued it and when. Present = the figure cannot move again, so every
   * control on the row goes read-only and the Final column is this number.
   * Absent = not issued, which is what everything tests for.
   *
   * Sent to leads as well as admins: an issued row must render as issued to
   * whoever is looking at it, or they will try to edit a cell the server will
   * refuse. It carries no figure a scope was not already entitled to — the
   * amount IS the Final bonus, and a scope that cannot see Final has the field
   * stripped along with it (lib/scope-core.ts).
   */
  issued?: {
    /**
     * The committed Final bonus. Optional on the wire only: it IS the row's
     * Final figure, so a scope not entitled to see Final does not get it here
     * either — they still see THAT the row is issued, which is what stops them
     * typing into a cell the server will refuse.
     */
    amount?: number;
    at: string;
    by: string;
  };
  /** whether the row participates in any pool (drives the DA '—' rendering) */
  inPool: boolean;
  /**
   * Whether this row's payout counts against the pool the header measures —
   * false for a carve-funded VIC/NSW row under a state-pool budget (a
   * part-split person, whose money the pool is already net of). The header's
   * Allocated, the discretionary ceiling and the redistribution budget all skip
   * such a row; the table still lists it. Decided server-side
   * (lib/manager-pool.ts's countsAgainstPool) because the split itself is not
   * sent to a lead.
   */
  inHomeTotal: boolean;
  elig?: number;
  totalPkg?: number;
  pkg?: number;
  bp?: number;
  potential?: number;
  ipm?: number;
  bipm?: number;
  calc?: number;
  f25?: number;
  da?: number;
  yoy?: number;
  final?: number;
  /** the VIC/NSW funding split where there is one, admin-editable,
   *  informational elsewhere; absent on a whole-pool row */
  vp?: number;
  np?: number;
}

/**
 * The unified row the table renders in both modes. Editors get the extra pool
 * weights; read-only users get exactly their `ScopedRow`.
 */
export interface DisplayRow extends ScopedRow {
  /** the source name halves, so edit mode can write them back separately */
  gn?: string;
  sn?: string;
}

export interface ReadonlyPayload {
  mode: "readonly";
  user: UserInfo;
  rows: ScopedRow[];
  visibleFields: NumericField[];
  /** display columns: config-visible AND scope-visible, in config order */
  columns: PayloadColumn[];
  /**
   * Editable wording, minus `poolTitles`. A read-only user's header names
   * their OWN pool ("Your pool", "Allocated", "Remaining", "People in scope")
   * with fixed labels, so the map would only ship them the names of pools they
   * can't see ("NSW pool", "Group total") — no figures, but it advertises
   * views that aren't theirs.
   */
  copy: Omit<Copy, "poolTitles">;
  /**
   * Table columns this user may type into — IPM and Discretionary for a state
   * lead, empty for anyone purely read-only. Presentation only: the server
   * decides again on every write (lib/write-scope.ts).
   */
  canEditFields: string[];
  /**
   * Whether this user may lock/unlock a row at all, independent of
   * `canEditFields` — a purely read-only lead can hold this, and a lead who
   * may edit a figure need not. lib/write-scope.ts decides again on every
   * write, same as `canEditFields`.
   */
  canLock: boolean;
  /**
   * Whether this user may download a locked person's remuneration letter.
   * Its own grant, held by admins and leads alike or by neither — see
   * `canDownloadLetter` in lib/access-rules.ts. /api/letter decides again on
   * every request; this only says whether the control is rendered live.
   */
  canDownloadLetter: boolean;
  /**
   * The stored overrides narrowed to this scope's writable window (their
   * rows, their fields) — see scopeOverridesView. Without a real baseline,
   * a lead's first save would read as "cleared everything else in my scope"
   * (sanitiseOverrideWrite treats an omitted in-scope id as cleared). Empty
   * for a purely read-only scope.
   */
  overrides: Overrides;
  /** optimistic-concurrency token; saves carrying a stale value get 409 */
  overridesVersion: number;
  showStateColumn: boolean;
  /**
   * This manager's own pool, allocation, headroom and headcount — the four
   * header cards. Replaces the old `poolCards`, which handed a scoped lead a
   * whole-STATE figure (and dropped any in-scope shared-services row from it)
   * regardless of how small a slice of that state they were accountable for.
   */
  managerPool: ManagerPool;
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
  /** editable wording (presentation only — never gates data) */
  copy: Copy;
  /** editable on the pool cards, for admins holding `canEditCaps`; `caps` mirrors the first three */
  params: Params;
  caps: { vCap: number; nCap: number; gCap: number };
  /**
   * Whether this admin may press Recalculate — its own grant, not implied by
   * full access (lib/write-scope.ts's canRecalculatePool), because one press
   * re-derives the Scale Factor and re-bases every eligible payout in the
   * scheme. /api/recalculate decides again on every request; this only governs
   * whether the button is rendered.
   */
  canRecalculatePool: boolean;
  /**
   * Whether this admin may revert an issued bonus back to locked — its own
   * grant, deliberately not implied by the ability to issue one
   * (lib/write-scope.ts's canRevokeIssued). /api/issue's DELETE decides again
   * on every request; this only governs whether the control is rendered.
   */
  canRevokeIssued: boolean;
  /**
   * Whether this admin may actually change the pool caps — its own grant,
   * not implied by full access. lib/api-guard.ts + lib/params-apply.ts
   * decide again on every write; this only governs whether the cap on each
   * pool card renders as an input.
   */
  canEditCaps: boolean;
  /**
   * Whether this admin may lock/unlock and adjust the VIC site managers — its
   * own grant, not implied by full access (lib/write-scope.ts's
   * canAdjustVicSiteManagers). /api/state decides again on every write; this
   * only governs whether those sixteen rows' Lock, IPM and Discretionary cells
   * render as controls.
   */
  canEditVicSiteManagers: boolean;
  /**
   * Whether this admin may download a locked person's remuneration letter —
   * its own grant, and deliberately NOT implied by full access, for the same
   * reason `canEditCaps` is not. /api/letter decides again on every request.
   */
  canDownloadLetter: boolean;
  cats: string[];
  depts: string[];
  mgrs: string[];
}

export type DashboardPayload = ReadonlyPayload | EditorPayload;
