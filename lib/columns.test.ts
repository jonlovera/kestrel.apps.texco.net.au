/**
 * Presentation config tests. The load-bearing assertion: presentation has
 * ZERO effect on calculation — every derived number is strictly identical
 * under any column configuration; and entitlement stripping is unaffected
 * by a config that makes a column "visible".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Dataset } from "./schema";
import type { Scope } from "./access";
import { NUMERIC_FIELDS } from "./access-types";
import {
  DEFAULT_COLUMNS,
  effectiveColumns,
  normalizeConfig,
  scaleVisible,
  type ColumnConfig,
} from "./columns";
import { buildPayloadCore } from "./scope-core";

const data = JSON.parse(
  readFileSync(join(__dirname, "..", "data", "bonus.json"), "utf-8")
) as Dataset;

const allHidden: ColumnConfig = DEFAULT_COLUMNS.map((c) => ({
  ...c,
  visible: false,
}));
// scrambled: reversed order, silly labels, odd formats
const scrambled: ColumnConfig = [...DEFAULT_COLUMNS].reverse().map((c) => ({
  ...c,
  label: `X-${c.field}`,
  format: "number" as const,
  decimals: 3,
}));

const vicScope: Scope = {
  email: "vic@x.com",
  rule: {
    type: "state",
    states: ["VIC"],
    visibleFields: ["ipm", "bipm", "calc", "f25", "da", "yoy", "final"],
  },
  canEdit: false,
  visibleFields: ["ipm", "bipm", "calc", "f25", "da", "yoy", "final"],
  label: "VIC — read only",
};
const user = { name: "t", email: "vic@x.com", scopeLabel: "VIC — read only" };

describe("effectiveColumns = config-visible AND scope-visible", () => {
  it("hiding via config removes columns without touching scope", () => {
    const cols = effectiveColumns(allHidden, NUMERIC_FIELDS);
    expect(cols).toEqual([]);
  });

  it("scope caps what config can show", () => {
    const cols = effectiveColumns(DEFAULT_COLUMNS, ["final"]);
    expect(cols.map((c) => c.key)).toEqual(["final"]);
  });

  it("order, labels and formats come from config", () => {
    const cols = effectiveColumns(scrambled, NUMERIC_FIELDS);
    expect(cols.map((c) => c.key)).toEqual(
      [...NUMERIC_FIELDS].reverse()
    );
    expect(cols[0].label).toBe("X-final");
    expect(cols[0].format).toBe("number");
  });

  it("'scale' is a pseudo-column, never a table column", () => {
    const cols = effectiveColumns(DEFAULT_COLUMNS, NUMERIC_FIELDS);
    expect(cols.some((c) => (c.key as string) === "scale")).toBe(false);
    expect(scaleVisible(DEFAULT_COLUMNS)).toBe(true);
    expect(scaleVisible(allHidden)).toBe(false);
  });

  it("normalizeConfig restores missing fields from defaults", () => {
    const partial: ColumnConfig = [DEFAULT_COLUMNS[0]];
    expect(normalizeConfig(partial).length).toBe(DEFAULT_COLUMNS.length);
  });
});

describe("presentation has zero effect on calculation", () => {
  it("every numeric output is strictly identical under all-hidden vs scrambled configs", () => {
    const a = buildPayloadCore(data, {}, vicScope, user, 0, allHidden);
    const b = buildPayloadCore(data, {}, vicScope, user, 0, scrambled);
    if (a.mode !== "readonly" || b.mode !== "readonly") throw new Error("expected readonly");

    expect(a.rows.length).toBe(b.rows.length);
    for (let i = 0; i < a.rows.length; i++) {
      const ra = a.rows[i];
      const rb = b.rows[i];
      expect(ra.id).toBe(rb.id);
      for (const f of ["ipm", "bipm", "calc", "f25", "da", "yoy", "final"] as const) {
        expect(ra[f]).toBe(rb[f]); // strict — presentation must not move a bit
      }
    }
    expect(a.poolCards[0].stateBonuses).toBe(b.poolCards[0].stateBonuses);
    expect(a.poolCards[0].utilPct).toBe(b.poolCards[0].utilPct);
  });

  it("hiding the scale pseudo-column strips the scale figure from the payload bytes", () => {
    const withScale = buildPayloadCore(data, {}, vicScope, user, 0, DEFAULT_COLUMNS);
    const without = buildPayloadCore(data, {}, vicScope, user, 0, allHidden);
    if (withScale.mode !== "readonly" || without.mode !== "readonly") throw new Error();
    expect(withScale.poolCards[0].scale).toBeTypeOf("number");
    expect(without.poolCards[0].scale).toBeUndefined();
    expect(JSON.stringify(without.poolCards)).not.toContain('"scale"');
  });
});

describe("entitlement is unaffected by column config (non-negotiable #2)", () => {
  it("pkg config-visible for a scope without pkg still sends no pkg bytes", () => {
    const pkgVisible: ColumnConfig = DEFAULT_COLUMNS.map((c) => ({
      ...c,
      visible: true,
    }));
    const payload = buildPayloadCore(data, {}, vicScope, user, 0, pkgVisible);
    const json = JSON.stringify(payload);
    expect(json).not.toContain('"pkg"');
    // and the column list itself never advertises the unentitled field
    if (payload.mode !== "readonly") throw new Error();
    expect(payload.columns.some((c) => c.key === "pkg")).toBe(false);
  });
});
