import type { Employee, Overrides, HistoryEntry } from "./schema";
import { fmt, fmtPctWhole } from "./fmt";

/**
 * Compute human-readable history entries for a change to the overrides doc.
 * Pure — compares each employee's previous effective values (override ?? base)
 * with the new ones. Used by /api/state before persisting.
 */
export function diffOverrides(
  base: Employee[],
  prev: Overrides,
  next: Overrides,
  actor: string,
  ts: string
): HistoryEntry[] {
  const entries: HistoryEntry[] = [];

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
      { key: "bpEdit", field: "bp", label: "Bonus%", show: fmtPctWhole },
      { key: "ipmEdit", field: "ipm", label: "IPM%", show: fmtPctWhole },
      { key: "daEdit", field: "da", label: "Disc adj", show: fmt },
    ];

    for (const f of fields) {
      const baseVal = f.key === "bpEdit" ? e.bp : f.key === "ipmEdit" ? e.ipm : e.da;
      const from = p[f.key] ?? baseVal;
      const to = n[f.key] ?? baseVal;
      if (from !== to) {
        entries.push({
          ts,
          actor,
          kind: "edit",
          summary: `Set ${f.label} for ${name}: ${f.show(from)} → ${f.show(to)}`,
          empId: e.id,
          field: f.field,
          from,
          to,
        });
      }
    }

    const wasLocked = p.locked ?? false;
    const isLocked = n.locked ?? false;
    if (wasLocked !== isLocked) {
      entries.push({
        ts,
        actor,
        kind: "lock",
        summary: isLocked
          ? `Locked ${name} at ${fmt(n.lockedFinal ?? 0)}`
          : `Unlocked ${name}`,
        empId: e.id,
        field: "lock",
        from: wasLocked ? "locked" : "unlocked",
        to: isLocked ? "locked" : "unlocked",
      });
    }
  }

  return entries;
}
