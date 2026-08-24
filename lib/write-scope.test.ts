/**
 * Write-boundary tests. The load-bearing assertions: a state lead can never
 * change a row that isn't theirs, can never change a field that isn't theirs,
 * and can never erase anyone else's work by saving their own.
 *
 * These matter more than most: until this round every read-only scope was
 * refused at the door by a single `canEdit` check, and that check is now gone.
 */
import { describe, it, expect } from "vitest";
import type { Scope } from "./access";
import { EDITABLE_FIELDS, AccessRuleSchema, type EditableField } from "./access-rules";
import type { Overrides } from "./schema";
import {
  sanitiseOverrideWrite,
  scopeOverridesView,
  writableEmployeeIds,
  writableFields,
  editableColumns,
  writeVerdict,
  WRITABLE_BY_ADMIN,
  WRITABLE_BY_LEAD,
} from "./write-scope";

const EMPLOYEES = [
  { id: "V1", st: "VIC", pos: "Site Manager" },
  { id: "V2", st: "VIC", pos: "Project Manager" },
  { id: "N1", st: "NSW", pos: "Site Manager" },
  { id: "N2", st: "NSW", pos: "Contract Administrator" },
  { id: "S1", st: "SHARED", pos: "General Counsel" },
];

// `da` and `ipm` both need to be visible before either can be written: these
// fixtures stand for a lead who could hold both, and leaving one out would
// quietly make them read-only for it.
const FIELDS = ["ipm", "da", "calc", "final"] as const;

const admin: Scope = {
  email: "admin@texco.net.au",
  rule: { type: "full", canEditCaps: false, canActAs: [] },
  canEdit: true,
  visibleFields: [...FIELDS],
  label: "Full access",
};
/** Granted both Discretionary and IPM, and explicitly ticked "Can lock". */
const vicLead: Scope = {
  email: "vic@texco.net.au",
  rule: {
    type: "state",
    states: ["VIC"],
    visibleFields: [...FIELDS],
    editableFields: [...EDITABLE_FIELDS],
    canLock: true,
    canActAs: [],
  },
  canEdit: false,
  visibleFields: [...FIELDS],
  label: "VIC",
};
const subsetLead: Scope = {
  email: "sub@texco.net.au",
  rule: {
    type: "subset",
    employeeIds: ["V2", "N1"],
    visibleFields: [...FIELDS],
    editableFields: [...EDITABLE_FIELDS],
    canLock: true,
    canActAs: [],
  },
  canEdit: false,
  visibleFields: [...FIELDS],
  label: "Subset",
};
const smGroupLead: Scope = {
  email: "sm@texco.net.au",
  rule: {
    type: "group",
    states: ["VIC"],
    positions: ["Site Manager"],
    visibleFields: [...FIELDS],
    editableFields: [...EDITABLE_FIELDS],
    canLock: true,
    canActAs: [],
  },
  canEdit: false,
  visibleFields: [...FIELDS],
  label: "VIC site managers",
};
/** Granted Discretionary only, but still explicitly ticked "Can lock". */
const daOnlyLead: Scope = {
  email: "vic-da@texco.net.au",
  rule: {
    type: "state",
    states: ["VIC"],
    visibleFields: [...FIELDS],
    editableFields: ["da"],
    canLock: true,
    canActAs: [],
  },
  canEdit: false,
  visibleFields: [...FIELDS],
  label: "VIC (Discretionary only)",
};
/** Granted nothing at all — no editable fields, and "Can lock" unticked. */
const readOnlyLead: Scope = {
  email: "vic-ro@texco.net.au",
  rule: { type: "state", states: ["VIC"], visibleFields: [...FIELDS], editableFields: [], canLock: false, canActAs: [] },
  canEdit: false,
  visibleFields: [...FIELDS],
  label: "VIC (read only)",
};
/**
 * "Can lock" ticked with no editable fields at all — otherwise fully
 * read-only, but may still freeze/unfreeze a row in scope. Demonstrates the
 * grant is independent of Discretionary/IPM, not derived from them.
 */
const lockOnlyLead: Scope = {
  email: "vic-lock@texco.net.au",
  rule: { type: "state", states: ["VIC"], visibleFields: [...FIELDS], editableFields: [], canLock: true, canActAs: [] },
  canEdit: false,
  visibleFields: [...FIELDS],
  label: "VIC (lock only)",
};
/** Both figures granted, but "Can lock" unticked — the mirror image of lockOnlyLead. */
const grantedNoLockLead: Scope = {
  email: "vic-nolock@texco.net.au",
  rule: {
    type: "state",
    states: ["VIC"],
    visibleFields: [...FIELDS],
    editableFields: [...EDITABLE_FIELDS],
    canLock: false,
    canActAs: [],
  },
  canEdit: false,
  visibleFields: [...FIELDS],
  label: "VIC (no lock)",
};

