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
  pkg: z.number().min(0), // salary package $
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
  daEdit: z.number().min(0).optional(),
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
    /** absent in snapshots taken before /admin/text existed */
    copy: z.unknown().nullable().optional(),
  }),
});

export type Snapshot = z.infer<typeof SnapshotSchema>;
