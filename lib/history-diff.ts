import type { Employee, Overrides, HistoryEntry } from "./schema";
import { fmt, fmtPctSmart } from "./fmt";

/**
 * One field-level change to the overrides doc, in structured form. The
 * history feed (diffOverrides below) and the snapshot diff
 * (lib/snapshot-diff.ts) both render from this, so the two can never
 * disagree about what counts as a change.
 */
export interface OverrideChange {
  empId: string;
  kind: "edit" | "lock";
  field: string;
  from: number | string;
  to: number | string;
  summary: string;
}

/**
 * Compute the changes between two overrides docs. Pure — compares each
 * employee's previous effective values (override ?? base) with the new ones.
 */
export function overrideChanges(
  base: Employee[],
  prev: Overrides,
  next: Overrides
): OverrideChange[] {
  const changes: OverrideChange[] = [];

  for (const e of base) {
    const p = prev[e.id] ?? {};
    const n = next[e.id] ?? {};
    const name = `${e.gn} ${e.sn}`;

    const fields: {
      key: "bpEdit" | "ipmEdit" | "daEdit";
      field: string;
      label: string;
      show: (v: number) => string;
    }[] = [
      { key: "bpEdit", field: "bp", label: "Bonus%", show: fmtPctSmart },
      { key: "ipmEdit", field: "ipm", label: "IPM%", show: fmtPctSmart },
      { key: "daEdit", field: "da", label: "Discretionary", show: fmt },
    ];

    for (const f of fields) {
      const baseVal = f.key === "bpEdit" ? e.bp : f.key === "ipmEdit" ? e.ipm : e.da;
      const from = p[f.key] ?? baseVal;
      const to = n[f.key] ?? baseVal;
      if (from !== to) {
        changes.push({
          empId: e.id,
          kind: "edit",
          field: f.field,
          from,
          to,
          summary: `Set ${f.label} for ${name}: ${f.show(from)} → ${f.show(to)}`,
        });
      }
    }

    const wasLocked = p.locked ?? false;
    const isLocked = n.locked ?? false;
    if (wasLocked !== isLocked) {
      changes.push({
        empId: e.id,
        kind: "lock",
        field: "lock",
        from: wasLocked ? "locked" : "unlocked",
        to: isLocked ? "locked" : "unlocked",
        summary: isLocked
          ? `Locked ${name} at ${fmt(n.lockedFinal ?? 0)}`
          : `Unlocked ${name}`,
      });
    } else if (
      wasLocked &&
      isLocked &&
      (p.lockedFinal ?? 0) !== (n.lockedFinal ?? 0)
    ) {
      // A re-lock at a different amount used to be invisible: the flag never
      // flips, but the frozen dollar figure — the whole point of the lock —
      // has moved.
      changes.push({
        empId: e.id,
        kind: "lock",
        field: "lock",
        from: p.lockedFinal ?? 0,
        to: n.lockedFinal ?? 0,
        summary: `Locked amount for ${name}: ${fmt(p.lockedFinal ?? 0)} → ${fmt(n.lockedFinal ?? 0)}`,
      });
    }
  }

  return changes;
}

/**
 * Compute human-readable history entries for a change to the overrides doc.
 * Used by /api/state before persisting.
 */
export function diffOverrides(
  base: Employee[],
  prev: Overrides,
  next: Overrides,
  actor: string,
  ts: string,
  viewingAs?: string
): HistoryEntry[] {
  return overrideChanges(base, prev, next).map((c) => ({
    ts,
    actor,
    kind: c.kind,
    summary: c.summary,
    empId: c.empId,
    field: c.field,
    from: c.from,
    to: c.to,
    ...(viewingAs ? { viewingAs } : {}),
  }));
}
