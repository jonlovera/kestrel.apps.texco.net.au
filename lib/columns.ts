/**
 * Presentation configuration for the dashboard's numeric columns — pure
 * module (schema, defaults, merge logic), no I/O.
 *
 * Presentation and entitlement are deliberately separate concerns:
 *  - this config decides what is DISPLAYED (pixels),
 *  - lib/scope-core.ts decides what is SENT (bytes).
 * `effectiveColumns` composes them: a column appears only when it is both
 * config-visible and scope-visible; but hiding a column here never grants
 * or removes data — stripping stays authoritative in scope-core.
 */
import { z } from "zod";
import { NUMERIC_FIELDS, type NumericField } from "./access-types";

export const COLUMN_FORMATS = ["currency", "percent", "number"] as const;
export type ColumnFormat = (typeof COLUMN_FORMATS)[number];

/** 'scale' is a pseudo-column gating the scale-factor figure on pool cards. */
export const CONFIGURABLE_FIELDS = [...NUMERIC_FIELDS, "scale"] as const;
export type ConfigurableField = (typeof CONFIGURABLE_FIELDS)[number];

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

/** Today's exact labels and formats — first load must look identical. */
export const DEFAULT_COLUMNS: ColumnConfig = [
  { field: "pkg", visible: true, label: "Package", format: "currency", decimals: 0 },
  { field: "bp", visible: true, label: "Bonus%", format: "percent", decimals: 0 },
  { field: "ipm", visible: true, label: "IPM%", format: "percent", decimals: 0 },
  { field: "bipm", visible: true, label: "After IPM", format: "currency", decimals: 0 },
  { field: "calc", visible: true, label: "Calc bonus", format: "currency", decimals: 0 },
  { field: "f25", visible: true, label: "FY25 bonus", format: "currency", decimals: 0 },
  { field: "da", visible: true, label: "Disc adj", format: "currency", decimals: 0 },
  { field: "yoy", visible: true, label: "YoY diff", format: "currency", decimals: 0 },
  { field: "final", visible: true, label: "Final", format: "currency", decimals: 0 },
  { field: "scale", visible: true, label: "Scale factor", format: "number", decimals: 4 },
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
  key: NumericField;
  label: string;
  format: ColumnFormat;
  decimals: number;
}

/**
 * Columns a user's table shows: config order, config-visible AND
 * scope-visible. Never introduces a field the scope didn't grant.
 */
export function effectiveColumns(
  config: ColumnConfig,
  scopeVisibleFields: readonly NumericField[]
): PayloadColumn[] {
  const scoped = new Set(scopeVisibleFields);
  return normalizeConfig(config)
    .filter(
      (c): c is ColumnConfigEntry & { field: NumericField } =>
        c.field !== "scale" && c.visible && scoped.has(c.field as NumericField)
    )
    .map((c) => ({
      key: c.field,
      label: c.label,
      format: c.format,
      decimals: c.decimals,
    }));
}

/** Whether pool cards show the scale-factor figure. */
export function scaleVisible(config: ColumnConfig): boolean {
  return normalizeConfig(config).find((c) => c.field === "scale")!.visible;
}
