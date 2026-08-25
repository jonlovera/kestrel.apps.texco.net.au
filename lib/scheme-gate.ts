/**
 * /api/state's gate 2: the scheme's row rules, applied to the MERGED document
 * a save carries forward (a lead's save carries every stored row with it).
 *
 * Two kinds of row are outside the writer's reach, and they are handled
 * differently on purpose:
 *
 *  - A row drawing from NO pool has nothing a lock or a discretionary amount
 *    can mean anything against, so those fields are simply dropped — there is
 *    no valid stored value to fall back to.
 *
 *  - A SITE MANAGER the writer may not adjust (a VIC one, without the
 *    `canEditVicSiteManagers` grant — lib/calc.ts's isAdjustable) is REVERTED
 *    to the stored value, field by field, rather than cleared. This is the
 *    difference that matters: the gate runs over the whole merged document on
 *    every save, so if it deleted the field, any admin's unrelated save would
 *    silently wipe a lock, IPM or amount that an admin holding the grant had
 *    set an hour earlier — and the history would record an "Unlocked" nobody
 *    asked for. Reverting keeps the boundary strict for THIS writer and
 *    invisible to everyone else's work. The engine (applyOverrides) then
 *    honours what is stored, because it can only have got there through here.
 *
 * `lockedFinal` is left alone throughout: not writable by anyone, read only as
 * a fallback for a row with no baseAmount (lib/schema.ts).
 */
import type { Employee, Overrides } from "./schema";
import {
  isDaEditable,
  isIpmEditable,
  isLockable,
  rowRule,
  type AdjustAllowance,
} from "./calc";

/** The fields the scheme rule governs, and the predicate for each. */
const GATED = [
  ["locked", isLockable],
  ["daEdit", isDaEditable],
  ["ipmEdit", isIpmEditable],
] as const;

export interface SchemeGateResult {
  overrides: Overrides;
  /** what was held back, for the audit line — one entry per row touched */
  reverted: { empId: string; fields: string[] }[];
}

export function applySchemeRules(
  scoped: Overrides,
  previous: Overrides,
  known: ReadonlyMap<string, Employee>,
  allow: AdjustAllowance
): SchemeGateResult {
  const overrides: Overrides = {};
  const reverted: SchemeGateResult["reverted"] = [];
  for (const [id, ov] of Object.entries(scoped)) {
    const emp = known.get(id);
    if (!emp) continue;
    const clean: Overrides[string] = { ...ov };
    if (clean.ipmEdit !== undefined) clean.ipmEdit = Math.max(0, clean.ipmEdit);
    if (clean.bpEdit !== undefined) clean.bpEdit = Math.max(0, clean.bpEdit);
    // daEdit is deliberately not floored: an adjustment may be negative (owner
    // decision, kept through every change of funding model).

    const rule = rowRule(emp);
    const stored = previous[id] ?? {};
    const held: string[] = [];
    for (const [field, may] of GATED) {
      if (may(rule, allow)) continue;
      if (!rule.inPool) {
        // nothing to measure against; IPM stays (it only moves the advisory
        // figure for a row like this, and always has)
        if (field !== "ipmEdit" && clean[field] !== undefined) {
          delete clean[field];
          held.push(field);
        }
        continue;
      }
      // a site manager this writer may not touch: back to what is stored
      const was = stored[field];
      if (clean[field] === was) continue;
      if (was === undefined) delete clean[field];
      else (clean as Record<string, unknown>)[field] = was;
      held.push(field);
    }
    if (held.length) reverted.push({ empId: id, fields: held });
    if (Object.keys(clean).length > 0) overrides[id] = clean;
  }
  return { overrides, reverted };
}