const write = (scope: Scope, incoming: Overrides, current: Overrides = {}) =>
  sanitiseOverrideWrite(scope, EMPLOYEES, incoming, current);

describe("who may write what", () => {
  it("an admin may write every override field", () => {
    expect(writableFields(admin)).toEqual(WRITABLE_BY_ADMIN);
  });

  it("a fully-granted lead may write Discretionary and IPM, plus the lock", () => {
    expect(writableFields(vicLead)).toEqual([...WRITABLE_BY_LEAD, "locked", "lockedFinal"]);
    expect(writableFields(subsetLead)).toEqual([...WRITABLE_BY_LEAD, "locked", "lockedFinal"]);
    expect(writableFields(smGroupLead)).toEqual([...WRITABLE_BY_LEAD, "locked", "lockedFinal"]);
  });

  it("a partially-granted lead who also holds Can lock gets both", () => {
    // daPooled comes with daEdit, not on its own: the funding flag rides the
    // same "da" grant as the amount (owner decision, 24 Aug 2026).
    expect(writableFields(daOnlyLead)).toEqual([
      "daEdit",
      "daPooled",
      "locked",
      "lockedFinal",
    ]);
  });

  it("a lead granted nothing at all may write nothing", () => {
    expect(writableFields(readOnlyLead)).toEqual([]);
  });

  it("nobody may write bonus % — it comes from the spreadsheet", () => {
    for (const scope of [admin, vicLead, subsetLead, smGroupLead, daOnlyLead, readOnlyLead]) {
      expect(writableFields(scope)).not.toContain("bpEdit");
    }
  });

  it("the lock is its own grant, independent of Discretionary/IPM", () => {
    // The regression this guards: locking used to ride on holding any edit
    // grant at all, so ticking Discretionary silently also handed over the
    // lock. It's now `canLock` on the rule — a lead can hold either without
    // the other, in any combination — within their own scope
    // (sanitiseOverrideWrite's allowedIds boundary).
    expect(writableFields(admin)).toContain("locked");
    expect(writableFields(vicLead)).toContain("locked");
    expect(writableFields(lockOnlyLead)).toContain("locked");
    expect(writableFields(readOnlyLead)).not.toContain("locked");
    expect(writableFields(grantedNoLockLead)).not.toContain("locked");
  });
});

describe("whose rows may be written", () => {
  it("an admin's window is everyone", () => {
    expect(writableEmployeeIds(admin, EMPLOYEES).size).toBe(EMPLOYEES.length);
  });

  it("a state lead's window is their state", () => {
    expect([...writableEmployeeIds(vicLead, EMPLOYEES)].sort()).toEqual(["V1", "V2"]);
  });

  it("a subset lead's window is their list", () => {
    expect([...writableEmployeeIds(subsetLead, EMPLOYEES)].sort()).toEqual(["N1", "V2"]);
  });

  it("a group lead's window is the intersection, not the union", () => {
    // VIC ∧ Site Manager — not every VIC person, and not every site manager
    expect([...writableEmployeeIds(smGroupLead, EMPLOYEES)]).toEqual(["V1"]);
  });
});

describe("a lead cannot reach outside their own rows", () => {
  it("an id in another state is dropped", () => {
    const res = write(vicLead, { N1: { daEdit: 50 } });
    expect(res.overrides).toEqual({});
    expect(res.rejected).toContain("employee N1 outside scope");
  });

  it("their own row goes through", () => {
    const res = write(vicLead, { V1: { daEdit: 50 } });
    expect(res.overrides).toEqual({ V1: { daEdit: 50 } });
    expect(res.rejected).toEqual([]);
  });

  it("a mixed save keeps the permitted half and drops the rest", () => {
    const res = write(vicLead, {
      V1: { daEdit: 50 },
      N1: { daEdit: 90 },
      S1: { daEdit: 1000 },
    });
    expect(Object.keys(res.overrides)).toEqual(["V1"]);
    expect(res.rejected).toHaveLength(2);
  });

  it("an employee who doesn't exist is dropped without confirming as much", () => {
    const res = write(vicLead, { GHOST: { daEdit: 50 } });
    expect(res.overrides).toEqual({});
    expect(res.rejected).toEqual(["unknown employee GHOST"]);
  });
});

