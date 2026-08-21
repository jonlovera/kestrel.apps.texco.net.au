/**
 * "What changed" between two snapshots — pure module, no I/O, shared shape
 * with lib/history-diff.ts (overrides changes come from the same
 * overrideChanges core, so the History tab and the snapshot list can never
 * disagree about what counts as a change).
 *
 * Snapshots are taken BEFORE each mutation, so the change a snapshot's
 * actor/reason describes is the difference between THAT snapshot and the
 * next-newer one (or the live state, for the newest). The caller pairs them
 * up; this module only compares two states.
 *
 * The loosely-typed parts of a snapshot (params/columns/copy/access) are
 * re-parsed here with safeParse and degrade to a generic "settings changed"
 * line rather than throwing, so one old or malformed snapshot never costs
 * the whole page.
 */
import type { Employee, Snapshot } from "./schema";
import { z } from "zod";
import { overrideChanges } from "./history-diff";
import { fmt, fmtPctWhole } from "./fmt";
import { ParamsSchema, type Params } from "./params-apply";
import {
  ColumnConfigSchema,
  dropRetiredFields,
  migrateRenamedLabels,
  normalizeConfig,
  type ColumnConfig,
  type ColumnConfigEntry,
} from "./columns";
import { resolveCopy } from "./copy";
import {
  AccessRuleSchema,
  describeRule,
  dropInvalidRules,
  type AccessRule,
} from "./access-rules";

type State = Snapshot["state"];

export type ChangeArea =
  | "edits"
  | "locks"
  | "data"
  | "params"
  | "columns"
  | "wording"
  | "access";

export interface ChangeLine {
  area: ChangeArea;
  text: string;
}

export interface SnapshotDiffSummary {
  /** "3 bonus edits · 1 lock change · 2 parameter changes" — empty when nothing changed */
  headline: string;
  /** capped detail, see MAX_LINES */
  lines: ChangeLine[];
  /** how many lines the cap dropped */
  more: number;
}

/** Enough to read at a glance; the full state is always one restore away. */
const MAX_LINES = 30;

// ── employee fields ──────────────────────────────────────────────────────────

const money = (v: number) => fmt(v);
const pct = (v: number) => fmtPctWhole(v);
const text = (v: string | number) => String(v);

/** Label + rendering per comparable employee field (id is the join key). */
const EMPLOYEE_FIELDS: {
  key: keyof Employee;
  label: string;
  show: (v: string | number) => string;
}[] = [
  { key: "sn", label: "Surname", show: text },
  { key: "gn", label: "Given name", show: text },
  { key: "pos", label: "Position", show: text },
  { key: "dept", label: "Department", show: text },
  { key: "mgr", label: "Manager", show: text },
  { key: "cat", label: "Category", show: text },
  { key: "st", label: "State", show: text },
  { key: "vp", label: "VIC %", show: (v) => pct(Number(v)) },
  { key: "np", label: "NSW %", show: (v) => pct(Number(v)) },
  { key: "pkg", label: "Eligible Salary", show: (v) => money(Number(v)) },
  { key: "totalPkg", label: "Total Package", show: (v) => money(Number(v)) },
  { key: "elig", label: "Eligibility %", show: (v) => pct(Number(v)) },
  { key: "bp", label: "Bonus%", show: (v) => pct(Number(v)) },
  { key: "ipm", label: "IPM%", show: (v) => pct(Number(v)) },
  { key: "bipm", label: "After IPM", show: (v) => money(Number(v)) },
  { key: "da", label: "Discretionary", show: (v) => money(Number(v)) },
  { key: "f25", label: "FY25 Bonus (Paid)", show: (v) => money(Number(v)) },
  { key: "sm", label: "Site manager", show: (v) => (v ? "Yes" : "No") },
];

const CAPS: { key: "vCap" | "nCap" | "gCap"; label: string }[] = [
  { key: "vCap", label: "VIC pool cap" },
  { key: "nCap", label: "NSW pool cap" },
  { key: "gCap", label: "Group pool cap" },
];

const fullName = (e: Employee) => `${e.gn} ${e.sn}`;

// ── the diff ─────────────────────────────────────────────────────────────────

