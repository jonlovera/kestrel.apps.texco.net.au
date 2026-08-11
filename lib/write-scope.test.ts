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
import { EDITABLE_FIELDS, AccessRuleSchema } from "./access-rules";
import type { Overrides } from "./schema";
import {
  sanitiseOverrideWrite,
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

// `da` belongs here now that a figure has to be visible before it can be
// written: these fixtures stand for a lead who sets both, and leaving
// Discretionary out would quietly make them read-only for it.
const FIELDS = ["ipm", "da", "calc", "final"] as const;

const admin: Scope = {
  email: "admin@texco.net.au",
  rule: { type: "full" },
  canEdit: true,
  visibleFields: [...FIELDS],
  label: "Full access",
};
const vicLead: Scope = {
  email: "vic@texco.net.au",
  rule: { type: "state", states: ["VIC"], visibleFields: [...FIELDS], editableFields: [...EDITABLE_FIELDS] },
  canEdit: false,
  visibleFields: [...FIELDS],
  label: "VIC",
};
const subsetLead: Scope = {
  email: "sub@texco.net.au",
  rule: { type: "subset", employeeIds: ["V2", "N1"], visibleFields: [...FIELDS], editableFields: [...EDITABLE_FIELDS] },
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
  },
  canEdit: false,
  visibleFields: [...FIELDS],
  label: "VIC site managers",
};

const write = (scope: Scope, incoming: Overrides, current: Overrides = {}) =>
  sanitiseOverrideWrite(scope, EMPLOYEES, incoming, current);

