/**
 * Access-model types and field lists. No user config here — that lives in the
 * server-only lib/access.ts. Safe to import from client components.
 */

/**
 * Numeric/sensitive columns that `visibleFields` governs.
 *
 * `elig` and `potential` are the bonus build-up's two new figures — ordered
 * here to match the build-up chain (Eligibility % → Package → Bonus % →
 * Potential bonus → After IPM), since several screens iterate this array
 * directly to decide display order.
 */
export const NUMERIC_FIELDS = [
  "elig",
  "pkg",
  "bp",
  "potential",
  "ipm",
  "bipm",
  "calc",
  "f25",
  "da",
  "yoy",
  "final",
  // Shared Services split. Admin-editable only (lib/dataset-edit.ts), but
  // visibility for everyone else still follows this list like any other
  // figure — and even then only ever populated for a Shared row.
  "vp",
  "np",
] as const;

export type NumericField = (typeof NUMERIC_FIELDS)[number];