describe("a lead cannot reach fields that aren't theirs", () => {
  it("a bonus % change is dropped, and the stored one survives", () => {
    const res = write(vicLead, { V1: { bpEdit: 0.5, daEdit: 50 } }, { V1: { bpEdit: 0.2 } });
    expect(res.overrides.V1).toEqual({ bpEdit: 0.2, daEdit: 50 });
    expect(res.rejected).toContain("field bpEdit on V1");
  });

  it("an IPM change succeeds for a lead who was granted it", () => {
    const res = write(vicLead, { V1: { ipmEdit: 0.8, daEdit: 50 } }, { V1: { ipmEdit: 0.9 } });
    expect(res.overrides.V1).toEqual({ ipmEdit: 0.8, daEdit: 50 });
    expect(res.rejected).toEqual([]);
  });

  it("an IPM change is dropped for a lead who wasn't granted it", () => {
    const res = write(daOnlyLead, { V1: { ipmEdit: 0.8, daEdit: 50 } }, { V1: { ipmEdit: 0.9 } });
    expect(res.overrides.V1).toEqual({ ipmEdit: 0.9, daEdit: 50 });
    expect(res.rejected).toContain("field ipmEdit on V1");
  });

  it("a lock is dropped for a lead without Can lock, and the stored lock survives", () => {
    const res = write(
      readOnlyLead,
      { V1: { locked: false } },
      { V1: { locked: true, lockedFinal: 1234 } }
    );
    expect(res.overrides.V1).toEqual({ locked: true, lockedFinal: 1234 });
    expect(res.rejected).toContain("field locked on V1");
  });

  it("a granted lead may set the lock within their own scope", () => {
    const res = write(vicLead, { V1: { locked: true, lockedFinal: 999 } });
    expect(res.overrides.V1).toEqual({ locked: true, lockedFinal: 999 });
    expect(res.rejected).toEqual([]);
  });

  it("an admin may set the lock", () => {
    const res = write(admin, { V1: { locked: true, lockedFinal: 999 } });
    expect(res.overrides.V1).toEqual({ locked: true, lockedFinal: 999 });
    expect(res.rejected).toEqual([]);
  });

  it("Can lock with no edit grant at all may still lock/unlock their own rows", () => {
    // The decoupled case that has no prior coverage: a lead who cannot touch
    // Discretionary or IPM at all, but was separately ticked "Can lock".
    const res = write(lockOnlyLead, { V1: { locked: true, lockedFinal: 999 } });
    expect(res.overrides.V1).toEqual({ locked: true, lockedFinal: 999 });
    expect(res.rejected).toEqual([]);
  });

  it("a full edit grant with Can lock unticked still can't touch the lock", () => {
    // The mirror image: holding every figure doesn't imply the lock any more.
    const res = write(
      grantedNoLockLead,
      { V1: { daEdit: 50, locked: true, lockedFinal: 999 } },
      { V1: { locked: false } }
    );
    expect(res.overrides.V1).toEqual({ daEdit: 50, locked: false });
    expect(res.rejected).toContain("field locked on V1");
  });

  it("bonus % is refused even from an admin", () => {
    const res = write(admin, { V1: { bpEdit: 0.9 } });
    expect(res.overrides).toEqual({});
    expect(res.rejected).toContain("field bpEdit on V1");
  });

  it("an admin may set IPM", () => {
    const res = write(admin, { V1: { ipmEdit: 0.9 } });
    expect(res.overrides.V1).toEqual({ ipmEdit: 0.9 });
    expect(res.rejected).toEqual([]);
  });
});

