/**
 * Scheme-wide parameters and how they feed the (frozen) calc engine — pure
 * module shared by the server pipeline and the /admin/params live preview,
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

export const ParamsSchema = z.object({
  vCap: z.number().positive().max(50_000_000),
  nCap: z.number().positive().max(50_000_000),
  gCap: z.number().positive().max(100_000_000),
  companyModifier: z.number().min(0.1).max(2),
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
  };
}
