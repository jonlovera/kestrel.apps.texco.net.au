/**
 * Presentation configuration for the dashboard's table columns — pure
 * module (schema, defaults, merge logic), no I/O.
 *
 * Presentation and entitlement are deliberately separate concerns:
 *  - this config decides what is DISPLAYED (pixels),
 *  - lib/scope-core.ts decides what is SENT (bytes).
 * `effectiveColumns` composes them: a figure column appears only when it is
 * both config-visible and scope-visible; but hiding a column here never grants
 * or removes data — stripping stays authoritative in scope-core.
 *
 * Two groups, gated differently:
 *  - IDENTITY_FIELDS are on every row a user is entitled to see at all
 *    (lib/scope-core.ts builds them unconditionally), so they were never
 *    governed by `visibleFields`. Config visibility is the only gate, and
 *    hiding one removes pixels, not bytes.
 *  - NUMERIC_FIELDS are the entitlement vocabulary. Config can only ever
 *    narrow what the scope already granted, never widen it.
 */
import { z } from "zod";
import { NUMERIC_FIELDS, type NumericField } from "./access-types";

export const COLUMN_FORMATS = ["currency", "percent", "number", "text"] as const;
export type ColumnFormat = (typeof COLUMN_FORMATS)[number];

/** Non-sensitive columns, present on every entitled row. */
export const IDENTITY_FIELDS = ["name", "state", "pos", "dept", "mgr", "cat"] as const;
export type IdentityField = (typeof IDENTITY_FIELDS)[number];

export const CONFIGURABLE_FIELDS = [
  ...IDENTITY_FIELDS,
  ...NUMERIC_FIELDS,
] as const;
export type ConfigurableField = (typeof CONFIGURABLE_FIELDS)[number];

const IDENTITY_SET = new Set<string>(IDENTITY_FIELDS);
export const isIdentityField = (f: string): f is IdentityField =>
  IDENTITY_SET.has(f);

export const ColumnConfigEntrySchema = z.object({
  field: z.enum(CONFIGURABLE_FIELDS),
  visible: z.boolean(),
  label: z.string().trim().min(1).max(40),
  format: z.enum(COLUMN_FORMATS),
  decimals: z.number().int().min(0).max(6),
});
export type ColumnConfigEntry = z.infer<typeof ColumnConfigEntrySchema>;

export const ColumnConfigSchema = z
  .array(ColumnConfigEntrySchema)
  .max(CONFIGURABLE_FIELDS.length)
  .refine(
    (arr) => new Set(arr.map((c) => c.field)).size === arr.length,
    "duplicate field in column config"
  );
export type ColumnConfig = z.infer<typeof ColumnConfigSchema>;

/** Today's exact labels, order and formats — first load must look identical. */
export const DEFAULT_COLUMNS: ColumnConfig = [
  { field: "name", visible: true, label: "Name", format: "text", decimals: 0 },
  { field: "state", visible: true, label: "State", format: "text", decimals: 0 },
  { field: "pos", visible: true, label: "Position", format: "text", decimals: 0 },
  { field: "dept", visible: true, label: "Department", format: "text", decimals: 0 },
  { field: "mgr", visible: true, label: "Manager", format: "text", decimals: 0 },
  // present in the source data and editable, but not shown by default — the
  // prototype's table never had a Category column
  { field: "cat", visible: false, label: "Category", format: "text", decimals: 0 },
  // The bonus build-up, in reconciliation order — see BUILDUP_FIELDS below.
  { field: "elig", visible: true, label: "Eligibility %", format: "percent", decimals: 0 },
  { field: "pkg", visible: true, label: "Package", format: "currency", decimals: 0 },
  { field: "bp", visible: true, label: "Bonus%", format: "percent", decimals: 0 },
  { field: "potential", visible: true, label: "Potential Bonus", format: "currency", decimals: 0 },
  { field: "ipm", visible: true, label: "IPM%", format: "percent", decimals: 0 },
  { field: "bipm", visible: true, label: "After IPM", format: "currency", decimals: 0 },
  { field: "calc", visible: true, label: "Calc bonus", format: "currency", decimals: 0 },
  { field: "f25", visible: true, label: "FY25 Bonus (Paid)", format: "currency", decimals: 0 },
  { field: "da", visible: true, label: "Discretionary", format: "currency", decimals: 0 },
  { field: "yoy", visible: true, label: "YoY Change", format: "currency", decimals: 0 },
  { field: "final", visible: true, label: "FY26 Bonus (Final)", format: "currency", decimals: 0 },
  // Admin-editable, Shared Services rows only — see lib/dataset-edit.ts.
  { field: "vp", visible: true, label: "VIC %", format: "percent", decimals: 0 },
  { field: "np", visible: true, label: "NSW %", format: "percent", decimals: 0 },
];

