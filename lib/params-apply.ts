/**
 * Scheme-wide parameters and how they feed the (frozen) calc engine — pure
 * module shared by the server pipeline and the dashboard's live recalc,
 * so there is exactly one code path for the maths.
 *
 * lib/calc.ts derives each employee's cpm from the source `bipm` figure and
 * is not modified. The company-wide modifier therefore feeds in by scaling
 * the `bipm` INPUT: bipm' = bipm × companyModifier scales every derived cpm
 * proportionally while preserving the per-row service fractions embedded in
 * the source data. The measured status quo is a modifier of exactly 1.0
 * (see docs in the repo history), so the default is the identity and the
 * golden outputs are unchanged.
 */
import { z } from "zod";
import type { Employee, Dataset } from "./schema";
import type { Scope } from "./access";

export const ParamsSchema = z.object({
  vCap: z.number().positive().max(50_000_000),
  nCap: z.number().positive().max(50_000_000),
  gCap: z.number().positive().max(100_000_000),
  companyModifier: z.number().min(0.1).max(2),
  /**
   * THE PERSISTED SCALE FACTORS (owner decision, 27 August 2026).
   *
   * Written only by /api/recalculate, from lib/recalculate.ts, and read by the
   * engine through Caps (lib/calc.ts). They live on the params document rather
   * than anywhere else for three reasons: this is already where the pool caps
   * and the company modifier live, so scheme-wide parameters stay in one place;
   * it is already snapshotted and restorable (SnapshotSchema.state.params); and
   * clearParams() already means "fall back to derived", which is exactly the
   * state the scheme is in before anybody has pressed Recalculate.
   *
   * Optional because every params document stored before this existed has no
   * scale, and absent has a precise meaning: no authoritative scale yet, so the
   * engine derives an advisory one for display and lib/reprice.ts re-prices no
   * pooled payout at all.
   *
   * Bounded to [0, 1] by the same reasoning as clampScale: an oversubscribed
   * pool scales down, an under-subscribed one is not scaled up past full
   * entitlement.
   */
  vicScale: z.number().min(0).max(1).optional(),
  nswScale: z.number().min(0).max(1).optional(),
});
export type Params = z.infer<typeof ParamsSchema>;

/**
 * Defaults = the dataset's own caps and the measured modifier of 1.0. No
 * scales: a scheme that has never been recalculated has no stored scale, which
 * is the honest default and the one the engine reads as "derive for display".
 */
export function defaultParams(caps: {
  vCap: number;
  nCap: number;
  gCap: number;
}): Params {
  return {
    vCap: caps.vCap,
    nCap: caps.nCap,
    gCap: caps.gCap,
    companyModifier: 1,
  };
}

/**
 * Whether this scope may change the pool caps themselves — its own grant
 * (`canEditCaps`), not implied by full access. Full access still lets
 * someone change the company modifier through the same route; this only
 * decides the caps. One place the decision lives so the API route and its
 * tests agree, the same way lib/write-scope.ts keeps write authorisation out
 * of the route handler itself.
 */
export function canChangeCaps(scope: Scope): boolean {
  return scope.rule.type === "full" && scope.rule.canEditCaps === true;
}

/** A dollar of tolerance: the caps carry cents, and floats carry noise. */
export const CAP_SUM_TOLERANCE = 1;

/**
 * The group cap is the sum of the two state caps (FY26: 2,959,288.48 =
 * 1,593,574.32 + 1,365,714.16). Null when vCap + nCap agrees with gCap to
 * within a dollar; otherwise the sentence /api/params puts in its history
 * line and its response. A warning and never a refusal — the card editors
 * commit one field at a time, so a legitimate correction is necessarily
 * mid-way inconsistent for one save. Here rather than in the route so the
 * rule is testable without a request.
 */
export function capsWarning(p: { vCap: number; nCap: number; gCap: number }): string | null {
  const gap = p.vCap + p.nCap - p.gCap;
  if (Math.abs(gap) <= CAP_SUM_TOLERANCE) return null;
  const f = (n: number) => Math.round(n).toLocaleString("en-AU");
  return `VIC + NSW caps (${f(p.vCap + p.nCap)}) differ from the group cap (${f(p.gCap)}) by ${f(gap)}`;
}

/**
 * Produce the effective dataset the calc engine sees. Identity when the
 * modifier is 1 (same employee objects, bit-identical figures).
 */
export function applyParams(data: Dataset, params: Params): Dataset {
  const emp: Employee[] =
    params.companyModifier === 1
      ? data.emp
      : data.emp.map((e) => ({ ...e, bipm: e.bipm * params.companyModifier }));
  return {
    ...data,
    emp,
    vCap: params.vCap,
    nCap: params.nCap,
    gCap: params.gCap,
    // Undefined when nothing has been recalculated yet, and undefined is the
    // value the engine wants — it is what selects the derived fallback.
    vicScale: params.vicScale,
    nswScale: params.nswScale,
  };
}
