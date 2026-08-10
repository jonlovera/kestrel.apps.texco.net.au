/**
 * The one remaining edit to the SOURCE dataset: After IPM, which the finance
 * owner calls "Bonus". Pure module — no I/O, no server-only imports.
 *
 * Everything else that used to live here is gone on purpose. Employee id,
 * package/REM and bonus % are read-only for everyone now, admin included: a
 * typo in one cascades through every calculation in the scheme. Names,
 * positions, states, pool splits and who exists at all come from the
 * spreadsheet import, which is the source of truth and the path that handles
 * terminations, promotions and new starters.
 *
 * After IPM survives as editable because it is the figure the engine actually
 * anchors on (lib/calc.ts derives each person's company modifier from it), and
 * it is the lever finance uses to move an individual allocation.
 */
import { z } from "zod";
import {
  EmployeeSchema,
  type Dataset,
  type Employee,
  type HistoryEntry,
} from "./schema";
import { fmt } from "./fmt";

export const DatasetPatchSchema = z.object({
  op: z.literal("field"),
  id: z.string().min(1),
  field: z.literal("bipm"),
  value: z.number().finite().min(0),
});
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

/**
 * Apply one After-IPM change. All-or-nothing: on a validation failure nothing
 * is changed and the error comes back in plain English.
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
  const updated: Employee = { ...existing, bipm: patch.value };

  const parsed = EmployeeSchema.safeParse(updated);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (i) => `'After IPM': ${i.message.toLowerCase()}`
      ),
    };
  }

  if (existing.bipm === patch.value) {
    return { ok: true, dataset: data, history: [] };
  }

  const emp = [...data.emp];
  emp[index] = updated;
  return {
    ok: true,
    // identity never changes here any more, so the filter lists can't move
    dataset: { ...data, emp },
    history: [
      {
        ts,
        actor,
        kind: "dataset",
        summary: `Set After IPM for ${existing.gn} ${existing.sn}: ${fmt(existing.bipm)} \u2192 ${fmt(patch.value)}`,
        empId: existing.id,
        field: "bipm",
        from: existing.bipm,
        to: patch.value,
      },
    ],
  };
}
