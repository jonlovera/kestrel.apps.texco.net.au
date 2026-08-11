import { describe, it, expect } from "vitest";
import {
  effectiveRules,
  ruleMatches,
  AccessRuleSchema,
  OWNER_EMAIL,
  type AccessRule,
  describeEditing,
  dropInvalidRules,
} from "./access-rules";

const full: AccessRule = { type: "full" };
const vic: AccessRule = {
  type: "state",
  states: ["VIC"],
  visibleFields: ["final"],
  editableFields: ["da"],
};
const none: AccessRule = { type: "none" };

describe("effectiveRules merge", () => {
  it("db overlay wins over env, env wins over code seed", () => {
    const out = effectiveRules(
      { "a@x.com": full },
      { "a@x.com": vic },
      {}
    );
    expect(out["a@x.com"]).toEqual({ rule: vic, source: "env" });
    const out2 = effectiveRules(
      { "a@x.com": full },
      { "a@x.com": vic },
      { "a@x.com": full }
    );
    expect(out2["a@x.com"]).toEqual({ rule: full, source: "db" });
  });

  it("a 'none' overlay rule shadows a code-seeded entry", () => {
    const out = effectiveRules({ "a@x.com": full }, {}, { "a@x.com": none });
    expect(out["a@x.com"]).toBeUndefined();
  });

  it("emails are case-insensitive across layers", () => {
    const out = effectiveRules({ "A@X.com": full }, {}, { "a@x.COM": vic });
    expect(out["a@x.com"]).toEqual({ rule: vic, source: "db" });
  });

  it("the owner cannot be shadowed by 'none'", () => {
    const out = effectiveRules({ [OWNER_EMAIL]: full }, {}, { [OWNER_EMAIL]: none });
    expect(out[OWNER_EMAIL]).toEqual({ rule: full, source: "code" });
  });

  it("a db entry for a new person simply appears", () => {
    const out = effectiveRules({}, {}, { "new@x.com": vic });
    expect(out["new@x.com"]).toEqual({ rule: vic, source: "db" });
  });
});

describe("group rules: state and/or role, standing rather than a fixed list", () => {
  const people = [
    { id: "V1", st: "VIC", pos: "Site Manager" },
    { id: "V2", st: "VIC", pos: "Project Manager" },
    { id: "N1", st: "NSW", pos: "Site Manager" },
    { id: "S1", st: "SHARED", pos: "General Counsel" },
  ];
  const match = (rule: Parameters<typeof ruleMatches>[0]) =>
    people.filter((p) => ruleMatches(rule, p)).map((p) => p.id);

  const group = (states: string[], positions: string[]) =>
    ({
      type: "group" as const,
      states: states as ("VIC" | "NSW" | "SHARED")[],
      positions,
      visibleFields: [],
      editableFields: [],
    });

  it("state and role together intersect", () => {
    expect(match(group(["VIC"], ["Site Manager"]))).toEqual(["V1"]);
    expect(match(group(["NSW"], ["Site Manager"]))).toEqual(["N1"]);
  });

  it("an empty role list means every role in those states", () => {
    expect(match(group(["VIC"], []))).toEqual(["V1", "V2"]);
  });

  it("an empty state list means that role in every state", () => {
    expect(match(group([], ["Site Manager"]))).toEqual(["V1", "N1"]);
  });

  it("several roles union within the states", () => {
    expect(match(group(["VIC"], ["Site Manager", "Project Manager"]))).toEqual(["V1", "V2"]);
  });

  it("the schema refuses a group with neither dimension — it would match everyone", () => {
    expect(
      AccessRuleSchema.safeParse({ type: "group", states: [], positions: [], visibleFields: [] })
        .success
    ).toBe(false);
  });

  it("it keeps matching as people arrive, unlike a fixed subset", () => {
    const rule = group(["VIC"], ["Site Manager"]);
    const joined = [...people, { id: "V3", st: "VIC", pos: "Site Manager" }];
    expect(joined.filter((p) => ruleMatches(rule, p)).map((p) => p.id)).toEqual(["V1", "V3"]);
  });
});

describe("describeEditing", () => {
  const state = (editableFields: "da"[]) =>
    ({
      type: "state" as const,
      states: ["VIC" as const],
      visibleFields: [],
      editableFields,
    });

  it("names what they may set", () => {
    expect(describeEditing(state(["da"]))).toBe("can set Discretionary");
  });

  it("says read only when nothing is granted", () => {
    // Includes anyone whose stored rule still lists "ipm" — the schema no
    // longer accepts it as a grantable field, so it can never appear here.
    expect(describeEditing(state([]))).toBe("read only");
  });

  it("full access is never read only", () => {
    expect(describeEditing({ type: "full" })).toBe("can edit");
  });
});

describe("dropInvalidRules", () => {
  /**
   * The overlay is validated as one record, so without this a single bad rule
   * makes loadDoc fall back to {} and silently revokes everyone's access at
   * once. One bad rule should cost one person.
   */
  const good = { type: "state", states: ["VIC"], visibleFields: [], editableFields: [] };

  it("keeps the rules that parse and drops the ones that don't", () => {
    const cleaned = dropInvalidRules({
      "a@x.com": good,
      "b@x.com": { type: "state", states: ["MARS"], visibleFields: [] },
      "c@x.com": { type: "full" },
    }) as Record<string, unknown>;
    expect(Object.keys(cleaned).sort()).toEqual(["a@x.com", "c@x.com"]);
  });

  it("passes a healthy overlay through untouched", () => {
    const overlay = { "a@x.com": good };
    expect(dropInvalidRules(overlay)).toEqual(overlay);
  });

  it("keeps a rule written before editableFields existed", () => {
    const legacy = { "a@x.com": { type: "state", states: ["VIC"], visibleFields: ["final"] } };
    expect(Object.keys(dropInvalidRules(legacy) as object)).toEqual(["a@x.com"]);
  });

  it("strips a deprecated 'ipm' grant rather than dropping the whole rule", () => {
    // IPM used to be grantable and stored rules from before this change may
    // still list it. Failing that rule outright would revoke the person's
    // entire access, not just their (already-inert) IPM permission.
    const legacy = {
      "a@x.com": {
        type: "state",
        states: ["VIC"],
        visibleFields: ["final"],
        editableFields: ["ipm", "da"],
      },
    };
    const cleaned = dropInvalidRules(legacy) as Record<
      string,
      { editableFields: string[] }
    >;
    expect(Object.keys(cleaned)).toEqual(["a@x.com"]);
    expect(cleaned["a@x.com"].editableFields).toEqual(["da"]);
  });

  it("strips 'ipm' even when it was the only grant, leaving read only", () => {
    const legacy = {
      "a@x.com": {
        type: "state",
        states: ["VIC"],
        visibleFields: ["final"],
        editableFields: ["ipm"],
      },
    };
    const cleaned = dropInvalidRules(legacy) as Record<
      string,
      { editableFields: string[] }
    >;
    expect(cleaned["a@x.com"].editableFields).toEqual([]);
  });

  it("leaves a non-object alone rather than inventing an overlay", () => {
    expect(dropInvalidRules(null)).toBe(null);
    expect(dropInvalidRules([1, 2])).toEqual([1, 2]);
  });
});
