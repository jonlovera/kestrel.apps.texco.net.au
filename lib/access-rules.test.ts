import { describe, it, expect } from "vitest";
import { effectiveRules, OWNER_EMAIL, type AccessRule } from "./access-rules";

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
