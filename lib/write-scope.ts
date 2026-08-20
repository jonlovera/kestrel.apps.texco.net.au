/**
 * The WRITE boundary — the counterpart to lib/scope-core.ts.
 *
 * scope-core decides what a user may be SENT. This decides what they may
 * CHANGE, and no write reaches storage without passing through it.
 *
 * The change that made this necessary: state leads used to be strictly
 * read-only, so `canEdit` alone was enough to gate every write. They can now
 * set Discretionary for their own people, which means every incoming
 * override has to be checked against two questions rather than one — is this
 * row theirs, and is this field theirs?
 *
 * "Is this field theirs" is no longer a property of the rule TYPE. Whether
 * someone may set Discretionary or IPM is chosen per person on the access
 * screen and carried on the rule as `editableFields`; leaving it unticked is
 * how you grant somebody a purely read-only view. See writableFields below,
 * which is the one place that setting is honoured for both the affordances
 * and the write boundary.
 *
 * The lock is different again: it isn't a member of `editableFields` and
 * isn't derived from it either. It has its own checkbox on the access screen
 * (`canLock` on the rule), independent of Discretionary/IPM — a lead can hold
 * either without the other, in any combination.
 *
 * Pure and no server-only imports, so both questions are directly testable.
 *
 * What nobody may change any more, admin included: employee id, package/REM
 * and bonus %. Those come from the source spreadsheet, because a typo in one
 * cascades through every calculation in the scheme. They are preserved from
 * the stored document rather than rejected loudly — an older client may still
 * be sending them.
 */
import type { Overrides } from "./schema";
import type { Scope } from "./access";
import { ruleMatches, type ScopableEmployee } from "./access-rules";

/**
 * Override fields a state lead may change, within their own rows — each
 * gated individually by the access screen's "Can edit" grant
 * (`editableFields`) intersected with visibility, in `writableFields` below.
 */
export const WRITABLE_BY_LEAD = ["daEdit", "ipmEdit"] as const;

/**
 * Everything an admin may write. `locked`/`lockedFinal` have no column and no
 * visibility (see the comment on `writableFields`), so they're listed here
 * directly rather than derived from `editableFields`.
 */
export const WRITABLE_BY_ADMIN = ["daEdit", "ipmEdit", "locked", "lockedFinal"] as const;

export type WritableField = (typeof WRITABLE_BY_ADMIN)[number];

/** Column keys matching the writable override fields, for the table to key off. */
const COLUMN_FOR_FIELD: Partial<Record<WritableField, string>> = {
  daEdit: "da",
  ipmEdit: "ipm",
};

/**
 * Which override fields this scope may change at all.
 *
 * The one place the access screen's "Can edit" setting is honoured, which is
 * what keeps the UI and the server from ever disagreeing: editableColumns
 * below feeds every affordance on the dashboard, sanitiseOverrideWrite feeds
 * the write boundary, and both come through here.
 *
 * Two conditions on the lead path, not one. `editableFields` is what was
 * granted (Discretionary and/or IPM). Visibility is the older rule and used
 * to be applied only in editableColumns, which meant hiding a figure removed
 * the input but not the permission: the same person could still POST a write
 * for their own rows and have it accepted. A field they were never sent is
 * now unwritable in fact, not just unofferable.
 *
 * The lock is gated on `scope.rule.canLock` alone — not on `fields`, so a
 * lead can hold Discretionary/IPM without it, or hold it with neither
 * ticked. `sanitiseOverrideWrite`'s existing `allowedIds` boundary (their
 * state/group/subset) is what confines this to their own rows; no new
 * boundary is needed here.
 *
 * The admin path is unconditional: WRITABLE_BY_ADMIN includes `locked` and
 * `lockedFinal` directly, which have no column and no visibility, so
 * filtering them through `editableFields` would quietly break locking.
 *
 * A revoked user needs no branch here: `scopeForUser` returns null for them,
 * so they never reach a Scope in the first place, and every route already
 * refuses a null scope before it gets this far.
 */
export function writableFields(scope: Scope): readonly WritableField[] {
  if (scope.rule.type === "full") return WRITABLE_BY_ADMIN;
  const granted = new Set<string>(scope.rule.editableFields);
  const visible = new Set<string>(scope.visibleFields);
  const fields = WRITABLE_BY_LEAD.filter((f) => {
    const column = COLUMN_FOR_FIELD[f];
    return !!column && granted.has(column) && visible.has(column);
  });
  if (scope.rule.canLock) return [...fields, "locked", "lockedFinal"];
  return fields;
}

/**
 * Whether this scope may lock/unlock a row at all, independent of which (if
 * any) figures it may edit. One source of truth for the payload builder and
 * anything else that needs a plain boolean rather than the writable-fields
 * list.
 */
export function canLockRows(scope: Scope): boolean {
  return writableFields(scope).includes("locked");
}

/** Whose rows this scope may change. */
export function writableEmployeeIds(
  scope: Scope,
  employees: readonly ScopableEmployee[]
): Set<string> {
  return new Set(
    employees.filter((e) => ruleMatches(scope.rule, e)).map((e) => e.id)
  );
}

/**
 * Which table columns this scope may type into.
 *
 * Presentation only — sanitiseOverrideWrite decides again on every write, off
 * the same writableFields, so the cells offered and the writes accepted are
 * the same set by construction.
 */
export function editableColumns(scope: Scope): string[] {
  return writableFields(scope)
    .map((f) => COLUMN_FOR_FIELD[f])
    .filter((c): c is string => !!c);
}

