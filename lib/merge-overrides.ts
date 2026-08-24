/**
 * Three-way merge for the overrides document, used by the dashboard when a
 * save comes back 409: base is what this browser last loaded or saved, ours
 * is what it wants to store now, theirs is what a colleague stored meanwhile.
 *
 * Changes that touch different employees, or different fields on the same
 * employee, combine silently. Only a field both sides changed away from the
 * same base, to different values, is a conflict for the user to settle.
 *
 * Pure and free of server-only imports so the client component can run it;
 * the server still sanitises and clamps whatever gets sent afterwards, so
 * nothing here is trusted for authority — it only decides what to SEND.
 */
import type { Overrides, EmployeeOverride } from "./schema";

export type ScalarField = "daEdit" | "ipmEdit";

export interface OverrideConflict {
  empId: string;
  /**
   * "lock" covers the {locked, lockedFinal} pair, which moves as one unit.
   * "daPooled" is the funding flag — a standalone boolean, merged on its own
   * because two people can disagree about how a row is funded without either
   * of them touching the amount.
   */
  field: ScalarField | "lock" | "daPooled";
  /** display values; for "lock" this is the locked flag */
  ours: number | boolean | undefined;
  theirs: number | boolean | undefined;
}

export interface MergeResult {
  /** conflicted slots resolved to OURS, everything else combined */
  merged: Overrides;
  conflicts: OverrideConflict[];
}

const SCALAR_FIELDS: readonly ScalarField[] = ["daEdit", "ipmEdit"];

/**
 * The lock is a pair: the flag and the dollar figure frozen when it was set.
 * They are compared and moved together so one side's flag can never end up
 * attached to the other side's frozen figure.
 */
interface LockPair {
  locked?: boolean;
  lockedFinal?: number;
}

function lockOf(entry: EmployeeOverride | undefined): LockPair | undefined {
  if (!entry) return undefined;
  if (entry.locked === undefined && entry.lockedFinal === undefined) return undefined;
  return { locked: entry.locked, lockedFinal: entry.lockedFinal };
}

function lockEq(a: LockPair | undefined, b: LockPair | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.locked === b.locked && a.lockedFinal === b.lockedFinal;
}

function applyLock(target: EmployeeOverride, pair: LockPair | undefined): void {
  if (pair === undefined) return;
  if (pair.locked !== undefined) target.locked = pair.locked;
  if (pair.lockedFinal !== undefined) target.lockedFinal = pair.lockedFinal;
}

export function mergeOverrides(
  base: Overrides,
  ours: Overrides,
  theirs: Overrides
): MergeResult {
  const ids = new Set([
    ...Object.keys(base),
    ...Object.keys(ours),
    ...Object.keys(theirs),
  ]);
  const merged: Overrides = {};
  const conflicts: OverrideConflict[] = [];

  for (const id of ids) {
    const b = base[id];
    const o = ours[id];
    const t = theirs[id];
    const entry: EmployeeOverride = {};

    for (const field of SCALAR_FIELDS) {
      const bV = b?.[field];
      const oV = o?.[field];
      const tV = t?.[field];
      let winner: number | undefined;
      if (oV === bV) {
        winner = tV; // we didn't change it
      } else if (tV === bV || tV === oV) {
        winner = oV; // they didn't change it, or we agree
      } else {
        conflicts.push({ empId: id, field, ours: oV, theirs: tV });
        winner = oV;
      }
      if (winner !== undefined) entry[field] = winner;
    }

    // The funding flag, merged exactly like a scalar but on a boolean. It is
    // deliberately NOT bundled with daEdit: changing the amount and changing
    // where it comes from are independent decisions, and bundling them would
    // report a conflict whenever two people touched the same row for different
    // reasons.
    {
      const bV = b?.daPooled;
      const oV = o?.daPooled;
      const tV = t?.daPooled;
      let winner: boolean | undefined;
      if (oV === bV) {
        winner = tV;
      } else if (tV === bV || tV === oV) {
        winner = oV;
      } else {
        conflicts.push({ empId: id, field: "daPooled", ours: oV, theirs: tV });
        winner = oV;
      }
      if (winner !== undefined) entry.daPooled = winner;
    }

    const bL = lockOf(b);
    const oL = lockOf(o);
    const tL = lockOf(t);
    if (lockEq(oL, bL)) {
      applyLock(entry, tL);
    } else if (lockEq(tL, bL) || lockEq(tL, oL)) {
      applyLock(entry, oL);
    } else {
      conflicts.push({ empId: id, field: "lock", ours: oL?.locked, theirs: tL?.locked });
      applyLock(entry, oL);
    }

    // bonus % is source-spreadsheet data nobody may change any more; whatever
    // the server currently stores is simply carried forward
    if (t?.bpEdit !== undefined) entry.bpEdit = t.bpEdit;

    if (Object.keys(entry).length > 0) merged[id] = entry;
  }

  return { merged, conflicts };
}

/**
 * Settle the listed conflicts one way or the other. `merged` must be the
 * result of mergeOverrides (conflicted slots holding OUR values), `theirs`
 * the same document that produced it.
 */
export function resolveConflicts(
  merged: Overrides,
  theirs: Overrides,
  conflicts: readonly OverrideConflict[],
  take: "ours" | "theirs"
): Overrides {
  if (take === "ours" || conflicts.length === 0) return merged;
  const out: Overrides = Object.fromEntries(
    Object.entries(merged).map(([id, entry]) => [id, { ...entry }])
  );
  for (const c of conflicts) {
    const entry: EmployeeOverride = out[c.empId] ?? {};
    const t = theirs[c.empId];
    if (c.field === "lock") {
      delete entry.locked;
      delete entry.lockedFinal;
      applyLock(entry, lockOf(t));
    } else if (c.field === "daPooled") {
      // Split from the scalar branch only to keep the types honest: daPooled is
      // a boolean and the scalars are numbers, so one indexed assignment cannot
      // serve both without widening EmployeeOverride's field types.
      const tV = t?.daPooled;
      if (tV === undefined) delete entry.daPooled;
      else entry.daPooled = tV;
    } else {
      const tV = t?.[c.field];
      if (tV === undefined) delete entry[c.field];
      else entry[c.field] = tV;
    }
    if (Object.keys(entry).length > 0) out[c.empId] = entry;
    else delete out[c.empId];
  }
  return out;
}
