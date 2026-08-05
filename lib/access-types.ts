/**
 * Access-model types and field lists. No user config here — that lives in the
 * server-only lib/access.ts. Safe to import from client components.
 */

/** Numeric/sensitive columns that `visibleFields` governs. */
export const NUMERIC_FIELDS = [
  "pkg",
  "bp",
  "ipm",
  "bipm",
  "calc",
  "f25",
  "da",
  "yoy",
  "final",
] as const;

export type NumericField = (typeof NUMERIC_FIELDS)[number];
