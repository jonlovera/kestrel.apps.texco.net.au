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
      rule: { type: "subset", employeeIds: twoIds, visibleFields: ["final"] },
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
