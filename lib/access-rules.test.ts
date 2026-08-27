import { describe, it, expect } from "vitest";
import {
  effectiveRules,
  ruleMatches,
  AccessRuleSchema,
  OWNER_EMAIL,
  type AccessRule,
  describeEditing,
  describeRule,
  dropInvalidRules,
  rewriteActAsReferences,
} from "./access-rules";

const full: AccessRule = { type: "full", canEditCaps: false, canEditVicSiteManagers: false, canRecalculatePool: false, canRevokeIssued: false, canActAs: [], canDownloadLetter: false };
const vic: AccessRule = {
  type: "state",
  states: ["VIC"],
  visibleFields: ["final"],
  editableFields: ["da"],
  canLock: false,
  canActAs: [], canDownloadLetter: false,
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
      canLock: false,
      canActAs: [], canDownloadLetter: false,
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
      canLock: false,
      canActAs: [], canDownloadLetter: false,
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
    expect(describeEditing({ type: "full", canEditCaps: false, canEditVicSiteManagers: false, canRecalculatePool: false, canRevokeIssued: false, canActAs: [], canDownloadLetter: false })).toBe("can edit");
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

  it("keeps a rule granting 'ipm' — it's a live grant, not a deprecated one", () => {
    // IPM used to be stripped as a deprecated grant; it's since been reopened
    // (lib/write-scope.ts) and is now an ordinary member of EDITABLE_FIELDS,
    // so a rule listing it parses and keeps it exactly as stored.
    const rule = {
      "a@x.com": {
        type: "state",
        states: ["VIC"],
        visibleFields: ["final"],
        editableFields: ["ipm", "da"],
      },
    };
    const cleaned = dropInvalidRules(rule) as Record<
      string,
      { editableFields: string[] }
    >;
    expect(Object.keys(cleaned)).toEqual(["a@x.com"]);
    expect(cleaned["a@x.com"].editableFields).toEqual(["ipm", "da"]);
  });

  it("still drops a rule for a genuinely unknown editableFields value", () => {
    // Distinct from the "ipm" case above: an unrecognised field name is a
    // real validation failure, not a retired-but-tolerated grant, so the
    // whole rule is dropped the same as any other malformed entry.
    const bad = {
      "a@x.com": {
        type: "state",
        states: ["VIC"],
        visibleFields: ["final"],
        editableFields: ["not-a-real-field"],
      },
    };
    expect(Object.keys(dropInvalidRules(bad) as object)).toEqual([]);
  });

  it("leaves a non-object alone rather than inventing an overlay", () => {
    expect(dropInvalidRules(null)).toBe(null);
    expect(dropInvalidRules([1, 2])).toEqual([1, 2]);
  });

  it("keeps a rule stored before canActAs existed", () => {
    const stored = {
      "lead@texco.net.au": {
        type: "state",
        states: ["VIC"],
        visibleFields: ["final"],
        editableFields: ["da"],
        canLock: false,
      },
    };
    expect(Object.keys(dropInvalidRules(stored) as object)).toEqual([
      "lead@texco.net.au",
    ]);
  });
});

/**
 * The act-as delegation on the rule sentence and across an email change.
 */
describe("the canActAs delegation", () => {
  it("describeRule names the delegation — the history must record it", () => {
    expect(
      describeRule({ ...vic, canActAs: ["jglick@texco.net.au"], canDownloadLetter: false })
    ).toBe("VIC / can set Discretionary; can act for jglick@texco.net.au");
    expect(
      describeRule({ type: "full", canEditCaps: false, canEditVicSiteManagers: false, canRecalculatePool: false, canRevokeIssued: false, canActAs: ["jglick@texco.net.au"], canDownloadLetter: false })
    ).toBe("full access; can act for jglick@texco.net.au");
    expect(describeRule(vic)).not.toContain("can act for");
  });

  it("describeRule names the VIC site managers grant — sixteen fixed bonuses hang off it", () => {
    expect(
      describeRule({ type: "full", canEditCaps: false, canEditVicSiteManagers: true, canRecalculatePool: false, canRevokeIssued: false, canActAs: [], canDownloadLetter: false })
    ).toBe("full access; can adjust VIC site managers");
    expect(
      describeRule({ type: "full", canEditCaps: false, canEditVicSiteManagers: true, canRecalculatePool: false, canRevokeIssued: false, canActAs: ["jglick@texco.net.au"], canDownloadLetter: true })
    ).toBe("full access; can adjust VIC site managers; can download letters; can act for jglick@texco.net.au");
  });

  it("rewriteActAsReferences moves a reference to a changed email", () => {
    const overlay: Record<string, AccessRule> = {
      "clint@texco.net.au": { ...vic, canActAs: ["old@texco.net.au"], canDownloadLetter: false },
      "other@texco.net.au": { ...vic },
    };
    const { overlay: out, changed } = rewriteActAsReferences(
      overlay,
      "old@texco.net.au",
      "new@texco.net.au"
    );
    expect(changed).toEqual(["clint@texco.net.au"]);
    const clint = out["clint@texco.net.au"];
    if (clint.type === "none") throw new Error("unexpected tombstone");
    expect(clint.canActAs).toEqual(["new@texco.net.au"]);
    // untouched rules come through identical
    expect(out["other@texco.net.au"]).toBe(overlay["other@texco.net.au"]);
  });

  it("rewriteActAsReferences deduplicates when the new email was already listed", () => {
    const overlay: Record<string, AccessRule> = {
      "clint@texco.net.au": {
        ...vic,
        canActAs: ["old@texco.net.au", "new@texco.net.au"], canDownloadLetter: false,
      },
    };
    const { overlay: out } = rewriteActAsReferences(
      overlay,
      "old@texco.net.au",
      "new@texco.net.au"
    );
    const clint = out["clint@texco.net.au"];
    if (clint.type === "none") throw new Error("unexpected tombstone");
    expect(clint.canActAs).toEqual(["new@texco.net.au"]);
  });

  it("rewriteActAsReferences matches case-insensitively and reports nothing when nothing matched", () => {
    const overlay: Record<string, AccessRule> = {
      "clint@texco.net.au": { ...vic, canActAs: ["Old@Texco.net.au"], canDownloadLetter: false },
    };
    const hit = rewriteActAsReferences(overlay, "old@texco.net.au", "new@texco.net.au");
    expect(hit.changed).toEqual(["clint@texco.net.au"]);
    const miss = rewriteActAsReferences(overlay, "absent@texco.net.au", "new@texco.net.au");
    expect(miss.changed).toEqual([]);
    expect(miss.overlay).toEqual(overlay);
  });
});


