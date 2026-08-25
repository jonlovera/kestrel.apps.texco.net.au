/**
 * Gate 2 of /api/state as a pure function. The case that matters most is the
 * one that used to be impossible to test through the route: an admin WITHOUT
 * the VIC site managers grant saving an unrelated edit, with a permitted
 * admin's lock/IPM/amount on a VIC site manager riding along in the merged
 * document. Those must survive untouched — reverted-to-stored, not deleted.
 */
import { describe, it, expect } from "vitest";
import type { Employee, Overrides } from "./schema";
import { NO_ALLOWANCE, type AdjustAllowance } from "./calc";
import { applySchemeRules } from "./scheme-gate";

const GRANT: AdjustAllowance = { vicSiteManagers: true };

function emp(over: Partial<Employee> & { id: string }): Employee {
  return {
    sn: "S", gn: over.id, pos: "P", dept: "D", mgr: "M", cat: "C",
    st: "VIC", vp: 1, np: 0, pkg: 2000, bp: 0.1, ipm: 1, bipm: 200, da: 0, f25: 0, sm: 0,
    ...over,
  };
}
const A = emp({ id: "A" }); // ordinary VIC row
const S = emp({ id: "S", sm: 1 }); // VIC site manager
const N = emp({ id: "N", sm: 1, st: "NSW", vp: 0, np: 1 }); // NSW site manager
const Z = emp({ id: "Z", vp: 0, np: 0 }); // draws from no pool
const known = new Map([A, S, N, Z].map((e) => [e.id, e]));

/** what a permitted admin stored on the VIC site manager earlier */
const stored: Overrides = { S: { locked: true, daEdit: 50, ipmEdit: 0.8, baseAmount: 160 } };

describe("applySchemeRules — a VIC site manager without the grant", () => {
  it("reverts an attempted lock / amount / IPM change to the STORED value, field by field", () => {
    const attempt: Overrides = { S: { locked: false, daEdit: 0, ipmEdit: 1, baseAmount: 160 } };
    const out = applySchemeRules(attempt, stored, known, NO_ALLOWANCE);
    expect(out.overrides.S).toEqual({ locked: true, daEdit: 50, ipmEdit: 0.8, baseAmount: 160 });
    expect(out.reverted).toEqual([{ empId: "S", fields: ["locked", "daEdit", "ipmEdit"] }]);
  });

  it("lets a permitted admin's stored figures ride through an unrelated save untouched — the hazard", () => {
    // the merged document carries S exactly as stored, plus this writer's own edit on A
    const merged: Overrides = { ...stored, A: { daEdit: 100 } };
    const out = applySchemeRules(merged, stored, known, NO_ALLOWANCE);
    expect(out.overrides.S).toEqual(stored.S);
    expect(out.overrides.A).toEqual({ daEdit: 100 });
    expect(out.reverted).toEqual([]);
  });

  it("drops the field when nothing was stored to fall back to", () => {
    const out = applySchemeRules({ S: { locked: true, daEdit: 25 } }, {}, known, NO_ALLOWANCE);
    expect(out.overrides.S).toBeUndefined(); // nothing left, so no entry at all
    expect(out.reverted).toEqual([{ empId: "S", fields: ["locked", "daEdit"] }]);
  });

  it("with the grant, the same attempt passes", () => {
    const attempt: Overrides = { S: { locked: false, daEdit: 0, ipmEdit: 1 } };
    const out = applySchemeRules(attempt, stored, known, GRANT);
    expect(out.overrides.S).toEqual({ locked: false, daEdit: 0, ipmEdit: 1 });
    expect(out.reverted).toEqual([]);
  });
});

describe("applySchemeRules — everyone else", () => {
  it("an NSW site manager is adjustable with or without the grant", () => {
    const attempt: Overrides = { N: { locked: true, daEdit: 10, ipmEdit: 0.5 } };
    for (const allow of [NO_ALLOWANCE, GRANT]) {
      const out = applySchemeRules(attempt, {}, known, allow);
      expect(out.overrides.N).toEqual(attempt.N);
      expect(out.reverted).toEqual([]);
    }
  });

  it("a row drawing from no pool loses its lock and amount outright; IPM stays advisory", () => {
    const out = applySchemeRules({ Z: { locked: true, daEdit: 10, ipmEdit: 0.5 } }, {}, known, GRANT);
    expect(out.overrides.Z).toEqual({ ipmEdit: 0.5 });
    expect(out.reverted).toEqual([{ empId: "Z", fields: ["locked", "daEdit"] }]);
  });

  it("floors IPM and bonus % at zero and leaves a negative discretionary alone", () => {
    const out = applySchemeRules({ A: { ipmEdit: -0.2, bpEdit: -1, daEdit: -300 } }, {}, known, NO_ALLOWANCE);
    expect(out.overrides.A).toEqual({ ipmEdit: 0, bpEdit: 0, daEdit: -300 });
  });

  it("ignores ids that are not on the roster", () => {
    const out = applySchemeRules({ GHOST: { daEdit: 1 } }, {}, known, NO_ALLOWANCE);
    expect(out.overrides).toEqual({});
  });
});
