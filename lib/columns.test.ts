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
  ColumnConfigSchema,
  DEFAULT_COLUMNS,
  dropRetiredFields,
  migrateRenamedLabels,
  IDENTITY_FIELDS,
  effectiveColumns,
  normalizeConfig,
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
    editableFields: ["da"],
  canLock: false,
  canActAs: [], canDownloadLetter: false,
  },
  canEdit: false,
  visibleFields: ["ipm", "bipm", "calc", "f25", "da", "yoy", "final"],
  label: "VIC — read only",
};
const user = { name: "t", email: "vic@x.com", scopeLabel: "VIC — read only" };

/** The figure columns of a result, ignoring the identity ones. */
const figures = (cols: { key: string; identity?: true }[]) =>
  cols.filter((c) => !c.identity).map((c) => c.key);
/** The identity columns of a result. */
const identities = (cols: { key: string; identity?: true }[]) =>
  cols.filter((c) => c.identity).map((c) => c.key);

describe("effectiveColumns = config-visible AND scope-visible", () => {
  it("hiding via config removes columns without touching scope", () => {
    const cols = effectiveColumns(allHidden, NUMERIC_FIELDS);
    expect(cols).toEqual([]);
  });

  it("scope caps what figure columns config can show", () => {
    const cols = effectiveColumns(DEFAULT_COLUMNS, ["final"]);
    expect(figures(cols)).toEqual(["final"]);
  });

  it("order, labels and formats come from config", () => {
    const cols = effectiveColumns(scrambled, NUMERIC_FIELDS);
    expect(figures(cols)).toEqual([...NUMERIC_FIELDS].reverse());
    expect(cols[0].label).toBe(`X-${NUMERIC_FIELDS[NUMERIC_FIELDS.length - 1]}`);
    expect(cols[0].format).toBe("number");
  });

  it("the retired scale pseudo-column is gone from the vocabulary", () => {
    const cols = effectiveColumns(DEFAULT_COLUMNS, NUMERIC_FIELDS);
    expect(cols.some((c) => (c.key as string) === "scale")).toBe(false);
    expect(DEFAULT_COLUMNS.some((c) => (c.field as string) === "scale")).toBe(false);
  });

  it("a stored config still holding a retired field loses that field, not the rest", () => {
    // otherwise the whole document fails validation and every column setting
    // she has chosen silently resets to defaults
    const legacy = [
      { field: "scale", visible: true, label: "Scale factor", format: "number", decimals: 4 },
      { field: "final", visible: true, label: "FY26 payment", format: "currency", decimals: 0 },
    ];
    const cleaned = ColumnConfigSchema.parse(dropRetiredFields(legacy));
    expect(cleaned.map((c) => c.field)).toEqual(["final"]);
    expect(cleaned[0].label).toBe("FY26 payment");
  });

  it("normalizeConfig restores missing fields from defaults", () => {
    const partial: ColumnConfig = [DEFAULT_COLUMNS[0]];
    expect(normalizeConfig(partial).length).toBe(DEFAULT_COLUMNS.length);
  });
});

describe("identity columns are config-gated but never scope-gated", () => {
  it("they appear even for a scope with no visible figure fields at all", () => {
    const cols = effectiveColumns(DEFAULT_COLUMNS, []);
    expect(figures(cols)).toEqual([]);
    // Category is hidden by default; the rest show
    expect(identities(cols)).toEqual(["name", "state", "pos", "dept", "mgr"]);
  });

  it("hiding one via config removes it", () => {
    const noDept = DEFAULT_COLUMNS.map((c) =>
      c.field === "dept" ? { ...c, visible: false } : c
    );
    expect(identities(effectiveColumns(noDept, NUMERIC_FIELDS))).not.toContain("dept");
  });

  it("they are marked identity and carry the text format", () => {
    const cols = effectiveColumns(DEFAULT_COLUMNS, NUMERIC_FIELDS);
    for (const c of cols.filter((x) => x.identity)) {
      expect(c.format).toBe("text");
      expect((IDENTITY_FIELDS as readonly string[])).toContain(c.key);
    }
  });

  it("default order puts the identity columns first, as the table always had", () => {
    const cols = effectiveColumns(DEFAULT_COLUMNS, NUMERIC_FIELDS);
    expect(cols.slice(0, 5).map((c) => c.key)).toEqual([
      "name",
      "state",
      "pos",
      "dept",
      "mgr",
    ]);
  });

  it("config can reorder an identity column among the figures", () => {
    const nameLast: ColumnConfig = [
      ...DEFAULT_COLUMNS.filter((c) => c.field !== "name"),
      DEFAULT_COLUMNS.find((c) => c.field === "name")!,
    ];
    const cols = effectiveColumns(nameLast, NUMERIC_FIELDS);
    expect(cols[cols.length - 1].key).toBe("name");
  });
});

