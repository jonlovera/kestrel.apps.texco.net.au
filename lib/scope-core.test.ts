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

describe("a state lead sees their own pool and nothing wider", () => {
  const vic = buildPayloadCore(data, {}, vicScopeNoPkg, user);
  if (vic.mode !== "readonly") throw new Error("expected readonly");

  it("gets exactly one pool card — their own state", () => {
    expect(vic.poolCards).toHaveLength(1);
    expect(vic.poolCards[0].title).toBe("VIC pool");
  });

  it("the card carries their available pool, so cap and remaining can be shown", () => {
    const card = vic.poolCards[0];
    expect(card.available).toBeGreaterThan(0);
    expect(card.stateBonuses).toBeGreaterThan(0);
    // the utilisation bar is a proportion of that same figure
    expect(card.utilPct).toBeCloseTo(card.stateBonuses / card.available, 12);
  });

  it("the group cap and group total never reach the payload", () => {
    const json = JSON.stringify(vic);
    expect(json).not.toContain('"gCap"');
    expect(json).not.toContain('"caps"');
    expect(json).not.toContain(String(data.gCap));
    // the whole-company bonus total must not be derivable from the bytes
    const groupTotal = Math.round(
      vic.poolCards.reduce((s, c) => s + c.stateBonuses, 0)
    );
    expect(groupTotal).toBeLessThan(Math.round(data.gCap));
  });

  it("the other state's figures never reach the payload", () => {
    const json = JSON.stringify(vic);
    expect(json).not.toContain('"NSW pool"');
    expect(json).not.toContain(String(data.nCap));
    expect(vic.rows.every((r) => r.st === "VIC")).toBe(true);
  });

  it("a two-state lead gets a card per state and still no group figure", () => {
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
    expect(payload.poolCards.map((c) => c.title)).toEqual(["VIC pool", "NSW pool"]);
    expect(JSON.stringify(payload)).not.toContain('"gCap"');
  });

  it("a subset lead gets no pool card at all", () => {
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
    expect(payload.poolCards).toHaveLength(0);
  });
});