describe("who may write what", () => {
  it("an admin may write every override field", () => {
    expect(writableFields(admin)).toEqual(WRITABLE_BY_ADMIN);
  });

  it("a lead may write only Discretionary", () => {
    expect(writableFields(vicLead)).toEqual(WRITABLE_BY_LEAD);
    expect(writableFields(subsetLead)).toEqual(WRITABLE_BY_LEAD);
    expect(writableFields(smGroupLead)).toEqual(WRITABLE_BY_LEAD);
  });

  it("nobody may write bonus % — it comes from the spreadsheet", () => {
    for (const scope of [admin, vicLead, subsetLead, smGroupLead]) {
      expect(writableFields(scope)).not.toContain("bpEdit");
    }
  });

  it("nobody may write IPM — including full access", () => {
    // The regression this guards: IPM used to be grantable per person via
    // editableFields, and unconditionally writable for admin. It is a
    // formula-derived figure now locked for everyone, no exceptions.
    for (const scope of [admin, vicLead, subsetLead, smGroupLead]) {
      expect(writableFields(scope)).not.toContain("ipmEdit");
    }
  });

  it("only the admin holds the lock", () => {
    expect(writableFields(admin)).toContain("locked");
    expect(writableFields(vicLead)).not.toContain("locked");
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

  it("an IPM change is dropped even from a lead who could set it before", () => {
    const res = write(vicLead, { V1: { ipmEdit: 0.8, daEdit: 50 } }, { V1: { ipmEdit: 0.9 } });
    expect(res.overrides.V1).toEqual({ ipmEdit: 0.9, daEdit: 50 });
    expect(res.rejected).toContain("field ipmEdit on V1");
  });

  it("a lock is dropped, and an admin's existing lock survives", () => {
    const res = write(
      vicLead,
      { V1: { daEdit: 50, locked: false } },
      { V1: { locked: true, lockedFinal: 1234 } }
    );
    expect(res.overrides.V1).toEqual({
      locked: true,
      lockedFinal: 1234,
      daEdit: 50,
    });
    expect(res.rejected).toContain("field locked on V1");
  });

  it("an admin may set the lock", () => {
    const res = write(admin, { V1: { locked: true, lockedFinal: 999 } });
    expect(res.overrides.V1).toEqual({ locked: true, lockedFinal: 999 });
    expect(res.rejected).toEqual([]);
  });

  it("bonus % is refused even from an admin", () => {
    const res = write(admin, { V1: { bpEdit: 0.9 } });
    expect(res.overrides).toEqual({});
    expect(res.rejected).toContain("field bpEdit on V1");
  });

  it("IPM is refused even from an admin", () => {
    const res = write(admin, { V1: { ipmEdit: 0.9 } });
    expect(res.overrides).toEqual({});
    expect(res.rejected).toContain("field ipmEdit on V1");
  });
});

describe("saving does not erase anyone else's work", () => {
  const current: Overrides = {
    V1: { ipmEdit: 0.9 },
    N1: { ipmEdit: 0.7, daEdit: 500 },
    S1: { daEdit: 250 },
  };

  it("a VIC lead saving only their row leaves NSW and shared untouched", () => {
    const res = write(vicLead, { V1: { daEdit: 100 } }, current);
    expect(res.overrides.N1).toEqual({ ipmEdit: 0.7, daEdit: 500 });
    expect(res.overrides.S1).toEqual({ daEdit: 250 });
    // the row they DID write keeps its grandfathered IPM alongside the new DA
    expect(res.overrides.V1).toEqual({ ipmEdit: 0.9, daEdit: 100 });
  });

  it("omitting their own row clears only what they could have written", () => {
    // A grandfathered ipmEdit is not a field this lead can write, so it is
    // preserved exactly like an admin's lock would be — omission clears
    // Discretionary, not a figure the lead was never allowed to touch.
    const res = write(vicLead, {}, { ...current, V2: { daEdit: 100 } });
    expect(res.overrides.V1).toEqual({ ipmEdit: 0.9 });
    expect(res.overrides.V2).toBeUndefined();
    // and still nothing of anyone else's moved
    expect(res.overrides.N1).toEqual({ ipmEdit: 0.7, daEdit: 500 });
  });

  it("clearing their own row keeps a grandfathered IPM and an admin's lock on it", () => {
    const res = write(vicLead, {}, { V1: { ipmEdit: 0.9, locked: true, lockedFinal: 42 } });
    expect(res.overrides.V1).toEqual({ ipmEdit: 0.9, locked: true, lockedFinal: 42 });
  });

  it("an admin's whole-doc save still fully replaces Discretionary and locks", () => {
    const res = write(admin, { V1: { daEdit: 100 } }, current);
    // Everything writable to admin behaves exactly as before: V1's new figure
    // lands, and N1's (unmentioned, so cleared) daEdit is gone.
    expect(res.overrides.V1.daEdit).toBe(100);
    expect(res.overrides.N1?.daEdit).toBeUndefined();
  });

  it("a grandfathered IPM survives even an admin's whole-doc save, mentioned or not", () => {
    // Admin no longer holds ipmEdit in WRITABLE_BY_ADMIN, so from the write
    // boundary's point of view it is exactly like a lock: not theirs to
    // touch, so it persists regardless of what the client sends — the same
    // guarantee a lead's grandfathered IPM gets, and for the same reason.
    const res = write(admin, { V1: { daEdit: 100 } }, current);
    expect(res.overrides.V1.ipmEdit).toBe(0.9);
    expect(res.overrides.N1?.ipmEdit).toBe(0.7);
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

  it("refuses everyone while viewing as someone, at either level", () => {
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

  it("refuses a signed-out caller, and one with no access at all", () => {
    expect(writeVerdict("admin", null, null, null)).toBe("unauthenticated");
    expect(writeVerdict("scoped", "nobody@texco.net.au", null, null)).toBe(
      "unauthenticated"
    );
  });
});

/**
 * The "Can edit" setting on the access screen. Discretionary is the only
 * field it can grant now — IPM used to be a second option here, withdrawable
 * per person, and is now withdrawn from everyone unconditionally (see
 * "nobody may write IPM" above). A stored rule that still lists "ipm" is
 * covered separately in access-rules.test.ts (dropInvalidRules strips it
 * rather than failing the whole rule).
 */
describe("the editable-fields grant", () => {
  const lead = (
    editableFields: "da"[],
    visibleFields: Scope["visibleFields"] = [...FIELDS]
  ): Scope => ({
    ...vicLead,
    rule: { type: "state", states: ["VIC"], visibleFields, editableFields },
    visibleFields,
  });

  it("grants Discretionary when the rule predates the setting", () => {
    // The compatibility case that matters most: a rule stored before this
    // existed must keep behaving exactly as it did, or people silently lose
    // the ability to do their job.
    const stored = { type: "state", states: ["VIC"], visibleFields: [...FIELDS] };
    const parsed = AccessRuleSchema.parse(stored);
    expect(parsed).toMatchObject({ editableFields: ["da"] });
  });

  it("writes nothing when no field is granted", () => {
    expect(writableFields(lead([]))).toEqual([]);
  });

  it("grants exactly what was ticked", () => {
    expect(writableFields(lead(["da"]))).toEqual(["daEdit"]);
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