describe("presentation has zero effect on calculation", () => {
  it("every numeric output is strictly identical under all-hidden vs scrambled configs", () => {
    const a = buildPayloadCore(data, {}, vicScope, user, { columnConfig: allHidden });
    const b = buildPayloadCore(data, {}, vicScope, user, { columnConfig: scrambled });
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
    expect(a.managerPool).toEqual(b.managerPool);
  });

});

describe("entitlement is unaffected by column config (non-negotiable #2)", () => {
  it("pkg config-visible for a scope without pkg still sends no pkg bytes", () => {
    const pkgVisible: ColumnConfig = DEFAULT_COLUMNS.map((c) => ({
      ...c,
      visible: true,
    }));
    const payload = buildPayloadCore(data, {}, vicScope, user, { columnConfig: pkgVisible });
    const json = JSON.stringify(payload);
    expect(json).not.toContain('"pkg"');
    // and the column list itself never advertises the unentitled field
    if (payload.mode !== "readonly") throw new Error();
    expect(payload.columns.some((c) => c.key === "pkg")).toBe(false);
  });

  it("every identity column visible still sends no pkg bytes", () => {
    // Identity columns bypass the scope gate by design — this proves that
    // widening the config to cover them did not widen entitlement with it.
    const allVisible: ColumnConfig = DEFAULT_COLUMNS.map((c) => ({
      ...c,
      visible: true,
    }));
    const payload = buildPayloadCore(data, {}, vicScope, user, {
      columnConfig: allVisible,
    });
    const json = JSON.stringify(payload);
    expect(json).not.toContain('"pkg"');
    expect(json).not.toContain('"bp"');
    if (payload.mode !== "readonly") throw new Error();
    expect(identities(payload.columns)).toContain("cat");
    expect(figures(payload.columns)).toEqual(vicScope.visibleFields);
  });

  it("a single-state read-only user never gets the State column, config regardless", () => {
    // it would be the same value on every row; this view has always dropped it
    const payload = buildPayloadCore(data, {}, vicScope, user, {
      columnConfig: DEFAULT_COLUMNS,
    });
    if (payload.mode !== "readonly") throw new Error();
    expect(payload.columns.some((c) => c.key === "state")).toBe(false);
  });

  it("a two-state read-only user does get it", () => {
    const bothScope: Scope = {
      ...vicScope,
      rule: {
        type: "state",
        states: ["VIC", "NSW"],
        visibleFields: ["final"],
        editableFields: ["da"],
      canLock: false,
      canActAs: [], canDownloadLetter: false,
      },
      visibleFields: ["final"],
    };
    const payload = buildPayloadCore(data, {}, bothScope, user, {
      columnConfig: DEFAULT_COLUMNS,
    });
    if (payload.mode !== "readonly") throw new Error();
    expect(payload.columns.some((c) => c.key === "state")).toBe(true);
  });
});

describe("labels renamed after configs were already saved", () => {
  it("migrates an untouched old default", () => {
    const stored: ColumnConfig = DEFAULT_COLUMNS.map((c) =>
      c.field === "da" ? { ...c, label: "Disc adj" } : c
    );
    const migrated = migrateRenamedLabels(stored);
    expect(migrated.find((c) => c.field === "da")!.label).toBe("Discretionary");
  });

  it("leaves a name she chose herself alone", () => {
    const stored: ColumnConfig = DEFAULT_COLUMNS.map((c) =>
      c.field === "da" ? { ...c, label: "Manager discretion" } : c
    );
    expect(migrateRenamedLabels(stored).find((c) => c.field === "da")!.label).toBe(
      "Manager discretion"
    );
  });

  it("is a no-op on a current config", () => {
    expect(migrateRenamedLabels(DEFAULT_COLUMNS)).toEqual(DEFAULT_COLUMNS);
  });
});