describe("saving does not erase anyone else's work", () => {
  const current: Overrides = {
    V1: { ipmEdit: 0.9 },
    N1: { ipmEdit: 0.7, daEdit: 500 },
    S1: { daEdit: 250 },
  };

  it("a VIC lead saving their whole row leaves NSW and shared untouched", () => {
    const res = write(vicLead, { V1: { daEdit: 100, ipmEdit: 0.9 } }, current);
    expect(res.overrides.N1).toEqual({ ipmEdit: 0.7, daEdit: 500 });
    expect(res.overrides.S1).toEqual({ daEdit: 250 });
    expect(res.overrides.V1).toEqual({ ipmEdit: 0.9, daEdit: 100 });
  });

  it("omitting a writable field on a row they're touching clears it, same as Discretionary always could", () => {
    // Now that IPM is writable for a fully-granted lead, it behaves exactly
    // like Discretionary always has: the incoming document is authoritative
    // for a row it mentions, so leaving a writable field out of it clears
    // that field rather than preserving it. A real client sends the row's
    // full accumulated state, so this only bites a caller that sends a
    // partial row on purpose.
    const res = write(vicLead, { V1: { daEdit: 100 } }, current);
    expect(res.overrides.V1).toEqual({ daEdit: 100 });
  });

  it("a field the lead was never granted survives even when they save the row", () => {
    const res = write(daOnlyLead, { V1: { daEdit: 100, ipmEdit: 0.5 } }, current);
    // their sneaked-in ipmEdit is dropped and the stored one is kept
    expect(res.overrides.V1).toEqual({ ipmEdit: 0.9, daEdit: 100 });
    expect(res.rejected).toContain("field ipmEdit on V1");
  });

  it("omitting their own row clears only the field they hold — a field they don't survives", () => {
    const res = write(daOnlyLead, {}, { ...current, V2: { daEdit: 100 } });
    // ipmEdit isn't daOnlyLead's to clear, so it survives
    expect(res.overrides.V1).toEqual({ ipmEdit: 0.9 });
    // daEdit is theirs, and V2 was omitted, so it's gone
    expect(res.overrides.V2).toBeUndefined();
    // and still nothing of anyone else's moved
    expect(res.overrides.N1).toEqual({ ipmEdit: 0.7, daEdit: 500 });
  });

  it("clearing their own row keeps a lock a read-only lead doesn't hold", () => {
    const res = write(readOnlyLead, {}, { V1: { ipmEdit: 0.9, locked: true, lockedFinal: 42 } });
    expect(res.overrides.V1).toEqual({ ipmEdit: 0.9, locked: true, lockedFinal: 42 });
  });

  it("an admin's whole-doc save still fully replaces Discretionary", () => {
    const res = write(admin, { V1: { daEdit: 100, ipmEdit: 0.9 } }, current);
    // Everything writable to admin behaves exactly as before: V1's new figure
    // lands, and N1's (unmentioned, so cleared) daEdit is gone.
    expect(res.overrides.V1.daEdit).toBe(100);
    expect(res.overrides.N1?.daEdit).toBeUndefined();
  });

  it("an admin's save also clears IPM if omitted from a row they're touching, just like Discretionary", () => {
    // IPM is now an ordinary member of WRITABLE_BY_ADMIN, not a permanent
    // blind spot — so it follows the same "incoming is authoritative for a
    // row it mentions" rule as everything else admin can write.
    const res = write(admin, { V1: { daEdit: 100 } }, current);
    expect(res.overrides.V1).toEqual({ daEdit: 100 });
  });

  it("bonus % is preserved even from an admin — it's the one field nobody may write", () => {
    const res = write(admin, { V1: { daEdit: 100 } }, { V1: { bpEdit: 0.5 } });
    expect(res.overrides.V1).toEqual({ bpEdit: 0.5, daEdit: 100 });
  });
});

/**
 * The read-side mirror of the write window: what a scope is handed as its
 * overrides baseline. The load-bearing property is the round trip — a
 * baseline from scopeOverridesView, sent back through sanitiseOverrideWrite
 * unchanged, must leave the stored document exactly as it was.
 */
describe("scopeOverridesView", () => {
  const stored: Overrides = {
    V1: { daEdit: 100, ipmEdit: 0.9, bpEdit: 0.2 },
    V2: { locked: true, lockedFinal: 5000 },
    N1: { daEdit: 500 },
    S1: { ipmEdit: 0.7 },
  };

  it("is the identity for an admin", () => {
    expect(scopeOverridesView(admin, EMPLOYEES, stored)).toEqual(stored);
  });

  it("gives a lead only their rows and only their fields", () => {
    expect(scopeOverridesView(vicLead, EMPLOYEES, stored)).toEqual({
      V1: { daEdit: 100, ipmEdit: 0.9 },
      V2: { locked: true, lockedFinal: 5000 },
    });
  });

  it("drops lockedFinal for a lead without Can lock", () => {
    expect(scopeOverridesView(grantedNoLockLead, EMPLOYEES, stored)).toEqual({
      V1: { daEdit: 100, ipmEdit: 0.9 },
    });
  });

  it("gives a partially-granted lead only the granted figure", () => {
    expect(scopeOverridesView(daOnlyLead, EMPLOYEES, stored)).toEqual({
      V1: { daEdit: 100 },
      V2: { locked: true, lockedFinal: 5000 },
    });
  });

  it("gives a read-only lead nothing", () => {
    expect(scopeOverridesView(readOnlyLead, EMPLOYEES, stored)).toEqual({});
  });

  it("round-trips: saving the baseline unchanged leaves the store as it was", () => {
    for (const scope of [vicLead, daOnlyLead, grantedNoLockLead, lockOnlyLead]) {
      const baseline = scopeOverridesView(scope, EMPLOYEES, stored);
      const res = sanitiseOverrideWrite(scope, EMPLOYEES, baseline, stored);
      expect(res.overrides).toEqual(stored);
      expect(res.rejected).toEqual([]);
    }
  });
});