/**
 * How much authority a writing route demands.
 *
 * "admin" is the default and covers everything with no per-row boundary of
 * its own: the dataset, the caps, the presentation, imports, the access list.
 * "scoped" is /api/state alone, which takes writes from state leads because
 * sanitiseOverrideWrite below decides afterwards which rows and fields were
 * actually theirs.
 */
export type WriteLevel = "admin" | "scoped";

export type WriteVerdict = "ok" | "unauthenticated" | "viewing-as" | "forbidden";

/**
 * The whole write gate, as a pure function, so it can be tested.
 *
 * It is separate from lib/api-guard.ts because that module is `server-only`
 * and therefore unreachable from the suite. That is not a theoretical concern:
 * the admin routes spent their whole life accepting writes from state leads
 * because the guard's `canEdit` check was described in its comment and never
 * written, and no test could see it. This encodes the rule where a test can.
 *
 * Order matters. Viewing as is refused before the scope is judged, because
 * while a view is active `scope` is the TARGET's, so an admin viewing another
 * admin would otherwise pass on someone else's authority.
 */
export function writeVerdict(
  level: WriteLevel,
  actor: string | null,
  scope: Scope | null,
  viewingAs: string | null
): WriteVerdict {
  if (!actor || !scope) return "unauthenticated";
  if (viewingAs) return "viewing-as";
  if (level === "admin" && !scope.canEdit) return "forbidden";
  return "ok";
}

/**
 * The overrides document narrowed to exactly what this scope may write: their
 * rows, their fields. The precise mirror of sanitiseOverrideWrite's window,
 * so a baseline handed out here round-trips through a save losslessly — send
 * it back unchanged and nothing moves.
 *
 * This exists for the payload builder and /api/state's responses: a lead
 * needs a real baseline (so their save doesn't read as "cleared everything
 * else in my scope") without being sent anyone else's figures.
 */
export function scopeOverridesView(
  scope: Scope,
  employees: readonly ScopableEmployee[],
  doc: Overrides
): Overrides {
  if (scope.rule.type === "full") return doc;
  const allowedIds = writableEmployeeIds(scope, employees);
  const allowedFields = new Set<string>(writableFields(scope));
  const out: Overrides = {};
  for (const [id, entry] of Object.entries(doc)) {
    if (!allowedIds.has(id)) continue;
    const kept = Object.fromEntries(
      Object.entries(entry).filter(
        ([field, value]) => allowedFields.has(field) && value !== undefined
      )
    );
    if (Object.keys(kept).length > 0) out[id] = kept as Overrides[string];
  }
  return out;
}

export interface SanitisedWrite {
  /** the stored document with only the permitted changes applied */
  overrides: Overrides;
  /** what was refused, for the audit log — never surfaced to the caller */
  rejected: string[];
}

/**
 * Merge an incoming overrides document over the stored one, keeping only what
 * this scope is allowed to change.
 *
 * The caller's writable id set is the window. Inside it the incoming document
 * is authoritative, so clearing an adjustment works by omitting it — which is
 * how the admin client has always behaved, its window being everyone. Outside
 * the window the stored document is passed through untouched, so one lead
 * saving can never erase another lead's work, or the admin's.
 *
 * An id the caller may not write is dropped silently. Refusing it loudly would
 * confirm whether that employee exists, which a lead is not entitled to know.
 */
export function sanitiseOverrideWrite(
  scope: Scope,
  employees: readonly ScopableEmployee[],
  incoming: Overrides,
  current: Overrides
): SanitisedWrite {
  const allowedIds = writableEmployeeIds(scope, employees);
  const allowedFields = new Set<string>(writableFields(scope));
  const known = new Set(employees.map((e) => e.id));
  const rejected: string[] = [];

  const out: Overrides = {};

  // everything outside the window survives exactly as stored
  for (const [id, entry] of Object.entries(current)) {
    if (!allowedIds.has(id)) out[id] = entry;
  }

  for (const [id, entry] of Object.entries(incoming)) {
    if (!known.has(id)) {
      rejected.push(`unknown employee ${id}`);
      continue;
    }
    if (!allowedIds.has(id)) {
      rejected.push(`employee ${id} outside scope`);
      continue;
    }
    const stored = current[id] ?? {};
    const merged: Overrides[string] = {};

    // fields this scope can't touch keep whatever is already stored
    for (const [field, value] of Object.entries(stored)) {
      if (!allowedFields.has(field)) {
        (merged as Record<string, unknown>)[field] = value;
      }
    }
    for (const [field, value] of Object.entries(entry)) {
      if (value === undefined) continue;
      if (!allowedFields.has(field)) {
        // only worth logging when they actually tried to change it
        if ((stored as Record<string, unknown>)[field] !== value) {
          rejected.push(`field ${field} on ${id}`);
        }
        continue;
      }
      (merged as Record<string, unknown>)[field] = value;
    }

    if (Object.keys(merged).length > 0) out[id] = merged;
  }

  // an id inside the window but absent from the incoming document has had its
  // permitted entries cleared; anything unwritable on it still survives
  for (const [id, entry] of Object.entries(current)) {
    if (!allowedIds.has(id) || id in incoming) continue;
    const kept = Object.fromEntries(
      Object.entries(entry).filter(([field]) => !allowedFields.has(field))
    );
    if (Object.keys(kept).length > 0) out[id] = kept as Overrides[string];
  }

  return { overrides: out, rejected };
}
