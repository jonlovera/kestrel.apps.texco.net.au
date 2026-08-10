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
import type { Overrides } from "./schema";
import {
  sanitiseOverrideWrite,
  writableEmployeeIds,
  writableFields,
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

const FIELDS = ["ipm", "calc", "final"] as const;

const admin: Scope = {
  email: "admin@texco.net.au",
  rule: { type: "full" },
  canEdit: true,
  visibleFields: [...FIELDS],
  label: "Full access",
};
const vicLead: Scope = {
  email: "vic@texco.net.au",
  rule: { type: "state", states: ["VIC"], visibleFields: [...FIELDS] },
  canEdit: false,
  visibleFields: [...FIELDS],
  label: "VIC",
};
const subsetLead: Scope = {
  email: "sub@texco.net.au",
  rule: { type: "subset", employeeIds: ["V2", "N1"], visibleFields: [...FIELDS] },
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

  it("a lead may write only IPM and Discretionary", () => {
    expect(writableFields(vicLead)).toEqual(WRITABLE_BY_LEAD);
    expect(writableFields(subsetLead)).toEqual(WRITABLE_BY_LEAD);
    expect(writableFields(smGroupLead)).toEqual(WRITABLE_BY_LEAD);
  });

  it("nobody may write bonus % — it comes from the spreadsheet", () => {
    for (const scope of [admin, vicLead, subsetLead, smGroupLead]) {
      expect(writableFields(scope)).not.toContain("bpEdit");
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
    const res = write(vicLead, { N1: { ipmEdit: 0.5 } });
    expect(res.overrides).toEqual({});
    expect(res.rejected).toContain("employee N1 outside scope");
  });

  it("their own row goes through", () => {
    const res = write(vicLead, { V1: { ipmEdit: 0.5 } });
    expect(res.overrides).toEqual({ V1: { ipmEdit: 0.5 } });
    expect(res.rejected).toEqual([]);
  });

  it("a mixed save keeps the permitted half and drops the rest", () => {
    const res = write(vicLead, {
      V1: { ipmEdit: 0.5 },
      N1: { ipmEdit: 0.9 },
      S1: { daEdit: 1000 },
    });
    expect(Object.keys(res.overrides)).toEqual(["V1"]);
    expect(res.rejected).toHaveLength(2);
  });

  it("an employee who doesn't exist is dropped without confirming as much", () => {
    const res = write(vicLead, { GHOST: { ipmEdit: 0.5 } });
    expect(res.overrides).toEqual({});
    expect(res.rejected).toEqual(["unknown employee GHOST"]);
  });
});

describe("a lead cannot reach fields that aren't theirs", () => {
  it("a bonus % change is dropped, and the stored one survives", () => {
    const res = write(vicLead, { V1: { bpEdit: 0.5, ipmEdit: 0.8 } }, { V1: { bpEdit: 0.2 } });
    expect(res.overrides.V1).toEqual({ bpEdit: 0.2, ipmEdit: 0.8 });
    expect(res.rejected).toContain("field bpEdit on V1");
  });

  it("a lock is dropped, and an admin's existing lock survives", () => {
    const res = write(
      vicLead,
      { V1: { ipmEdit: 0.8, locked: false } },
      { V1: { locked: true, lockedFinal: 1234 } }
    );
    expect(res.overrides.V1).toEqual({
      locked: true,
      lockedFinal: 1234,
      ipmEdit: 0.8,
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
});

describe("saving does not erase anyone else's work", () => {
  const current: Overrides = {
    V1: { ipmEdit: 0.9 },
    N1: { ipmEdit: 0.7, daEdit: 500 },
    S1: { daEdit: 250 },
  };

  it("a VIC lead saving only their row leaves NSW and shared untouched", () => {
    const res = write(vicLead, { V1: { ipmEdit: 1 } }, current);
    expect(res.overrides.N1).toEqual({ ipmEdit: 0.7, daEdit: 500 });
    expect(res.overrides.S1).toEqual({ daEdit: 250 });
    expect(res.overrides.V1).toEqual({ ipmEdit: 1 });
  });

  it("omitting their own row clears it — that is how a value is removed", () => {
    const res = write(vicLead, {}, { ...current, V2: { daEdit: 100 } });
    expect(res.overrides.V1).toBeUndefined();
    expect(res.overrides.V2).toBeUndefined();
    // and still nothing of anyone else's moved
    expect(res.overrides.N1).toEqual({ ipmEdit: 0.7, daEdit: 500 });
  });

  it("clearing their own row keeps an admin's lock on it", () => {
    const res = write(vicLead, {}, { V1: { ipmEdit: 0.9, locked: true, lockedFinal: 42 } });
    expect(res.overrides.V1).toEqual({ locked: true, lockedFinal: 42 });
  });

  it("an admin saving the whole doc still replaces it, exactly as before", () => {
    const res = write(admin, { V1: { ipmEdit: 1 } }, current);
    expect(res.overrides).toEqual({ V1: { ipmEdit: 1 } });
  });
});

/*
 * There is deliberately no "revoked user" case here: Scope.rule is typed as
 * GrantingRule, `scopeForUser` returns null for a revoked email, and every
 * route refuses a null scope before reaching this module. The type system
 * holds that line, so a runtime test would only assert unreachable code.
 */