/**
 * `canRecalculatePool` — the grant for the one press that re-bases every
 * eligible bonus. Modelled on `canEditCaps`: full rules only, defaulted false,
 * and never conferred by full access alone.
 */
describe("canRecalculatePool", () => {
  it("defaults to false on a full rule that does not mention it", () => {
    const parsed = AccessRuleSchema.parse({ type: "full" });
    expect(parsed).toMatchObject({ canRecalculatePool: false });
  });

  it("a stored rule written before the grant existed parses, ungranted", () => {
    // The parse-safety that matters: one unparseable rule revokes the whole
    // overlay, so an older document must come back valid and NOT granted.
    const parsed = AccessRuleSchema.parse({
      type: "full",
      canEditCaps: true,
      canEditVicSiteManagers: true,
      canActAs: [],
      canDownloadLetter: true,
    });
    expect(parsed).toMatchObject({ canEditCaps: true, canRecalculatePool: false });
  });

  it("is carried through when granted", () => {
    const parsed = AccessRuleSchema.parse({ type: "full", canRecalculatePool: true });
    expect(parsed).toMatchObject({ canRecalculatePool: true });
  });

  it("is not offered on a lead rule at all", () => {
    const parsed = AccessRuleSchema.parse({
      type: "state",
      states: ["VIC"],
      visibleFields: ["final"],
      editableFields: ["da"],
      canRecalculatePool: true, canRevokeIssued: false,
    });
    expect(parsed).not.toHaveProperty("canRecalculatePool");
  });

  it("the access record says so, so a granted rule is visible on sight", () => {
    const granted = AccessRuleSchema.parse({ type: "full", canRecalculatePool: true });
    expect(describeRule(granted)).toContain("can recalculate the pool");
    const plain = AccessRuleSchema.parse({ type: "full" });
    expect(describeRule(plain)).not.toContain("can recalculate the pool");
  });
});


/**
 * `canRevokeIssued` — the key to the one-way door. Same shape as the other
 * narrow grants: full rules only, defaulted false, never conferred by full
 * access, and never by the ability to issue.
 */
describe("canRevokeIssued", () => {
  it("defaults to false on a full rule that does not mention it", () => {
    expect(AccessRuleSchema.parse({ type: "full" })).toMatchObject({
      canRevokeIssued: false,
    });
  });

  it("a rule stored before the grant existed parses, ungranted", () => {
    const parsed = AccessRuleSchema.parse({
      type: "full",
      canEditCaps: true,
      canEditVicSiteManagers: true,
      canRecalculatePool: true,
      canActAs: [],
      canDownloadLetter: true,
    });
    expect(parsed).toMatchObject({
      canRecalculatePool: true,
      canRevokeIssued: false,
    });
  });

  it("is carried through when granted", () => {
    expect(AccessRuleSchema.parse({ type: "full", canRevokeIssued: true })).toMatchObject({
      canRevokeIssued: true,
    });
  });

  it("is not offered on a lead rule at all", () => {
    const parsed = AccessRuleSchema.parse({
      type: "state",
      states: ["VIC"],
      visibleFields: ["final"],
      editableFields: ["da"],
      canRevokeIssued: true,
    });
    expect(parsed).not.toHaveProperty("canRevokeIssued");
  });

  it("the access record says so, so a granted rule is visible on sight", () => {
    const granted = AccessRuleSchema.parse({ type: "full", canRevokeIssued: true });
    expect(describeRule(granted)).toContain("can revert issued bonuses");
    expect(describeRule(AccessRuleSchema.parse({ type: "full" }))).not.toContain(
      "can revert issued bonuses"
    );
  });
});
