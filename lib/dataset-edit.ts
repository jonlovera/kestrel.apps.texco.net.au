/**
 * The remaining edits to the SOURCE dataset: After IPM, which the finance
 * owner calls "Bonus", and the VIC/NSW split for Shared Services staff. Pure
 * module — no I/O, no server-only imports.
 *
 * Everything else that used to live here is gone on purpose. Employee id,
 * package/REM and bonus % are read-only on an EXISTING row for everyone,
 * admin included: a typo in one cascades through every calculation in the
 * scheme. Names and positions come from the spreadsheet import, which is the
 * source of truth for terminations and promotions.
 *
 * Two identity-ish abilities are deliberately reopened for admins:
 *
 * State (VIC/NSW/Shared), the "state" op below: moving someone between pools
 * is a scheme decision, not a payroll fact, and waiting for the next
 * workbook was costing real time. The import stays authoritative: a later
 * import that still lists the person under their old state moves them back,
 * and the edit modal says so.
 *
 * Adding a person, the "add" op below (restored — it shipped on 6 Aug and
 * was removed in the field lockdown four days later): a new starter should
 * not wait for the next workbook either. The import stays authoritative
 * here too, and the consequence is harsher than the state op's reversion:
 * an import whose sheet does not list the added person REMOVES them
 * (candidateDataset replaces `emp` wholesale), so the add form tells the
 * admin to put them in the next workbook as well.
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

const FieldPatchSchema = z.discriminatedUnion("field", [
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

/**
 * Exclude/unexclude sit outside the field union above: they don't touch a
 * field on a row, they decide whether the row exists in the model at all
 * (lib/import-parse.ts's candidateDataset honours the same excludedIds list
 * on every import after). `exclude` acts immediately — dropping the person
 * from `emp` as well as adding them to the list — rather than waiting for
 * the next import to notice.
 */
export const DatasetPatchSchema = z.union([
  FieldPatchSchema,
  z.object({ op: z.literal("exclude"), id: z.string().min(1) }),
  z.object({ op: z.literal("unexclude"), id: z.string().min(1) }),
  z.object({
    op: z.literal("state"),
    id: z.string().min(1),
    st: z.enum(["VIC", "NSW", "SHARED"]),
    /** required when st === "SHARED": the VIC share of the split; NSW = 1 - vp */
    vp: z.number().finite().min(0).max(1).optional(),
  }),
  /**
   * A brand-new row. The whole Employee shape is required; vp/np are then
   * DERIVED server-side from `st` (VIC 1/0, NSW 0/1, SHARED from the sent
   * vp as the VIC share) so an invalid split is unrepresentable — the same
   * rule the "state" op enforces.
   */
  z.object({ op: z.literal("add"), employee: EmployeeSchema }),
]);
export type DatasetPatch = z.infer<typeof DatasetPatchSchema>;
type FieldPatch = z.infer<typeof FieldPatchSchema>;

export type DatasetPatchResult =
  | { ok: true; dataset: Dataset; history: HistoryEntry[] }
  | { ok: false; errors: string[] };

/**
 * The dataset's filter lists, derived from whoever is in it. Used by
 * lib/import-parse.ts and by every op here that changes who exists
 * (exclude, add) — a new starter's department must reach the filters.
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
const FIELD_LABEL: Record<FieldPatch["field"], string> = {
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
  if (patch.op === "exclude") return applyExclude(data, patch.id, actor, ts);
  if (patch.op === "unexclude") return applyUnexclude(data, patch.id, actor, ts);
  if (patch.op === "state")
    return applyStateChange(data, patch.id, patch.st, patch.vp, actor, ts);
  if (patch.op === "add") return applyAdd(data, patch.employee, actor, ts);

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

/**
 * Permanently exclude an employee: dropped from `emp` now, and added to
 * `excludedIds` so lib/import-parse.ts's candidateDataset keeps dropping them
 * from every import after this one, even if the spreadsheet still lists
 * them. Idempotent — excluding someone already excluded is a no-op.
 */