/*
 * There is deliberately no "revoked user" case here: Scope.rule is typed as
 * GrantingRule, `scopeForUser` returns null for a revoked email, and every
 * route refuses a null scope before reaching this module. The type system
 * holds that line, so a runtime test would only assert unreachable code.
 */

/**
 * The gate every writing route runs (lib/api-guard.ts turns these verdicts
 * into responses). These exist because the real thing shipped broken and
 * invisible: requireWriter's comment claimed it refused anyone without
 * `canEdit`, the check was never written, and every admin route inherited it.
 */
describe("writeVerdict", () => {
  it("lets a full-access user through at either level", () => {
    expect(writeVerdict("admin", admin.email, admin, null)).toBe("ok");
    expect(writeVerdict("scoped", admin.email, admin, null)).toBe("ok");
  });

  it("refuses a state lead an admin-level write", () => {
    // The regression: /api/dataset, /api/params, /api/import/apply and
    // /api/access all accepted these, the last of which would have let a lead
    // grant themselves full access.
    expect(writeVerdict("admin", vicLead.email, vicLead, null)).toBe("forbidden");
    expect(writeVerdict("admin", subsetLead.email, subsetLead, null)).toBe("forbidden");
    expect(writeVerdict("admin", smGroupLead.email, smGroupLead, null)).toBe("forbidden");
  });

  it("lets a state lead make a scoped write, which is /api/state alone", () => {
    // sanitiseOverrideWrite decides afterwards which rows and fields were
    // actually theirs, which is what makes the weaker gate safe here.
    expect(writeVerdict("scoped", vicLead.email, vicLead, null)).toBe("ok");
  });

  it("refuses everyone while viewing as someone WITHOUT a sanction, at either level", () => {
    expect(writeVerdict("scoped", admin.email, vicLead, "vic@texco.net.au")).toBe("viewing-as");
    expect(writeVerdict("admin", admin.email, admin, "other@texco.net.au")).toBe("viewing-as");
  });

  it("judges viewing-as before the scope, since the scope is the target's", () => {
    // An admin viewing another admin holds a canEdit scope that is not their
    // own; taking it at face value would let them write on someone else's
    // authority and log it against the wrong person.
    expect(writeVerdict("admin", admin.email, admin, "other-admin@texco.net.au")).toBe(
      "viewing-as"
    );
  });

  it("lets a SANCTIONED scoped write through a view — the act-as delegation", () => {
    // The scope in hand is the TARGET's (vicLead); sanitiseOverrideWrite then
    // confines the write to that window, and the guard records the actor.
    expect(
      writeVerdict("scoped", "clint@texco.net.au", vicLead, "vic@texco.net.au", true)
    ).toBe("ok");
  });

  it("a sanction never opens the admin-level routes during a view", () => {
    // Those routes have no per-row boundary of their own; with the target's
    // scope in hand, an actor acting for an admin-shaped scope would
    // otherwise write with authority that is not theirs.
    expect(
      writeVerdict("admin", "clint@texco.net.au", admin, "other@texco.net.au", true)
    ).toBe("viewing-as");
  });

  it("a sanction with no resolvable scope is still unauthenticated", () => {
    expect(
      writeVerdict("scoped", "clint@texco.net.au", null, "gone@texco.net.au", true)
    ).toBe("unauthenticated");
  });

  it("refuses a signed-out caller, and one with no access at all", () => {
    expect(writeVerdict("admin", null, null, null)).toBe("unauthenticated");
    expect(writeVerdict("scoped", "nobody@texco.net.au", null, null)).toBe(
      "unauthenticated"
    );
  });
});

/**
 * Schema compatibility for the act-as grant, mirroring the canLock case: a
 * rule stored before `canActAs` existed must parse to "no delegation", never
 * fail (one unparseable rule revokes the whole overlay).
 */
