import { describe, it, expect } from "vitest";
import type { Employee, Snapshot } from "./schema";
import { DEFAULT_COLUMNS } from "./columns";
import { DEFAULT_COPY } from "./copy";
import { diffSnapshotStates } from "./snapshot-diff";

type State = Snapshot["state"];

const emp = (over: Partial<Employee> & { id: string }): Employee => ({
  sn: "Bidychak",
  gn: "Alan",
  pos: "GC",
  dept: "Legal",
  mgr: "MB",
  cat: "Texco Management",
  st: "SHARED",
  vp: 0.6,
  np: 0.4,
  pkg: 300000,
  bp: 0.2,
  ipm: 0.9,
  bipm: 54000,
  da: 0,
  f25: 50336,
  sm: 0,
  ...over,
});

const ALAN = emp({ id: "ALAN" });
const JANE = emp({ id: "JANE", gn: "Jane", sn: "Bull", st: "VIC" });

const state = ({ dataset, ...over }: Partial<State> = {}): State => ({
  dataset: {
    emp: [ALAN, JANE],
    vCap: 6_000_000,
    nCap: 3_000_000,
    gCap: 9_000_000,
    cats: [],
    depts: [],
    mgrs: [],
    excludedIds: [],
    ...dataset,
  },
  overrides: {},
  params: null,
  columns: null,
  copy: null,
  ...over,
});

const texts = (s: ReturnType<typeof diffSnapshotStates>) => s.lines.map((l) => l.text);

