/**
 * Entitlement tests for the pure payload builder: field stripping is byte
 * removal, not pixel hiding. A user whose scope doesn't grant a field must
 * never receive it in the serialised payload — regardless of any
 * presentation/column configuration (asserted again in the column-config
 * suite once that exists).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Dataset } from "./schema";
import type { Scope } from "./access";
import { buildPayloadCore } from "./scope-core";

const data = JSON.parse(
  readFileSync(join(__dirname, "..", "data", "bonus.json"), "utf-8")
) as Dataset;

const user = {
  name: "Test",
  email: "vic.leader@texco.net.au",
  scopeLabel: "VIC — read only",
};

const vicScopeNoPkg: Scope = {
  email: user.email,
  rule: {
    type: "state",
    states: ["VIC"],
    visibleFields: ["ipm", "bipm", "calc", "f25", "da", "yoy", "final"],
    editableFields: ["da"],
  canLock: false,
  canActAs: [],
  },
  canEdit: false,
  visibleFields: ["ipm", "bipm", "calc", "f25", "da", "yoy", "final"],
  label: "VIC — read only",
};

describe("field stripping strips bytes, not pixels", () => {
  it("a state-scoped user's serialised payload contains no package field or value", () => {
    const payload = buildPayloadCore(data, {}, vicScopeNoPkg, user);
    const json = JSON.stringify(payload);

    expect(json).not.toContain('"pkg"');
    expect(json).not.toContain('"bp"');

    // No VIC employee's actual package figure appears anywhere in the bytes.
    for (const e of data.emp) {
      if (e.st === "VIC") {
        expect(json).not.toContain(`:${e.pkg},`);
        expect(json).not.toContain(`:${e.pkg}}`);
      }
    }
  });

  it("rows are filtered to the scope's state only", () => {
    const payload = buildPayloadCore(data, {}, vicScopeNoPkg, user);
    if (payload.mode !== "readonly") throw new Error("expected readonly payload");
    expect(payload.rows.length).toBe(data.emp.filter((e) => e.st === "VIC").length);
    expect(payload.rows.every((r) => r.st === "VIC")).toBe(true);
  });

  it("a subset scope receives only the listed ids and fields", () => {
    const twoIds = [data.emp[0].id, data.emp[1].id];
    const scope: Scope = {
      email: "board@texco.net.au",
      rule: {
        type: "subset",
        employeeIds: twoIds,
        visibleFields: ["final"],
        editableFields: ["da"],
      canLock: false,
      canActAs: [],
      },
      canEdit: false,
      visibleFields: ["final"],
      label: "Selected employees — read only",
    };
    const payload = buildPayloadCore(data, {}, scope, {
      ...user,
      email: scope.email,
    });
    if (payload.mode !== "readonly") throw new Error("expected readonly payload");
    expect(payload.rows.map((r) => r.id).sort()).toEqual([...twoIds].sort());
    const json = JSON.stringify(payload);
    for (const k of ['"pkg"', '"bp"', '"ipm"', '"bipm"', '"calc"', '"f25"', '"da"', '"yoy"']) {
      expect(json).not.toContain(k);
    }
    expect(json).toContain('"final"');
  });
});

describe("a read-only payload carries a save baseline scoped like everything else", () => {
  const vicId = data.emp.find((e) => e.st === "VIC")!.id;
  const nswId = data.emp.find((e) => e.st === "NSW")!.id;
  const stored = {
    [vicId]: { daEdit: 123, ipmEdit: 0.85 },
    [nswId]: { daEdit: 456 },
  };

  it("carries the overrides version so a lead's save is not a guaranteed 409", () => {
    const payload = buildPayloadCore(data, stored, vicScopeNoPkg, user, {
      overridesVersion: 7,
    });
    if (payload.mode !== "readonly") throw new Error("expected readonly payload");
    expect(payload.overridesVersion).toBe(7);
  });

  it("baselines only their rows and their granted fields — bytes, not pixels", () => {
    const payload = buildPayloadCore(data, stored, vicScopeNoPkg, user, {
      overridesVersion: 7,
    });
    if (payload.mode !== "readonly") throw new Error("expected readonly payload");
    // granted Discretionary only, so ipmEdit is stripped even on their row
    expect(payload.overrides).toEqual({ [vicId]: { daEdit: 123 } });
    const json = JSON.stringify(payload.overrides);
    expect(json).not.toContain(nswId);
    expect(json).not.toContain("456");
  });

  it("a purely read-only scope gets an empty baseline", () => {
    const readOnly: Scope = {
      ...vicScopeNoPkg,
      rule: {
        type: "state",
        states: ["VIC"],
        visibleFields: vicScopeNoPkg.visibleFields,
        editableFields: [],
        canLock: false,
        canActAs: [],
      },
    };
    const payload = buildPayloadCore(data, stored, readOnly, user);
    if (payload.mode !== "readonly") throw new Error("expected readonly payload");
    expect(payload.overrides).toEqual({});
  });
});


describe("a lead sees their own pool and nothing wider", () => {
  const vic = buildPayloadCore(data, {}, vicScopeNoPkg, user);
  if (vic.mode !== "readonly") throw new Error("expected readonly");

  it("gets a header about their own scope, not a state's", () => {
    const h = vic.managerPool;
    expect(h.people).toBe(vic.rows.length);
    expect(h.pool).toBeGreaterThan(0);
    expect(h.allocated).toBeGreaterThan(0);
    expect(h.remaining).toBeCloseTo(h.pool - h.allocated, 12);
  });

  it("Allocated is the figure the table footer totals, so the two agree", () => {
    // same definition, and the payload carries the rows it was measured over
    const fromRows = vic.rows.reduce((s, r) => s + (r.final ?? 0), 0);
    expect(vic.managerPool.allocated).toBeCloseTo(fromRows, 6);
  });

  it("the group cap and group total never reach the payload", () => {
    const json = JSON.stringify(vic);
    expect(json).not.toContain('"gCap"');
    expect(json).not.toContain('"caps"');
    expect(json).not.toContain(String(data.gCap));
    // the whole-company bonus total must not be derivable from the bytes
    expect(Math.round(vic.managerPool.allocated)).toBeLessThan(
      Math.round(data.gCap)
    );
  });

  it("the other state's figures never reach the payload", () => {
    const json = JSON.stringify(vic);
    expect(json).not.toContain('"NSW pool"');
    expect(json).not.toContain(String(data.nCap));
    expect(vic.rows.every((r) => r.st === "VIC")).toBe(true);
  });

  it("a two-state lead gets one combined header and still no group figure", () => {
    const both: Scope = {
      ...vicScopeNoPkg,
      rule: {
        type: "state",
        states: ["VIC", "NSW"],
        visibleFields: vicScopeNoPkg.visibleFields,
        editableFields: ["da"],
      canLock: false,
      canActAs: [],
      },
    };
    const payload = buildPayloadCore(data, {}, both, user);
    if (payload.mode !== "readonly") throw new Error();
    // one header covering both states — the pool they answer for is the sum of
    // their own rows' draw, not a card per state pool
    expect(payload.managerPool.people).toBe(payload.rows.length);
    expect(payload.managerPool.pool).toBeGreaterThan(vic.managerPool.pool);
    expect(JSON.stringify(payload)).not.toContain('"VIC pool"');
    expect(JSON.stringify(payload)).not.toContain('"NSW pool"');
    expect(JSON.stringify(payload)).not.toContain('"gCap"');
  });

  // vp/np are the split, and a split is a property of the fractions rather
  // than of the state label: a VIC employee doing a portion of NSW work
  // carries one, and a scoped lead granted the fields should see it.
  it("sends the split for any fractional row, whatever its state, and never for a whole-pool row", () => {
    const first = data.emp[0];
    const withSplit: Dataset = {
      ...data,
      emp: data.emp.map((e) =>
        e.id === first.id ? { ...e, st: "VIC" as const, vp: 0.92, np: 0.08 } : e
      ),
    };
    const fields = [...vicScopeNoPkg.visibleFields, "vp", "np"] as const;
    const scope: Scope = {
      ...vicScopeNoPkg,
      rule: {
        type: "state",
        states: ["VIC"],
        visibleFields: [...fields],
        editableFields: ["da"],
        canLock: false,
        canActAs: [],
      },
      visibleFields: [...fields],
    };
    const payload = buildPayloadCore(withSplit, {}, scope, user);
    if (payload.mode !== "readonly") throw new Error();

    const split = payload.rows.find((r) => r.id === first.id);
    expect(split).toMatchObject({ st: "VIC", vp: 0.92, np: 0.08 });
    // everyone else in this fixture is a clean 1/0, so they carry no split
    for (const r of payload.rows) {
      if (r.id !== first.id) expect(r.vp).toBeUndefined();
    }
  });

  it("a subset lead gets a header too — an arbitrary list of people still draws from a pool", () => {
    const subset: Scope = {
      ...vicScopeNoPkg,
      rule: {
        type: "subset",
        employeeIds: [data.emp[0].id],
        visibleFields: ["final"],
        editableFields: ["da"],
      canLock: false,
      canActAs: [],
      },
      visibleFields: ["final"],
    };
    const payload = buildPayloadCore(data, {}, subset, user);
    if (payload.mode !== "readonly") throw new Error();
    // the old state card gave them nothing, because a subset has no state
    // pool. Their draw is still measurable, and it is what they answer for.
    expect(payload.managerPool.people).toBe(1);
    expect(payload.managerPool.pool).toBeGreaterThan(0);
  });
});
