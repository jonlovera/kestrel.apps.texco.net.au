/**
 * The remaining edits to the SOURCE dataset: After IPM, which the finance
 * owner calls "Bonus", and the VIC/NSW split for Shared Services staff. Pure
 * module — no I/O, no server-only imports.
 *
 * Everything else that used to live here is gone on purpose. Employee id,
 * package/REM and bonus % are read-only for everyone now, admin included: a
 * typo in one cascades through every calculation in the scheme. Names,
 * positions, states and who exists at all come from the spreadsheet import,
 * which is the source of truth and the path that handles terminations,
 * promotions and new starters.
 *
 * After IPM survives as editable because it is the figure the engine actually
 * anchors on (lib/calc.ts derives each person's company modifier from it), and
 * it is the lever finance uses to move an individual allocation.
 *
 * The split is reopened, deliberately, for one reason: it moves real dollars
 * between the VIC and NSW pools rather than adjusting one person's own row,
 * which is why it is admin-only rather than routed through the overrides
 * mechanism IPM and Discretionary use — there is no "your own people" for a
 * cross-pool allocation. Editing one side derives the other, since a Shared
 * Services split always accounts for the whole of someone's bonus exposure.
 */
import { z } from "zod";
import {
  EmployeeSchema,
  type Dataset,
  type Employee,
  type HistoryEntry,
} from "./schema";
import { fmt, fmtPct } from "./fmt";

export const DatasetPatchSchema = z.discriminatedUnion("field", [
  z.object({
    op: z.literal("field"),
    id: z.string().min(1),
    field: z.literal("bipm"),
    value: z.number().finite().min(0),
  }),
  z.object({
    op: z.literal("field"),
    id: z.string().min(1),
    field: z.literal("vp"),
    value: z.number().finite().min(0).max(1),
  }),
  z.object({
    op: z.literal("field"),
    id: z.string().min(1),
    field: z.literal("np"),
    value: z.number().finite().min(0).max(1),
  }),
]);
export type DatasetPatch = z.infer<typeof DatasetPatchSchema>;

export type DatasetPatchResult =
  | { ok: true; dataset: Dataset; history: HistoryEntry[] }
  | { ok: false; errors: string[] };

/**
 * The dataset's filter lists, derived from whoever is in it. Still used by
 * lib/import-parse.ts, which is now the only thing that changes who exists.
 */
export function deriveFacets(
  employees: Employee[]
): Pick<Dataset, "cats" | "depts" | "mgrs"> {
  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  return {
    cats: uniq(employees.map((e) => e.cat)),
    depts: uniq(employees.map((e) => e.dept)),
    mgrs: uniq(employees.map((e) => e.mgr)),
  };
}

/** Human labels for the history entry and any validation error. */
const FIELD_LABEL: Record<DatasetPatch["field"], string> = {
  bipm: "After IPM",
  vp: "VIC %",
  np: "NSW %",
};

/**
 * Apply one change to the source dataset. All-or-nothing: on a validation
 * failure nothing is changed and the error comes back in plain English.
 */
export function applyDatasetPatch(
  data: Dataset,
  patch: DatasetPatch,
  actor: string,
  ts: string
): DatasetPatchResult {
  const index = data.emp.findIndex((e) => e.id === patch.id);
  if (index < 0) {
    return { ok: false, errors: [`No employee with id '${patch.id}'.`] };
  }
  const existing = data.emp[index];
  const label = FIELD_LABEL[patch.field];

  if (patch.field === "vp" || patch.field === "np") {
    // The split is meaningless outside Shared Services: a VIC or NSW employee
    // is already 100% one pool, and there is nothing to reallocate.
    if (existing.st !== "SHARED") {
      return {
        ok: false,
        errors: [`'${label}': only set for Shared Services employees.`],
      };
    }
  }

  const updated: Employee =
    patch.field === "bipm"
      ? { ...existing, bipm: patch.value }
      : patch.field === "vp"
        ? { ...existing, vp: patch.value, np: round4(1 - patch.value) }
        : { ...existing, np: patch.value, vp: round4(1 - patch.value) };

  const parsed = EmployeeSchema.safeParse(updated);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `'${label}': ${i.message.toLowerCase()}`),
    };
  }

  if (existing[patch.field] === patch.value) {
    return { ok: true, dataset: data, history: [] };
  }

  const emp = [...data.emp];
  emp[index] = updated;
  const from = existing[patch.field];
  const summary =
    patch.field === "bipm"
      ? `Set After IPM for ${existing.gn} ${existing.sn}: ${fmt(from)} \u2192 ${fmt(patch.value)}`
      : `Set ${label} for ${existing.gn} ${existing.sn}: ${fmtPct(from)} \u2192 ${fmtPct(patch.value)} (${patch.field === "vp" ? "NSW" : "VIC"} % follows automatically)`;
  return {
    ok: true,
    // identity never changes here any more, so the filter lists can't move
    dataset: { ...data, emp },
    history: [
      {
        ts,
        actor,
        kind: "dataset",
        summary,
        empId: existing.id,
        field: patch.field,
        from,
        to: patch.value,
      },
    ],
  };
}

/** Avoid float residue like 0.30000000000000004 from `1 - value`. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