function applyExclude(
  data: Dataset,
  id: string,
  actor: string,
  ts: string
): DatasetPatchResult {
  if (data.excludedIds.includes(id)) {
    return { ok: true, dataset: data, history: [] };
  }
  const existing = data.emp.find((e) => e.id === id);
  if (!existing) {
    return { ok: false, errors: [`No employee with id '${id}'.`] };
  }
  const emp = data.emp.filter((e) => e.id !== id);
  return {
    ok: true,
    dataset: {
      ...data,
      emp,
      excludedIds: [...data.excludedIds, id],
      ...deriveFacets(emp),
    },
    history: [
      {
        ts,
        actor,
        kind: "dataset",
        summary: `Excluded ${existing.gn} ${existing.sn} from the model — this and every future import`,
        empId: id,
      },
    ],
  };
}

/**
 * Best-effort display name for the "Permanently excluded" panel at
 * /admin/import — by the time anyone views that list the person's own row is
 * long gone from `emp`, so the name is recovered from the exclude action's
 * own history entry instead. Falls back to the bare id once history ages
 * past HISTORY_CAP, or for a dataset excluded before this lookup existed.
 */
export function excludedRoster(
  excludedIds: string[],
  history: HistoryEntry[]
): { id: string; name: string }[] {
  const nameOf = (id: string): string => {
    const entry = history.find(
      (h) => h.kind === "dataset" && h.empId === id && h.summary.startsWith("Excluded ")
    );
    return entry?.summary.match(/^Excluded (.+) from the model/)?.[1] ?? id;
  };
  return excludedIds.map((id) => ({ id, name: nameOf(id) }));
}

/**
 * Reverse an exclusion: only removes the id from `excludedIds`, so the next
 * import that still lists them will bring them back. Does not resurrect the
 * row itself — there's no data to restore it with once it's gone.
 * Idempotent — un-excluding someone not on the list is a no-op.
 */
function applyUnexclude(
  data: Dataset,
  id: string,
  actor: string,
  ts: string
): DatasetPatchResult {
  if (!data.excludedIds.includes(id)) {
    return { ok: true, dataset: data, history: [] };
  }
  return {
    ok: true,
    dataset: {
      ...data,
      excludedIds: data.excludedIds.filter((x) => x !== id),
    },
    history: [
      {
        ts,
        actor,
        kind: "dataset",
        summary: `Un-excluded employee id ${id} — will reappear on the next import that still lists them`,
        empId: id,
      },
    ],
  };
}

/** How a state reads in a history sentence. */
const STATE_LABEL: Record<Employee["st"], string> = {
  VIC: "VIC",
  NSW: "NSW",
  SHARED: "Shared Services",
};

/**
 * Move an employee between the pools. VIC and NSW imply their whole-pool
 * split; Shared Services requires an explicit VIC share (NSW follows as the
 * remainder, like the vp/np field patches). Re-attributes the person's whole
 * bonus exposure between the capped pools, which is exactly why this is
 * admin-only and flows through the snapshot/history pipeline.
 */
function applyStateChange(
  data: Dataset,
  id: string,
  st: Employee["st"],
  vpShare: number | undefined,
  actor: string,
  ts: string
): DatasetPatchResult {
  const index = data.emp.findIndex((e) => e.id === id);
  if (index < 0) {
    return { ok: false, errors: [`No employee with id '${id}'.`] };
  }
  const existing = data.emp[index];

  let vp: number;
  if (st === "VIC") vp = 1;
  else if (st === "NSW") vp = 0;
  else {
    if (vpShare === undefined) {
      return {
        ok: false,
        errors: ["Moving someone to Shared Services needs a VIC % for the split."],
      };
    }
    vp = round4(vpShare);
  }
  const np = round4(1 - vp);

  if (existing.st === st && existing.vp === vp && existing.np === np) {
    return { ok: true, dataset: data, history: [] };
  }

  const updated: Employee = { ...existing, st, vp, np };
  const parsed = EmployeeSchema.safeParse(updated);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `'State': ${i.message.toLowerCase()}`),
    };
  }

  const emp = [...data.emp];
  emp[index] = updated;
  const split = st === "SHARED" ? ` (${fmtPct(vp)} VIC / ${fmtPct(np)} NSW)` : "";
  const summary =
    existing.st === st
      ? // already SHARED, only the split moved; worded the way the vp/np
        // field patches word it, so the history reads consistently
        `Set VIC % for ${existing.gn} ${existing.sn}: ${fmtPct(existing.vp)} → ${fmtPct(vp)} (NSW % follows automatically)`
      : `Moved ${existing.gn} ${existing.sn} from ${STATE_LABEL[existing.st]} to ${STATE_LABEL[st]}${split}`;
  return {
    ok: true,
    dataset: { ...data, emp },
    history: [
      {
        ts,
        actor,
        kind: "dataset",
        summary,
        empId: existing.id,
        field: "st",
        from: existing.st,
        to: st,
      },
    ],
  };
}

