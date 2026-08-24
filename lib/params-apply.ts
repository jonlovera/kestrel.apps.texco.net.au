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
   * "Always redistribute" — whether a discretionary amount is funded FROM the
   * capped pool (so it moves the pool scale and every other unlocked row
   * reflows) or sits ON TOP of it (absent/false: the money a reduction frees
   * is just room left under the cap, and nobody else moves). See the
   * DISCRETIONARY UPDATE note in lib/calc.ts.
   *
   * It lives on Params rather than the dataset because applyParams is already
   * the one place caps reach both the server pipeline and the dashboard's live
   * recalc — so the browser, /api/state's validation and every user cannot
   * disagree about which funding model is in force. Optional, absent = off, so
   * every stored params document keeps today's behaviour.
   */
  redistribute: z.boolean().optional(),
});
export type Params = z.infer<typeof ParamsSchema>;

/** Defaults = the dataset's own caps and the measured modifier of 1.0. */
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
    redistribute: params.redistribute,
  };
}