/**
 * The bonus build-up: figures that reconcile left to right into "After IPM".
 * Eligibility % and Potential Bonus are the two genuinely new figures here —
 * Package, Bonus % and After IPM already existed and simply join the group.
 *
 * A plain constant, not a field on ColumnConfigEntry: which columns are
 * visible is the shared, multi-user document (this file); whether the GROUP
 * is currently expanded is a client-side, per-browser UI preference
 * (localStorage) that never touches that document. Keeping them separate
 * means there is no migration to reason about here.
 */
export const BUILDUP_FIELDS: readonly NumericField[] = [
  "elig",
  "pkg",
  "bp",
  "potential",
  "bipm",
];

/** Ensure every configurable field appears exactly once (missing → default). */
export function normalizeConfig(config: ColumnConfig): ColumnConfig {
  const seen = new Set<string>();
  const out: ColumnConfig = [];
  for (const entry of config) {
    if (!seen.has(entry.field)) {
      seen.add(entry.field);
      out.push(entry);
    }
  }
  for (const def of DEFAULT_COLUMNS) {
    if (!seen.has(def.field)) out.push(def);
  }
  return out;
}

/** What one payload column looks like on the wire. */
export interface PayloadColumn {
  key: NumericField | IdentityField;
  label: string;
  format: ColumnFormat;
  decimals: number;
  /** identity columns are text, always sent, and never scope-gated */
  identity?: true;
}

/**
 * Columns a user's table shows: config order, config-visible, and — for the
 * figure columns only — scope-visible. Never introduces a figure the scope
 * didn't grant.
 */
export function effectiveColumns(
  config: ColumnConfig,
  scopeVisibleFields: readonly NumericField[]
): PayloadColumn[] {
  const scoped = new Set<string>(scopeVisibleFields);
  const out: PayloadColumn[] = [];
  for (const c of normalizeConfig(config)) {
    if (!c.visible) continue;
    if (isIdentityField(c.field)) {
      out.push({
        key: c.field,
        label: c.label,
        format: c.format,
        decimals: c.decimals,
        identity: true,
      });
    } else if (scoped.has(c.field)) {
      out.push({
        key: c.field as NumericField,
        label: c.label,
        format: c.format,
        decimals: c.decimals,
      });
    }
  }
  return out;
}

/**
 * Configs stored before a field was retired (the scale-factor pseudo-column)
 * still live in the database. Dropping them here rather than letting the
 * schema reject the whole document means a retired field costs one column, not
 * every column setting she has ever chosen.
 */
/**
 * Labels that were renamed after configs had already been saved with the old
 * one. Only an untouched old default is migrated — if she has deliberately
 * renamed a column, that name is hers and stays.
 */
const RENAMED_DEFAULTS: Record<string, [string, string]> = {
  // "Disc adj" read as finance jargon to everyone else using the tool
  da: ["Disc adj", "Discretionary"],
  // The two bonus figures being compared needed to read as a matched pair,
  // naming which is the historical (paid) one and which is the proposed
  // (calculated) one.
  f25: ["FY25 bonus", "FY25 Bonus (Paid)"],
  final: ["Final", "FY26 Bonus (Final)"],
  yoy: ["YoY diff", "YoY Change"],
};

export function migrateRenamedLabels(config: ColumnConfig): ColumnConfig {
  return config.map((c) => {
    const rename = RENAMED_DEFAULTS[c.field];
    return rename && c.label === rename[0] ? { ...c, label: rename[1] } : c;
  });
}

export function dropRetiredFields(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  const known = new Set<string>(CONFIGURABLE_FIELDS);
  return raw.filter(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      known.has(String((entry as { field?: unknown }).field))
  );
}
