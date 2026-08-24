/**
 * Access-model types and field lists. No user config here — that lives in the
 * server-only lib/access.ts. Safe to import from client components.
 */

/**
 * Numeric/sensitive columns that `visibleFields` governs.
 *
 * `elig`, `totalPkg` and `potential` are the bonus build-up's new figures —
 * ordered here to match the build-up chain (Eligibility % → Total Package →
 * Eligible Salary → Bonus % → Potential Bonus → After IPM), since several
 * screens iterate this array directly to decide display order. `pkg` is
 * "Eligible Salary" — the figure that drives the calc — and `totalPkg` is
 * the separate, informational-only whole-of-package figure "Package" used
 * to mean before `pkg` took over that name.
 */
export const NUMERIC_FIELDS = [
  "elig",
  "totalPkg",
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
  // The VIC/NSW funding split. Admin-editable only (lib/dataset-edit.ts), but
  // visibility for everyone else still follows this list like any other
  // figure — and even then only populated where the cost actually divides
  // across the two pools, whatever the row's state.
  "vp",
  "np",
] as const;

export type NumericField = (typeof NUMERIC_FIELDS)[number];
