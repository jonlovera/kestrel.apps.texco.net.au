/**
 * Inline edits to the SOURCE dataset — pure module (no I/O, no server-only),
 * so it is unit-testable and the API route stays thin.
 *
 * Two write paths edit an employee, and they are deliberately different:
 *
 *  - lib/calc.ts overrides (Bonus%, IPM%, Disc adj, locks) are the manager's
 *    judgement. They live in their own document and SURVIVE a spreadsheet
 *    import.
 *  - the fields here (Package, After IPM, FY25 bonus, the pool split, the
 *    site-manager flag, and who exists at all) are payroll facts. They live in
 *    the dataset and are REPLACED by the next spreadsheet import — the
 *    spreadsheet stays the source of truth. The UI says so.
 *
 * Every patch is validated against EmployeeSchema, so the bounds in
 * lib/schema.ts (vp/np 0..1, sm 0|1, non-negative money) apply here for free.
 */
import { z } from "zod";
import {
  EmployeeSchema,
  type Dataset,
  type Employee,
  type Overrides,
  type HistoryEntry,
} from "./schema";
import { fmt, fmtPctWhole } from "./fmt";

/** Single-value fields editable straight from a table cell. */
export const EDITABLE_DATASET_FIELDS = ["pkg", "bipm", "f25", "sm"] as const;
export type EditableDatasetField = (typeof EDITABLE_DATASET_FIELDS)[number];

const FIELD_LABELS: Record<EditableDatasetField, string> = {
  pkg: "Package",
  bipm: "After IPM",
  f25: "FY25 bonus",
  sm: "Site manager",
};

const showField = (field: EditableDatasetField, v: number): string =>
  field === "sm" ? (v ? "yes" : "no") : fmt(v);

export const DatasetPatchSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("field"),
    id: z.string().min(1),
    field: z.enum(EDITABLE_DATASET_FIELDS),
    value: z.number().finite(),
  }),
  // vp and np move together: either alone would transiently break the
  // "weights sum to 1" invariant and be rejected.
  z.object({
    op: z.literal("split"),
    id: z.string().min(1),
    vp: z.number().min(0).max(1),
    np: z.number().min(0).max(1),
  }),
  z.object({ op: z.literal("add"), employee: EmployeeSchema }),
  z.object({ op: z.literal("remove"), id: z.string().min(1) }),
]);
export type DatasetPatch = z.infer<typeof DatasetPatchSchema>;

export type DatasetPatchResult =
  | {
      ok: true;
      dataset: Dataset;
      overrides: Overrides;
      /** true when a removal pruned the overrides doc and it must be saved */
      overridesChanged: boolean;
      history: HistoryEntry[];
    }
  | { ok: false; errors: string[] };

/** The dataset's filter lists, derived from whoever is in it. */
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

const EPS = 1e-9;

/**
 * Pool weights must sum to exactly 1 (in the pool) or exactly 0 (not in it),
 * and match the employee's state — every one of the 155 source rows does. A
 * partial sum would quietly allocate part of a bonus to no state pool: it
 * would still count towards the group total but against neither state cap.
 */
function checkSplit(e: Employee): string | null {
  const name = `${e.gn} ${e.sn}`;
  const sum = e.vp + e.np;
  if (Math.abs(sum) > EPS && Math.abs(sum - 1) > EPS) {
    return `${name}: the VIC and NSW shares must add up to 100% (or both be 0% for someone outside the pools) — they currently add up to ${fmtPctWhole(sum)}.`;
  }
  if (e.st === "VIC" && e.np > EPS)
    return `${name} is in VIC, so their NSW share must be 0%.`;
  if (e.st === "NSW" && e.vp > EPS)
    return `${name} is in NSW, so their VIC share must be 0%.`;
  if (e.st === "SHARED" && Math.abs(sum - 1) < EPS && (e.vp <= EPS || e.np <= EPS))
    return `${name} is shared services, so both the VIC and NSW shares must be above 0%.`;
  return null;
}

/** Validate one employee record fully (schema bounds + pool invariants). */
function validateEmployee(candidate: Employee): string[] {
  const parsed = EmployeeSchema.safeParse(candidate);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => {
      const field = String(i.path[0] ?? "");
      const label =
        FIELD_LABELS[field as EditableDatasetField] ?? (field || "value");
      return `'${label}': ${i.message.toLowerCase()}`;
    });
  }
  const splitError = checkSplit(parsed.data);
  return splitError ? [splitError] : [];
}

/**
 * A package edit carries After IPM with it, pro rata.
 *
 * The frozen engine reverse-derives each employee's company modifier from
 * their After-IPM figure — cpm = bipm / (pkg * bp * ipm), lib/calc.ts:71 —
 * and then recomputes preIpm = pkg * bp * cpm. The pkg terms cancel, so
 * editing Package ALONE moves the bonus by exactly zero: After IPM is the
 * real anchor. Scaling bipm by the same ratio keeps cpm identical and makes
 * a pay rise raise the bonus proportionally, which is what "change their
 * package" is meant to do. A package of 0 has no ratio, so bipm is left be.
 *
 * Rounded to cents, matching the source data's own precision — otherwise
 * floating-point residue (54000 × 1.1 = 59400.00000000001) leaks into the
 * stored figures and into any spreadsheet reconciliation.
 */