describe("diffSnapshotStates", () => {
  it("identical states → empty summary", () => {
    const s = diffSnapshotStates(state(), state());
    expect(s.headline).toBe("");
    expect(s.lines).toEqual([]);
    expect(s.more).toBe(0);
  });

  it("bonus edits and locks come from the same core as the history feed", () => {
    const s = diffSnapshotStates(
      state(),
      state({ overrides: { ALAN: { daEdit: 5000 }, JANE: { locked: true, lockedFinal: 38545 } } })
    );
    expect(s.headline).toBe("1 bonus edit · 1 lock change");
    expect(texts(s)).toEqual([
      "Set Discretionary for Alan Bidychak: $0 → $5,000",
      "Locked Jane Bull at $38,545",
    ]);
  });

  it("a re-lock at a different amount is visible", () => {
    const s = diffSnapshotStates(
      state({ overrides: { JANE: { locked: true, lockedFinal: 38545 } } }),
      state({ overrides: { JANE: { locked: true, lockedFinal: 42000 } } })
    );
    expect(texts(s)).toEqual(["Locked amount for Jane Bull: $38,545 → $42,000"]);
  });

  it("added and removed rows are named when few", () => {
    const s = diffSnapshotStates(
      state({ dataset: { emp: [ALAN] } as State["dataset"] }),
      state({ dataset: { emp: [ALAN, JANE] } as State["dataset"] })
    );
    expect(s.headline).toBe("1 employee added");
    expect(texts(s)).toEqual(["Added Jane Bull"]);
  });

  it("many added rows collapse to a count", () => {
    const crowd = Array.from({ length: 5 }, (_, i) => emp({ id: `E${i}` }));
    const s = diffSnapshotStates(
      state({ dataset: { emp: [ALAN] } as State["dataset"] }),
      state({ dataset: { emp: [ALAN, ...crowd] } as State["dataset"] })
    );
    expect(texts(s)).toEqual(["Added 5 employees"]);
    expect(s.headline).toBe("5 employees added");
  });

  it("a source-figure change renders in the field's own format", () => {
    const s = diffSnapshotStates(
      state(),
      state({ dataset: { emp: [emp({ id: "ALAN", bipm: 60000 }), JANE] } as State["dataset"] })
    );
    expect(texts(s)).toEqual(["After IPM for Alan Bidychak: $54,000 → $60,000"]);
    expect(s.headline).toBe("1 data change");
  });

  it("a split change shows both pool weights as percents", () => {
    const s = diffSnapshotStates(
      state(),
      state({ dataset: { emp: [emp({ id: "ALAN", vp: 0.7, np: 0.3 }), JANE] } as State["dataset"] })
    );
    expect(texts(s)).toEqual([
      "VIC % for Alan Bidychak: 60% → 70%",
      "NSW % for Alan Bidychak: 40% → 30%",
    ]);
  });

  it("exclusions are named", () => {
    const s = diffSnapshotStates(
      state(),
      state({ dataset: { emp: [ALAN, JANE], excludedIds: ["JANE"] } as State["dataset"] })
    );
    expect(texts(s)).toEqual(["Excluded Jane Bull from the model"]);
  });

  it("dataset cap changes are reported", () => {
    const s = diffSnapshotStates(
      state(),
      state({ dataset: { emp: [ALAN, JANE], vCap: 6_500_000 } as State["dataset"] })
    );
    expect(texts(s)).toEqual(["VIC pool cap: $6,000,000 → $6,500,000"]);
  });

  it("params: null → set reads as one 'set' line", () => {
    const s = diffSnapshotStates(
      state(),
      state({ params: { vCap: 6_000_000, nCap: 3_000_000, gCap: 9_000_000, companyModifier: 0.95 } })
    );
    expect(texts(s)).toEqual([
      "Parameters set: VIC cap $6,000,000, NSW cap $3,000,000, Group cap $9,000,000, company modifier 0.95",
    ]);
    expect(s.headline).toBe("1 parameter change");
  });

  it("params: set → set diffs per field", () => {
    const base = { vCap: 6_000_000, nCap: 3_000_000, gCap: 9_000_000, companyModifier: 1 };
    const s = diffSnapshotStates(
      state({ params: base }),
      state({ params: { ...base, vCap: 6_500_000, companyModifier: 0.9 } })
    );
    expect(texts(s)).toEqual([
      "VIC pool cap: $6,000,000 → $6,500,000",
      "Company modifier: 1 → 0.9",
    ]);
    expect(s.headline).toBe("2 parameter changes");
  });

  it("params: set → null reads as cleared to defaults", () => {
    const s = diffSnapshotStates(
      state({ params: { vCap: 1, nCap: 1, gCap: 1, companyModifier: 1 } }),
      state()
    );
    expect(texts(s)).toEqual(["Parameters cleared back to scheme defaults"]);
  });

  it("column hide and rename are described; null compares as the defaults", () => {
    const renamed = DEFAULT_COLUMNS.map((c) =>
      c.field === "da"
        ? { ...c, label: "Adjustment" }
        : c.field === "cat"
          ? { ...c, visible: true }
          : c
    );
    const s = diffSnapshotStates(state(), state({ columns: renamed }));
    expect(texts(s)).toEqual([
      'Showed column "Category"',
      'Renamed column "Discretionary" to "Adjustment"',
    ]);
    expect(s.headline).toBe("2 column changes");
  });

  it("wording changes are described; an absent doc compares as the defaults", () => {
    const s = diffSnapshotStates(
      state(),
      state({ copy: { ...DEFAULT_COPY, bannerVisible: false, schemeName: "FY26 EBS" } })
    );
    expect(texts(s)).toEqual(['Renamed the scheme to "FY26 EBS"', "Banner switched off"]);
    expect(s.headline).toBe("wording changed");
  });

  it("access grants, removals and changes are described", () => {
    const older = state({
      access: {
        "old@texco.net.au": { type: "full", canEditCaps: false },
        "lead@texco.net.au": {
          type: "state",
          states: ["VIC"],
          visibleFields: [],
          editableFields: ["da"],
          canLock: false,
        },
      },
    });
    const newer = state({
      access: {
        "lead@texco.net.au": {
          type: "state",
          states: ["VIC", "NSW"],
          visibleFields: [],
          editableFields: ["da"],
          canLock: false,
        },
        "new@texco.net.au": { type: "full", canEditCaps: false },
      },
    });
    const s = diffSnapshotStates(older, newer);
    expect(texts(s).sort()).toEqual([
      "Changed access for lead@texco.net.au: VIC + NSW / can set Discretionary",
      "Granted access for new@texco.net.au: full access",
      "Removed access for old@texco.net.au",
    ]);
    expect(s.headline).toBe("3 access changes");
  });

  it("access absent on either side says nothing about access", () => {
    const withAccess = state({ access: { "x@texco.net.au": { type: "full", canEditCaps: false } } });
    expect(diffSnapshotStates(state(), withAccess).lines).toEqual([]);
    expect(diffSnapshotStates(withAccess, state({ access: undefined })).lines).toEqual([]);
  });

  it("caps the detail lines and counts the rest", () => {
    const many: Record<string, { daEdit: number }> = {};
    const crowd = Array.from({ length: 40 }, (_, i) => emp({ id: `E${i}` }));
    for (const e of crowd) many[e.id] = { daEdit: 1000 };
    const s = diffSnapshotStates(
      state({ dataset: { emp: crowd } as State["dataset"] }),
      state({ dataset: { emp: crowd } as State["dataset"], overrides: many })
    );
    expect(s.lines).toHaveLength(30);
    expect(s.more).toBe(10);
    expect(s.headline).toBe("40 bonus edits");
  });

  it("an unparseable params doc degrades to a generic line instead of throwing", () => {
    const s = diffSnapshotStates(
      state({ params: { some: "ancient-shape" } }),
      state({ params: { other: "ancient-shape" } })
    );
    expect(texts(s)).toEqual(["Parameter settings changed"]);
  });
});