/** Human labels for add-validation errors, matching the import's column names. */
const ADD_FIELD_LABEL: Record<string, string> = {
  id: "ID",
  sn: "Surname",
  gn: "Given name",
  pos: "Position",
  dept: "Department",
  mgr: "Manager",
  cat: "Category",
  st: "State",
  vp: "VIC %",
  np: "NSW %",
  pkg: "Package",
  bp: "Bonus %",
  ipm: "IPM %",
  bipm: "After IPM",
  da: "Disc adj",
  f25: "FY25 bonus",
  sm: "Site manager",
};

/**
 * Add a brand-new person to the roster. Restores the "+ Add person" ability
 * removed in the field lockdown, with two hardenings the original lacked:
 * vp/np are derived from `st` rather than trusted (an invalid split is
 * unrepresentable), and an id on the excluded list is refused up front —
 * candidateDataset would silently drop that person on the very next import,
 * which is a confusing way to discover the conflict.
 *
 * The id convention in the real data is initials-derived uppercase letters
 * (ALBID, BRELL), enforced loosely as 2-6 uppercase letters after trimming
 * and upcasing whatever was typed.
 */
function applyAdd(
  data: Dataset,
  incoming: Employee,
  actor: string,
  ts: string
): DatasetPatchResult {
  const id = incoming.id.trim().toUpperCase();
  // uniqueness first: "already exists" is the answer the admin actually
  // needs, even when the id would also fail the format rule
  const existing = data.emp.find((e) => e.id === id);
  if (existing) {
    return {
      ok: false,
      errors: [`Employee id '${id}' already exists (${existing.gn} ${existing.sn}).`],
    };
  }
  if (!/^[A-Z][A-Z0-9]{1,5}$/.test(id)) {
    return {
      ok: false,
      errors: [
        `'ID': must be 2 to 6 letters or digits, starting with a letter (the convention is first two of the given name plus first three of the surname), got '${incoming.id}'.`,
      ],
    };
  }
  if ((data.excludedIds ?? []).includes(id)) {
    return {
      ok: false,
      errors: [
        `'${id}' is on the permanently-excluded list, so the next import would drop them again. Un-exclude them from Admin > Import first, or pick a different id.`,
      ],
    };
  }

  // The split is the state's, not the caller's — same rule as the state op.
  // For Shared Services the sent vp is read as the VIC share.
  let vp: number;
  if (incoming.st === "VIC") vp = 1;
  else if (incoming.st === "NSW") vp = 0;
  else vp = round4(incoming.vp);
  const np = round4(1 - vp);

  const candidate: Employee = { ...incoming, id, vp, np };
  const parsed = EmployeeSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => {
        const field = String(i.path[0] ?? "?");
        return `'${ADD_FIELD_LABEL[field] ?? field}': ${i.message.toLowerCase()}`;
      }),
    };
  }

  const emp = [...data.emp, parsed.data];
  const split =
    candidate.st === "SHARED" ? `, ${fmtPct(vp)} VIC / ${fmtPct(np)} NSW` : "";
  return {
    ok: true,
    dataset: { ...data, emp, ...deriveFacets(emp) },
    history: [
      {
        ts,
        actor,
        kind: "dataset",
        summary: `Added ${candidate.gn} ${candidate.sn} (${candidate.pos}, ${candidate.dept}, ${STATE_LABEL[candidate.st]}${split}) with a package of ${fmt(candidate.pkg)}`,
        empId: id,
        field: "add",
        to: id,
      },
    ],
  };
}
