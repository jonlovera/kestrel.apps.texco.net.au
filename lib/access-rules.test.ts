import { describe, it, expect } from "vitest";
import {
  effectiveRules,
  ruleMatches,
  AccessRuleSchema,
  OWNER_EMAIL,
  type AccessRule,
} from "./access-rules";

const full: AccessRule = { type: "full" };
const vic: AccessRule = {
  type: "state",
  states: ["VIC"],
  visibleFields: ["final"],
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
