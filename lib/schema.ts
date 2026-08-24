import { z } from "zod";

/**
 * Data model derived from the prototype's master blob. Do not add fields the
 * source data doesn't have.
 */
export const EmployeeSchema = z.object({
  id: z.string().min(1),
  sn: z.string(), // surname
  gn: z.string(), // given name
  pos: z.string(), // position
  dept: z.string(), // department
  mgr: z.string(), // manager
  cat: z.string(), // category, e.g. 'Employee' | 'Texco Management'
  st: z.enum(["VIC", "NSW", "SHARED"]), // state
  vp: z.number().min(0).max(1), // VIC pool weight
  np: z.number().min(0).max(1), // NSW pool weight
  // The figure that drives the bonus calculation — sourced from "Eligible
  // Salary" in the real model, which is not the same figure as the "Total
  // FY26 Salary Package" a person is actually paid (totalPkg below). The two
  // can genuinely differ, and only this one feeds the calc engine.
  pkg: z.number().min(0),
  // Informational only, never used in the calc — the whole-of-package figure
  // "Package" used to mean before `pkg` above took over that name. Optional
  // because the flat import contract shouldn't suddenly require a column
  // nobody using it today has.
  totalPkg: z.number().min(0).optional(),
  // Informational only — never used in the calc, which works off `pkg`.
  // Optional for the same reason as totalPkg. No range constraint: a real
  // employee not eligible for a bonus this cycle can show a negative value
  // here (their Eligible Salary is 0, and the sheet's own eligibility-
  // proration formula isn't floored at zero for them) — confirmed against
  // real data across 12 real employees, all with Eligible Salary exactly 0.
  // Never computed against, only ever displayed, so nothing downstream is at
  // risk from a figure outside 0–1.
  elig: z.number().optional(),
  bp: z.number().min(0), // bonus % of package (fraction)
  ipm: z.number().min(0), // individual performance modifier (fraction)
  bipm: z.number(), // bonus after IPM $ (source figure; cpm derived from it)
  da: z.number(), // discretionary adjustment $
  f25: z.number(), // FY25 bonus $
  sm: z.union([z.literal(0), z.literal(1)]), // site manager: fixed bonus
});

export const BonusDataSchema = z.object({
  emp: z.array(EmployeeSchema).min(1),
  vCap: z.number().positive(),
  nCap: z.number().positive(),
  gCap: z.number().positive(),
  cats: z.array(z.string()),
  depts: z.array(z.string()),
  mgrs: z.array(z.string()),
  /**
   * Employee ids permanently excluded from the model — set once (or
   * gradually, one at a time), then honoured by every import after, not just
   * the one running when it was set. Lives on the dataset rather than a
   * separate document for exactly the reason the pool caps do: an import
   * replaces `emp` but carries everything else on the current dataset
   * forward (candidateDataset, lib/import-parse.ts), so this survives an
   * import the same way a cap does, with no separate persistence to reason
   * about. Defaulted so a dataset stored before this existed keeps parsing.
   */
  excludedIds: z.array(z.string()).default([]),
});

export type Employee = z.infer<typeof EmployeeSchema>;
export type BonusData = z.infer<typeof BonusDataSchema>;

// Preferred names going forward ("dataset" = employees + caps + filter lists).
export const DatasetSchema = BonusDataSchema;
export type Dataset = BonusData;

/** Per-employee edit state persisted by full-access users. */
export const EmployeeOverrideSchema = z.object({
  bpEdit: z.number().min(0).optional(),
  ipmEdit: z.number().min(0).optional(),
  // no floor: a discretionary adjustment may be negative (a deliberate
  // manual reduction that frees pool money back to the other unlocked rows)
  daEdit: z.number().optional(),
  locked: z.boolean().optional(),
  /** finalBonus frozen at the moment the row was locked */
  lockedFinal: z.number().optional(),
});

export const OverridesSchema = z.record(z.string(), EmployeeOverrideSchema);

export type EmployeeOverride = z.infer<typeof EmployeeOverrideSchema>;
export type Overrides = z.infer<typeof OverridesSchema>;

/** One "who did what and when" record shown on the History tab. */
export const HistoryEntrySchema = z.object({
  ts: z.string(), // ISO timestamp, server-side
  actor: z.string(), // email of the signed-in user who made the change
  kind: z.enum([
    "edit",
    "lock",
    // A discretionary grant, recorded separately from a plain "edit" because
    // it spends other people's bonuses: the entry carries the amount, the
    // headroom that bounded it and how many bonuses it reduced (see
    // lib/da-impact.ts and /api/state's grant log).
    "grant",
    "access",
    "restore",
    "params",
    "columns",
    "copy",
    "import",
    "dataset",
  ]),
  summary: z.string(), // human-readable sentence
  empId: z.string().optional(),
  target: z.string().optional(), // email affected by an access change
  /**
   * Set when the actor made this change from inside someone else's View as
   * (the act-as delegation). The change is still the actor's — this only
   * records whose dashboard they were standing on when they made it.
   */
  viewingAs: z.string().optional(),
  field: z.string().optional(),
  from: z.union([z.number(), z.string(), z.null()]).optional(),
  to: z.union([z.number(), z.string(), z.null()]).optional(),
});

export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

/**
 * A full point-in-time copy of everything mutable, taken before every
 * mutating action so any mistake can be reverted. `params`/`columns`/`copy`
 * are loosely typed here so an older snapshot still parses after their
 * schemas change; restore writes them back verbatim.
 */
export const SnapshotSchema = z.object({
  ts: z.string(),
  actor: z.string(),
  reason: z.string(),
  state: z.object({
    dataset: DatasetSchema,
    overrides: OverridesSchema,
    overridesVersion: z.number().int().optional(),
    params: z.unknown().nullable(),
    columns: z.unknown().nullable(),
    /** absent in snapshots taken before the wording became editable */
    copy: z.unknown().nullable().optional(),
    /**
     * The access-rule overlay (admin-managed grants). Absent in snapshots
     * taken before access joined the snapshot — the access API always
     * snapshotted before a change, but nothing access-shaped was ever stored,
     * so those restores silently could not undo an access change.
     */
    access: z.unknown().nullable().optional(),
  }),
});

export type Snapshot = z.infer<typeof SnapshotSchema>;