export function diffSnapshotStates(older: State, newer: State): SnapshotDiffSummary {
  const lines: ChangeLine[] = [];
  const push = (area: ChangeArea, text: string) => lines.push({ area, text });

  // Overrides (bonus edits and locks) — same core as the History tab.
  let edits = 0;
  let locks = 0;
  for (const c of overrideChanges(older.dataset.emp, older.overrides, newer.overrides)) {
    if (c.kind === "edit") edits++;
    else locks++;
    push(c.kind === "edit" ? "edits" : "locks", c.summary);
  }

  // Dataset rows: added / removed / field changes on surviving rows.
  const oldById = new Map(older.dataset.emp.map((e) => [e.id, e]));
  const newById = new Map(newer.dataset.emp.map((e) => [e.id, e]));
  const addedRows = newer.dataset.emp.filter((e) => !oldById.has(e.id));
  const removedRows = older.dataset.emp.filter((e) => !newById.has(e.id));
  const roster = (verb: string, rows: Employee[]) => {
    if (rows.length === 0) return;
    if (rows.length <= 3) for (const e of rows) push("data", `${verb} ${fullName(e)}`);
    else push("data", `${verb} ${rows.length} employees`);
  };
  roster("Added", addedRows);
  roster("Removed", removedRows);

  let dataChanges = 0;
  for (const e of older.dataset.emp) {
    const n = newById.get(e.id);
    if (!n) continue;
    for (const f of EMPLOYEE_FIELDS) {
      const from = e[f.key];
      const to = n[f.key];
      if (from === to) continue;
      dataChanges++;
      const fromText = from === undefined ? "not provided" : f.show(from as string | number);
      const toText = to === undefined ? "not provided" : f.show(to as string | number);
      push("data", `${f.label} for ${fullName(e)}: ${fromText} → ${toText}`);
    }
  }

  for (const cap of CAPS) {
    if (older.dataset[cap.key] !== newer.dataset[cap.key]) {
      dataChanges++;
      push("data", `${cap.label}: ${fmt(older.dataset[cap.key])} → ${fmt(newer.dataset[cap.key])}`);
    }
  }

  // Permanent exclusions — dataset-level, honoured by every later import.
  const nameOf = (id: string) => {
    const e = newById.get(id) ?? oldById.get(id);
    return e ? fullName(e) : id;
  };
  const oldExcluded = new Set(older.dataset.excludedIds);
  const newExcluded = new Set(newer.dataset.excludedIds);
  for (const id of newer.dataset.excludedIds) {
    if (!oldExcluded.has(id)) {
      dataChanges++;
      push("data", `Excluded ${nameOf(id)} from the model`);
    }
  }
  for (const id of older.dataset.excludedIds) {
    if (!newExcluded.has(id)) {
      dataChanges++;
      push("data", `Un-excluded ${nameOf(id)}`);
    }
  }

  // Scheme parameters. null is meaningful: "no explicit params, the dataset's
  // own caps and a modifier of 1 are in effect" — what restore now recreates.
  const paramChanges = diffParams(older.params, newer.params, push);

  // Column presentation settings.
  const columnChanges = diffColumns(older.columns, newer.columns, push);

  // Wording. An absent copy doc means the defaults, matching restore.
  const wordingChanges = diffCopy(older.copy, newer.copy, push);

  // Access rules — only when both sides carry them; snapshots taken before
  // access was captured say nothing about it, so neither can the diff.
  const accessChanges = diffAccess(older.access, newer.access, push);

  // Headline: one segment per area with anything in it.
  const s = (n: number) => (n === 1 ? "" : "s");
  const segments: string[] = [];
  if (edits) segments.push(`${edits} bonus edit${s(edits)}`);
  if (locks) segments.push(`${locks} lock change${s(locks)}`);
  if (addedRows.length) segments.push(`${addedRows.length} employee${s(addedRows.length)} added`);
  if (removedRows.length)
    segments.push(`${removedRows.length} employee${s(removedRows.length)} removed`);
  if (dataChanges) segments.push(`${dataChanges} data change${s(dataChanges)}`);
  if (paramChanges) segments.push(`${paramChanges} parameter change${s(paramChanges)}`);
  if (columnChanges) segments.push(`${columnChanges} column change${s(columnChanges)}`);
  if (wordingChanges) segments.push("wording changed");
  if (accessChanges) segments.push(`${accessChanges} access change${s(accessChanges)}`);

  return {
    headline: segments.join(" · "),
    lines: lines.slice(0, MAX_LINES),
    more: Math.max(0, lines.length - MAX_LINES),
  };
}

// ── per-area helpers (each returns how many changes it pushed) ──────────────

function diffParams(
  olderRaw: unknown,
  newerRaw: unknown,
  push: (area: ChangeArea, text: string) => void
): number {
  const parse = (raw: unknown): Params | null | "invalid" => {
    if (raw == null) return null;
    const p = ParamsSchema.safeParse(raw);
    return p.success ? p.data : "invalid";
  };
  const older = parse(olderRaw);
  const newer = parse(newerRaw);
  if (older === "invalid" || newer === "invalid") {
    // A shape this module no longer understands — say so rather than guess,
    // and only when the raw docs actually differ.
    if (JSON.stringify(olderRaw) === JSON.stringify(newerRaw)) return 0;
    push("params", "Parameter settings changed");
    return 1;
  }
  if (older === null && newer === null) return 0;
  if (older === null && newer !== null) {
    push(
      "params",
      `Parameters set: VIC cap ${fmt(newer.vCap)}, NSW cap ${fmt(newer.nCap)}, Group cap ${fmt(newer.gCap)}, company modifier ${newer.companyModifier}`
    );
    return 1;
  }
  if (older !== null && newer === null) {
    push("params", "Parameters cleared back to scheme defaults");
    return 1;
  }
  if (older === null || newer === null) return 0; // unreachable; narrows types
  let n = 0;
  for (const cap of CAPS) {
    if (older[cap.key] !== newer[cap.key]) {
      n++;
      push("params", `${cap.label}: ${fmt(older[cap.key])} → ${fmt(newer[cap.key])}`);
    }
  }
  if (older.companyModifier !== newer.companyModifier) {
    n++;
    push("params", `Company modifier: ${older.companyModifier} → ${newer.companyModifier}`);
  }
  return n;
}