function scaledBipm(e: Employee, newPkg: number): number {
  if (e.pkg <= 0) return e.bipm;
  return Math.round(e.bipm * (newPkg / e.pkg) * 100) / 100;
}

const entry = (
  actor: string,
  ts: string,
  summary: string,
  rest: Partial<HistoryEntry> = {}
): HistoryEntry => ({ ts, actor, kind: "dataset", summary, ...rest });

/**
 * Apply one patch to the dataset. All-or-nothing: on any validation failure
 * nothing is changed and the errors come back in plain English.
 */
export function applyDatasetPatch(
  data: Dataset,
  patch: DatasetPatch,
  overrides: Overrides,
  actor: string,
  ts: string
): DatasetPatchResult {
  const index = data.emp.findIndex(
    (e) => e.id === ("id" in patch ? patch.id : patch.employee.id)
  );
  const existing = index >= 0 ? data.emp[index] : null;
  const name = (e: Employee) => `${e.gn} ${e.sn}`;

  if (patch.op === "add") {
    if (existing) {
      return {
        ok: false,
        errors: [
          `Employee id '${patch.employee.id}' already exists (${name(existing)}).`,
        ],
      };
    }
    const errors = validateEmployee(patch.employee);
    if (errors.length > 0) return { ok: false, errors };

    const emp = [...data.emp, patch.employee];
    return {
      ok: true,
      dataset: { ...data, emp, ...deriveFacets(emp) },
      overrides,
      overridesChanged: false,
      history: [
        entry(
          actor,
          ts,
          `Added ${name(patch.employee)} (${patch.employee.pos}, ${patch.employee.dept}, ${patch.employee.st}) with a package of ${fmt(patch.employee.pkg)}`,
          { empId: patch.employee.id, to: patch.employee.id }
        ),
      ],
    };
  }

  if (!existing) {
    return { ok: false, errors: [`No employee with id '${patch.id}'.`] };
  }

  if (patch.op === "remove") {
    const emp = data.emp.filter((e) => e.id !== patch.id);
    // an override left behind would silently reapply if the id came back
    const hadOverride = Object.keys(overrides[patch.id] ?? {}).length > 0;
    const { [patch.id]: _removed, ...survivingOverrides } = overrides;
    void _removed;
    return {
      ok: true,
      dataset: { ...data, emp, ...deriveFacets(emp) },
      overrides: survivingOverrides,
      overridesChanged: patch.id in overrides,
      history: [
        entry(
          actor,
          ts,
          `Removed ${name(existing)}${hadOverride ? " and their entered figures" : ""}`,
          { empId: patch.id, from: patch.id }
        ),
      ],
    };
  }

  const updated: Employee =
    patch.op === "split"
      ? { ...existing, vp: patch.vp, np: patch.np }
      : patch.op === "field" && patch.field === "pkg"
        ? { ...existing, pkg: patch.value, bipm: scaledBipm(existing, patch.value) }
        : { ...existing, [patch.field]: patch.value };

  const errors = validateEmployee(updated);
  if (errors.length > 0) return { ok: false, errors };

  const history: HistoryEntry[] = [];
  if (patch.op === "field" && patch.field === "pkg") {
    if (existing.pkg !== updated.pkg) {
      history.push(
        entry(
          actor,
          ts,
          `Set Package for ${name(existing)}: ${fmt(existing.pkg)} → ${fmt(updated.pkg)} (After IPM followed pro rata: ${fmt(existing.bipm)} → ${fmt(updated.bipm)})`,
          {
            empId: existing.id,
            field: "pkg",
            from: existing.pkg,
            to: updated.pkg,
          }
        )
      );
    }
  } else if (patch.op === "split") {
    if (existing.vp !== patch.vp || existing.np !== patch.np) {
      history.push(
        entry(
          actor,
          ts,
          `Set pool split for ${name(existing)}: VIC ${fmtPctWhole(existing.vp)} / NSW ${fmtPctWhole(existing.np)} → VIC ${fmtPctWhole(patch.vp)} / NSW ${fmtPctWhole(patch.np)}`,
          { empId: existing.id, field: "split" }
        )
      );
    }
  } else if (existing[patch.field] !== patch.value) {
    history.push(
      entry(
        actor,
        ts,
        `Set ${FIELD_LABELS[patch.field]} for ${name(existing)}: ${showField(patch.field, existing[patch.field])} → ${showField(patch.field, patch.value)}`,
        {
          empId: existing.id,
          field: patch.field,
          from: existing[patch.field],
          to: patch.value,
        }
      )
    );
  }

  const emp = [...data.emp];
  emp[index] = updated;
  return {
    ok: true,
    // identity fields can't change here, so the facets can't move
    dataset: { ...data, emp },
    overrides,
    overridesChanged: false,
    history,
  };
}
