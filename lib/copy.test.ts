/**
 * Editable-wording tests. Same load-bearing assertion as columns.test.ts:
 * wording has ZERO effect on calculation or entitlement — it is pixels, not
 * bytes of data.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Dataset } from "./schema";
import type { Scope } from "./access";
import { CopySchema, DEFAULT_COPY, resolveCopy, type Copy } from "./copy";
import { buildPayloadCore } from "./scope-core";

const data = JSON.parse(
  readFileSync(join(__dirname, "..", "data", "bonus.json"), "utf-8")
) as Dataset;

const vicScope: Scope = {
  email: "vic@x.com",
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

const fullScope: Scope = {
  email: "admin@x.com",
  rule: { type: "full", canEditCaps: false, canActAs: [] },
  canEdit: true,
  visibleFields: ["pkg", "bp", "ipm", "bipm", "calc", "f25", "da", "yoy", "final"],
  label: "Full access — can edit",
};

const user = { name: "T", email: "t@x.com", scopeLabel: "L" };

const rewritten: Copy = {
  schemeName: "Totally Different Scheme",
  bannerText: "FINAL",
  bannerVisible: false,
  poolTitles: { vic: "Southern", nsw: "Northern", group: "Everyone" },
  footerText: "nothing to see here",
};

describe("resolveCopy", () => {
  it("an empty/absent doc resolves to exactly the defaults", () => {
    expect(resolveCopy(null)).toEqual(DEFAULT_COPY);
    expect(resolveCopy({})).toEqual(DEFAULT_COPY);
    expect(resolveCopy(undefined)).toEqual(DEFAULT_COPY);
  });

  it("a partial doc keeps defaults for the fields it omits", () => {
    const resolved = resolveCopy({ bannerText: "Final — approved" });
    expect(resolved.bannerText).toBe("Final — approved");
    expect(resolved.schemeName).toBe(DEFAULT_COPY.schemeName);
    expect(resolved.poolTitles).toEqual(DEFAULT_COPY.poolTitles);
  });

  it("a partial poolTitles fills the missing titles from defaults", () => {
    const resolved = resolveCopy({ poolTitles: { vic: "Victoria" } });
    expect(resolved.poolTitles.vic).toBe("Victoria");
    expect(resolved.poolTitles.nsw).toBe(DEFAULT_COPY.poolTitles.nsw);
    expect(resolved.poolTitles.group).toBe(DEFAULT_COPY.poolTitles.group);
  });

  it("bannerVisible: false survives the merge (it is not falsy-defaulted)", () => {
    expect(resolveCopy({ bannerVisible: false }).bannerVisible).toBe(false);
  });

  it("a corrupt doc falls back to defaults rather than throwing", () => {
    expect(resolveCopy({ schemeName: 42 })).toEqual(DEFAULT_COPY);
    expect(resolveCopy("garbage")).toEqual(DEFAULT_COPY);
  });

  it("the defaults are themselves valid", () => {
    expect(CopySchema.safeParse(DEFAULT_COPY).success).toBe(true);
  });
});

describe("CopySchema bounds", () => {
  it("rejects empty and oversized strings", () => {
    expect(CopySchema.safeParse({ ...DEFAULT_COPY, schemeName: "" }).success).toBe(false);
    expect(
      CopySchema.safeParse({ ...DEFAULT_COPY, schemeName: "x".repeat(81) }).success
    ).toBe(false);
    expect(
      CopySchema.safeParse({ ...DEFAULT_COPY, footerText: "x".repeat(161) }).success
    ).toBe(false);
  });

  it("trims surrounding whitespace", () => {
    const parsed = CopySchema.parse({ ...DEFAULT_COPY, bannerText: "  Draft  " });
    expect(parsed.bannerText).toBe("Draft");
  });
});

describe("snapshot round trip", () => {
  // lib/snapshots.ts stores the resolved copy and, on restore, feeds
  // `state.copy` back through CopySchema.safeParse before saving it. These
  // cover that path's two branches without needing the server-only wrapper.
  it("a captured copy doc survives the schema on the way back out", () => {
    const captured = JSON.parse(JSON.stringify(rewritten)); // as jsonb would
    const parsed = CopySchema.safeParse(captured);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(rewritten);
  });

  it("a snapshot predating editable wording is skipped, not applied as empty", () => {
    // older snapshots have no `copy` key at all — restore must leave the
    // current wording alone rather than wiping it
    for (const older of [undefined, null]) {
      expect(CopySchema.safeParse(older).success).toBe(false);
    }
  });
});

describe("wording has zero effect on calculation", () => {
  it("every numeric output is strictly identical under default vs rewritten copy", () => {
    const a = buildPayloadCore(data, {}, vicScope, user, { copy: DEFAULT_COPY });
    const b = buildPayloadCore(data, {}, vicScope, user, { copy: rewritten });
    if (a.mode !== "readonly" || b.mode !== "readonly") throw new Error("expected readonly");

    expect(a.rows.length).toBe(b.rows.length);
    for (let i = 0; i < a.rows.length; i++) {
      for (const f of ["ipm", "bipm", "calc", "f25", "da", "yoy", "final"] as const) {
        expect(a.rows[i][f]).toBe(b.rows[i][f]); // strict — wording must not move a bit
      }
    }
    expect(a.poolCards[0].stateBonuses).toBe(b.poolCards[0].stateBonuses);
    expect(a.poolCards[0].utilPct).toBe(b.poolCards[0].utilPct);
  });
});

describe("wording does not affect entitlement", () => {
  it("a read-only scope still receives no unentitled field, whatever the copy", () => {
    const payload = buildPayloadCore(data, {}, vicScope, user, { copy: rewritten });
    const json = JSON.stringify(payload);
    expect(json).not.toContain('"pkg"');
    expect(json).not.toContain('"bp"');
  });

  it("an editor gets the whole wording doc", () => {
    const ed = buildPayloadCore(data, {}, fullScope, user, { copy: rewritten });
    expect(ed.copy).toEqual(rewritten);
  });

  it("a read-only user gets the wording but NOT the pool-title map", () => {
    // their card titles arrive already resolved, so shipping the map as well
    // would name pools they can't see ("New South Wales", "Everyone")
    const ro = buildPayloadCore(data, {}, vicScope, user, { copy: rewritten });
    if (ro.mode !== "readonly") throw new Error("expected readonly");
    expect(ro.copy).toEqual({
      schemeName: rewritten.schemeName,
      bannerText: rewritten.bannerText,
      bannerVisible: rewritten.bannerVisible,
      footerText: rewritten.footerText,
    });
    expect("poolTitles" in ro.copy).toBe(false);

    const json = JSON.stringify(ro);
    expect(json).not.toContain(rewritten.poolTitles.nsw);
    expect(json).not.toContain(rewritten.poolTitles.group);
    // their own state's title is the one that does come through, on the card
    expect(ro.poolCards[0].title).toBe(rewritten.poolTitles.vic);
  });

  it("renaming a pool card reaches state leads too", () => {
    const ro = buildPayloadCore(data, {}, vicScope, user, {
      copy: { ...DEFAULT_COPY, poolTitles: { ...DEFAULT_COPY.poolTitles, vic: "Victoria" } },
    });
    if (ro.mode !== "readonly") throw new Error();
    expect(ro.poolCards[0].title).toBe("Victoria");
  });

  it("omitting copy falls back to the defaults, so first load reads identically", () => {
    const payload = buildPayloadCore(data, {}, fullScope, user);
    expect(payload.copy).toEqual(DEFAULT_COPY);
  });
});