describe("the canActAs default", () => {
  it("a stored lead rule without canActAs parses to an empty delegation", () => {
    const stored = {
      type: "state",
      states: ["VIC"],
      visibleFields: [...FIELDS],
      editableFields: ["da"],
      canLock: false,
    };
    expect(AccessRuleSchema.parse(stored)).toMatchObject({ canActAs: [] });
  });

  it("a stored full rule without canActAs parses the same way", () => {
    const stored = { type: "full", canEditCaps: true };
    expect(AccessRuleSchema.parse(stored)).toMatchObject({ canActAs: [] });
  });
});

/**
 * The "Can edit" setting on the access screen. Discretionary and IPM can
 * both be granted, independently, per person.
 */
describe("the editable-fields grant", () => {
  // canLock held fixed at false throughout this block: it's tested on its own
  // terms above, and holding it constant here keeps these cases about
  // Discretionary/IPM alone.
  const lead = (
    editableFields: EditableField[],
    visibleFields: Scope["visibleFields"] = [...FIELDS]
  ): Scope => ({
    ...vicLead,
    rule: { type: "state", states: ["VIC"], visibleFields, editableFields, canLock: false, canActAs: [] },
    visibleFields,
  });

  it("grants both Discretionary and IPM when the rule predates the setting", () => {
    // The compatibility case that matters most: a rule stored before this
    // existed must keep behaving exactly as it did, or people silently lose
    // the ability to do their job. `canLock` predates nothing — there is no
    // stored data whose implicit behaviour it needs to preserve — so an
    // absent value defaults to false rather than being inferred from
    // whatever editableFields happens to contain.
    const stored = { type: "state", states: ["VIC"], visibleFields: [...FIELDS] };
    const parsed = AccessRuleSchema.parse(stored);
    expect(parsed).toMatchObject({ editableFields: ["da", "ipm"], canLock: false, canActAs: [] });
  });

  it("writes nothing when no field is granted", () => {
    expect(writableFields(lead([]))).toEqual([]);
  });

  it("grants exactly what was ticked", () => {
    // The "da" tick carries both the amount and its funding; the "ipm" tick
    // carries neither, so ticking IPM alone can never let someone change how
    // somebody's discretionary money is funded.
    expect(writableFields(lead(["da"]))).toEqual(["daEdit", "daPooled"]);
    expect(writableFields(lead(["ipm"]))).toEqual(["ipmEdit"]);
    expect(writableFields(lead(["da", "ipm"]))).toEqual([
      "daEdit",
      "daPooled",
      "ipmEdit",
    ]);
  });

  it("offers the funding flag no column of its own", () => {
    // It lives on the "da" column, so editableColumns must name that column
    // once — the affordance list and the write boundary stay the same set.
    expect(editableColumns(lead(["da"]))).toEqual(["da"]);
  });

  it("cannot grant a figure the person was never sent", () => {
    // The hole this closes: hiding a figure used to remove the input from
    // the table while still accepting a write for it posted to /api/state.
    const hidden = lead(["da"], ["calc", "final"]);
    expect(writableFields(hidden)).toEqual([]);
    expect(editableColumns(hidden)).toEqual([]);
  });

  it("offers exactly the columns it will accept", () => {
    expect(editableColumns(lead(["da"]))).toEqual(["da"]);
    expect(editableColumns(lead([]))).toEqual([]);
  });

  it("drops a read-only lead's write and keeps the stored figure", () => {
    const { overrides, rejected } = write(
      lead([]),
      { V1: { daEdit: 50 } },
      { V1: { daEdit: 90 } }
    );
    expect(overrides.V1).toEqual({ daEdit: 90 });
    expect(rejected).toContain("field daEdit on V1");
  });

  it("drops a granted-but-hidden field and keeps what was granted", () => {
    const { overrides } = write(
      lead(["da"], ["da", "final"]),
      { V1: { daEdit: 100, ipmEdit: 0.9 } },
      { V1: {} }
    );
    expect(overrides.V1).toEqual({ daEdit: 100 });
  });

  it("leaves the admin untouched — locking must still work", () => {
    // WRITABLE_BY_ADMIN carries `locked`/`lockedFinal`, which have no column
    // and no visibility, so the new filtering must not reach them.
    expect(writableFields(admin)).toEqual(WRITABLE_BY_ADMIN);
    expect(writableFields(admin)).toContain("locked");
  });
});