function diffColumns(
  olderRaw: unknown,
  newerRaw: unknown,
  push: (area: ChangeArea, text: string) => void
): number {
  // The same tolerance the store's loadColumnConfig applies, so a snapshot
  // holding a retired field or a since-renamed default label compares as the
  // config a reader would actually have seen, not as unparseable.
  const parse = (raw: unknown): ColumnConfig | "invalid" => {
    if (raw == null) return normalizeConfig([]); // pre-feature = the defaults
    const p = ColumnConfigSchema.safeParse(dropRetiredFields(raw));
    return p.success ? migrateRenamedLabels(normalizeConfig(p.data)) : "invalid";
  };
  const older = parse(olderRaw);
  const newer = parse(newerRaw);
  if (older === "invalid" || newer === "invalid") {
    if (JSON.stringify(olderRaw) === JSON.stringify(newerRaw)) return 0;
    push("columns", "Column settings changed");
    return 1;
  }
  const oldByField = new Map(older.map((c) => [c.field, c]));
  let n = 0;
  const line = (text: string) => {
    n++;
    push("columns", text);
  };
  for (const c of newer) {
    const o = oldByField.get(c.field);
    if (!o) continue; // normalizeConfig makes both sides complete
    if (o.visible !== c.visible) line(`${c.visible ? "Showed" : "Hid"} column "${c.label}"`);
    if (o.label !== c.label) line(`Renamed column "${o.label}" to "${c.label}"`);
    if (o.format !== c.format || o.decimals !== c.decimals)
      line(`Changed the format of column "${c.label}"`);
  }
  const orderChanged =
    older.map((c: ColumnConfigEntry) => c.field).join() !==
    newer.map((c: ColumnConfigEntry) => c.field).join();
  if (orderChanged) line("Reordered the columns");
  return n;
}

function diffCopy(
  olderRaw: unknown,
  newerRaw: unknown,
  push: (area: ChangeArea, text: string) => void
): number {
  // resolveCopy folds a partial or absent doc over the defaults, the same way
  // every reader (and now restore) does — so "absent" compares as the
  // default wording rather than as a change.
  const older = resolveCopy(olderRaw ?? null);
  const newer = resolveCopy(newerRaw ?? null);
  let n = 0;
  const line = (text: string) => {
    n++;
    push("wording", text);
  };
  if (older.schemeName !== newer.schemeName)
    line(`Renamed the scheme to "${newer.schemeName}"`);
  if (older.bannerVisible !== newer.bannerVisible)
    line(`Banner switched ${newer.bannerVisible ? "on" : "off"}`);
  if (older.bannerText !== newer.bannerText)
    line(`Banner wording changed to "${newer.bannerText}"`);
  for (const key of ["vic", "nsw", "group"] as const) {
    if (older.poolTitles[key] !== newer.poolTitles[key])
      line(`Renamed pool card "${older.poolTitles[key]}" to "${newer.poolTitles[key]}"`);
  }
  if (older.footerText !== newer.footerText) line("Footer wording changed");
  return n;
}

function diffAccess(
  olderRaw: unknown,
  newerRaw: unknown,
  push: (area: ChangeArea, text: string) => void
): number {
  // Absent (not just empty) means the snapshot predates access capture —
  // it says nothing about access, so neither can the diff.
  if (olderRaw === undefined || newerRaw === undefined) return 0;
  const OverlaySchema = z.preprocess(
    dropInvalidRules,
    z.record(z.string(), AccessRuleSchema)
  ) as z.ZodType<Record<string, AccessRule>>;
  const older = OverlaySchema.safeParse(olderRaw ?? {});
  const newer = OverlaySchema.safeParse(newerRaw ?? {});
  if (!older.success || !newer.success) {
    if (JSON.stringify(olderRaw) === JSON.stringify(newerRaw)) return 0;
    push("access", "Access rules changed");
    return 1;
  }
  let n = 0;
  const line = (text: string) => {
    n++;
    push("access", text);
  };
  const emails = new Set([...Object.keys(older.data), ...Object.keys(newer.data)]);
  for (const email of emails) {
    const o = older.data[email];
    const w = newer.data[email];
    if (o && !w) line(`Removed access for ${email}`);
    else if (!o && w) line(`Granted access for ${email}: ${describeRule(w)}`);
    else if (o && w && JSON.stringify(o) !== JSON.stringify(w))
      line(`Changed access for ${email}: ${describeRule(w)}`);
  }
  return n;
}
