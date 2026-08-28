/**
 * Discretionary headroom and grant impact.
 *
 * The fixture is small enough to check by hand: one pool (VIC, cap 1500) with
 * three unlocked rows demanding 1200 between them, so the scale clamps at 1,
 * every final is exactly 400, and the cap has exactly 300 left. Under the
 * on-top model (owner decision, 25 August 2026) that 300 IS the headroom — a
 * grant adds to the pool total instead of being funded from inside it, so what
 * bounds it is the room under the cap and nothing else. The group cap is set
 * well clear of it so the state cap is the one binding, except where a test
 * says otherwise.
 */
import { describe, it, expect } from "vitest";
import type { Dataset, Employee, Overrides } from "./schema";
import { applyOverrides, computeScalesAndBonuses, floorCents } from "./calc";
import {
  DA_POLICY,
  clampDa,
  daGrants,
  daHeadroom,
  daImpact,
} from "./da-impact";

function emp(over: Partial<Employee> & { id: string }): Employee {
  return {
    sn: "Surname",
    gn: "Given",
    pos: "Role",
    dept: "Dept",
    mgr: "Mgr",
    cat: "Employee",
    st: "VIC",
    vp: 1,
    np: 0,
    pkg: 4000,
    bp: 0.1,
    ipm: 1,
    bipm: 400,
    da: 0,
    f25: 0,
    sm: 0,
    ...over,
  };
}

/** A, B and C demand 1200 of a VIC pool of 1500 — 300 of room. */
const data: Dataset = {
  emp: [
    emp({ id: "A", gn: "Ann", sn: "Alpha", bipm: 400, pkg: 4000 }),
    emp({ id: "B", gn: "Ben", sn: "Beta", bipm: 400, pkg: 4000 }),
    emp({ id: "C", gn: "Cal", sn: "Gamma", bipm: 400, pkg: 4000 }),
  ],
  vCap: 1500,
  nCap: 1000,
  gCap: 5000,
  cats: ["Employee"],
  depts: ["Dept"],
  mgrs: ["Mgr"],
  excludedIds: [],
};

function pooled(doc: Overrides = {}, set: Dataset = data) {
  const rows = applyOverrides(set.emp, doc);
  const pool = computeScalesAndBonuses(rows, set);
  return { rows, pool };
}

function row(rows: ReturnType<typeof pooled>["rows"], id: string) {
  return rows.find((e) => e.id === id)!;
}

function cardTotal(rows: ReturnType<typeof pooled>["rows"], st?: Employee["st"]) {
  return rows.reduce((s, e) => (!st || e.st === st ? s + e.finalBonus : s), 0);
}

describe("daHeadroom", () => {
  it("is the room left under the cap, not what the other bonuses hold", () => {
    const { rows } = pooled();
    // the others hold 800 between them, and none of it is available: a grant
    // does not come out of anyone's bonus any more
    expect(cardTotal(rows, "VIC")).toBeCloseTo(1200, 8);
    expect(daHeadroom(row(rows, "A"), rows, data)).toBe(300);
  });

  it("stops exactly where the card reaches its cap", () => {
    const { rows } = pooled();
    const headroom = daHeadroom(row(rows, "A"), rows, data);
    const at = pooled({ A: { daEdit: headroom } });
    expect(cardTotal(at.rows, "VIC")).toBeCloseTo(data.vCap, 8);
    // and the others are exactly where they were — nobody funded it
    for (const id of ["B", "C"]) {
      expect(row(at.rows, id).finalBonus).toBeCloseTo(400, 10);
    }
    // one dollar more would pass the cap, which is what the gate refuses
    const over = pooled({ A: { daEdit: headroom + 1 } });
    expect(cardTotal(over.rows, "VIC")).toBeGreaterThan(data.vCap);
  });

  it("is what the field may HOLD, so it does not move as the field fills", () => {
    const { rows } = pooled({ A: { daEdit: 200 } });
    expect(daHeadroom(row(rows, "A"), rows, data)).toBe(300);
    // ...while the room left for everyone else has shrunk by the 200 granted
    expect(daHeadroom(row(rows, "B"), rows, data)).toBe(100);
  });

  it("counts a locked bonus against the cap like any other", () => {
    // C's 400 is frozen, which changes nothing here: it still occupies its
    // share of the cap, and the room left is the same 300.
    const { rows } = pooled({ C: { locked: true, lockedFinal: 400 } });
    expect(daHeadroom(row(rows, "A"), rows, data)).toBe(300);
    // and the frozen row itself gets the same 300: the lock is not a bound.
    // It used to answer 0 here, which is what refused a real grant on an
    // already-locked row while the cap still had room.
    expect(daHeadroom(row(rows, "C"), rows, data)).toBe(300);
  });

  it("counts a site manager's fixed bonus against the cap too", () => {
    const smData: Dataset = {
      ...data,
      emp: [data.emp[0], data.emp[1], emp({ id: "C", bipm: 400, sm: 1 })],
    };
    const { rows } = pooled({}, smData);
    expect(daHeadroom(row(rows, "A"), rows, smData)).toBe(300);
  });

  it("a site manager can receive a grant, and nobody pays for it (24 Aug 2026)", () => {
    const smData: Dataset = {
      ...data,
      emp: [data.emp[0], data.emp[1], emp({ id: "C", st: "NSW", bipm: 400, vp: 0, np: 1, sm: 1 })],
    };
    const { rows } = pooled({}, smData);
    // C is on NSW, whose cap of 1000 holds only their own fixed 400
    expect(daHeadroom(row(rows, "C"), rows, smData)).toBe(600);
    const impact = daImpact(smData.emp, smData, {}, { C: { daEdit: 100 } });
    expect(impact.grants).toHaveLength(1);
    expect(impact.grants[0].amount).toBeCloseTo(100, 6);
    // nobody's bonus is touched; the NSW total carries it instead
    expect(impact.reducedCount).toBe(0);
    expect(impact.totalReduction).toBeCloseTo(0, 6);
    expect(impact.pools.find((p) => p.key === "NSW")).toEqual({
      key: "NSW",
      before: 400,
      after: 500,
      cap: 1000,
    });
  });

  it("bounds a Shared Services row by the group cap alone", () => {
    // Shared Services has no cap of its own, and a split row's whole final is
    // counted there rather than against either state — the way the cards do it.
    const sharedData: Dataset = {
      ...data,
      emp: [
        data.emp[0],
        data.emp[1],
        emp({ id: "C", st: "SHARED", vp: 0.5, np: 0.5, bipm: 400 }),
      ],
      gCap: 2000,
    };
    const { rows } = pooled({}, sharedData);
    expect(cardTotal(rows, "SHARED")).toBeCloseTo(400, 8);
    expect(daHeadroom(row(rows, "C"), rows, sharedData)).toBe(2000 - 1200);
  });

  it("is bounded by the group cap when that is the tighter of the two", () => {
    const tight: Dataset = { ...data, gCap: 1250 };
    const { rows } = pooled({}, tight);
    // VIC's cap still has 300 of room, but the group cap has only 50
    expect(daHeadroom(row(rows, "A"), rows, tight)).toBe(50);
  });

  it("forwards the CapBound, so a scoped lead is judged by their state alone", () => {
    // Same tight group cap, which is what refuses an admin above. A lead is
    // never sent gCap (lib/scope-core.ts), so /api/state's gate 4 passes
    // "state" for them and they get VIC's own 300 instead of the group's 50.
    const tight: Dataset = { ...data, gCap: 1250 };
    const { rows } = pooled({}, tight);
    expect(daHeadroom(row(rows, "A"), rows, tight, "state")).toBe(300);
    // and the default is the stricter bound, unchanged
    expect(daHeadroom(row(rows, "A"), rows, tight)).toBe(
      daHeadroom(row(rows, "A"), rows, tight, "both")
    );
  });

  it("leaves a row drawing from no pool unbounded", () => {
    const noPool: Dataset = {
      ...data,
      emp: [data.emp[0], data.emp[1], emp({ id: "C", vp: 0, np: 0, bipm: 400 })],
    };
    const { rows } = pooled({}, noPool);
    expect(daHeadroom(row(rows, "C"), rows, noPool)).toBe(Infinity);
  });

  it("reports no room at all as a negative figure, not as zero", () => {
    // an inherited over-cap figure: honest about there being nothing left, and
    // clampDa is what stops it dragging a stored amount down (see below)
    const { rows } = pooled({ A: { daEdit: 500 } });
    expect(cardTotal(rows, "VIC")).toBeCloseTo(1700, 8);
    expect(daHeadroom(row(rows, "B"), rows, data)).toBe(-200);
  });

  it("leaves both policy knobs unset, so neither changes the ceiling yet", () => {
    expect(DA_POLICY.approvalThreshold).toBeNull();
    expect(DA_POLICY.minBonusFloor).toBeNull();
  });
});

describe("a carve-out on the caps (FY26)", () => {
  // VIC cap 1500 less a 200 carve = a binding cap of 1300; the rows hold 1200
  const carved: Dataset = { ...data, vCarve: 200 };

  it("tightens the headroom by exactly the carve", () => {
    const { rows } = pooled({}, carved);
    expect(daHeadroom(row(rows, "A"), rows, carved)).toBe(100);
    expect(daHeadroom(row(rows, "A"), rows, data)).toBe(300);
  });

  it("reports the BINDING cap on the impact, so the confirmation matches the refusal", () => {
    const impact = daImpact(carved.emp, carved, {}, { A: { daEdit: 100 } });
    expect(impact.pools).toEqual([
      { key: "VIC", before: 1200, after: 1300, cap: 1300 },
      { key: "GROUP", before: 1200, after: 1300, cap: 5000 },
    ]);
    expect(impact.grants[0].headroom).toBe(100);
  });

  it("the group figure and a Shared Services row carry no carve", () => {
    const withShared: Dataset = {
      ...carved,
      emp: [...carved.emp, emp({ id: "S", st: "SHARED", vp: 0.5, np: 0.5 })],
    };
    const impact = daImpact(withShared.emp, withShared, {}, { S: { daEdit: 50 } });
    expect(impact.pools.find((p) => p.key === "SHARED")!.cap).toBeNull();
    expect(impact.pools.find((p) => p.key === "GROUP")!.cap).toBe(5000);
  });
});

describe("a carve-funded row (FY26 part-split staff labelled VIC)", () => {
  // P is VIC-labelled but on a split: funded by the split-state carve, not the pool
  const withP: Dataset = {
    ...data,
    emp: [...data.emp, emp({ id: "P", gn: "Pat", sn: "Part", vp: 0.9, np: 0.1, bipm: 300, pkg: 3000 })],
  };

  it("is left out of the VIC figures the confirmation reports", () => {
    const impact = daImpact(withP.emp, withP, {}, { A: { daEdit: 100 } });
    const pShare = row(pooled({}, withP).rows, "P").finalBonus * 0.9;
    // A/B/C still hold 1200 between them and P's payout is not in the VIC line
    // — but the VIC CAP the confirmation quotes is now net of the 90% of P that
    // VIC actually funds (28 Aug 2026), so it matches the ceiling a save
    // enforces rather than a frozen figure.
    expect(impact.pools).toEqual([
      { key: "VIC", before: 1200, after: 1300, cap: 1500 - pShare },
      { key: "GROUP", before: 1200 + row(pooled({}, withP).rows, "P").finalBonus, after: 1300 + row(pooled({}, withP).rows, "P").finalBonus, cap: 5000 },
    ]);
  });

  it("does not consume the pool's room, and a grant to it moves the group total only", () => {
    const { rows } = pooled({}, withP);
    // A's headroom is the 300 it would be without P, less the 90% of P that VIC
    // funds: P is out of the home total, and the carve that covers them is live.
    expect(daHeadroom(row(rows, "A"), rows, withP)).toBe(
      floorCents(300 - row(rows, "P").finalBonus * 0.9)
    );
    // P is bounded by the group cap alone, and by nothing under "state"
    expect(daHeadroom(row(rows, "P"), rows, withP, "state")).toBe(Infinity);
    expect(daHeadroom(row(rows, "P"), rows, withP)).toBe(floorCents(5000 - cardTotal(rows)));
    const impact = daImpact(withP.emp, withP, {}, { P: { daEdit: 250 } });
    expect(impact.pools.map((p) => p.key)).toEqual(["GROUP"]);
    expect(impact.grants[0].headroom).toBe(floorCents(5000 - cardTotal(rows)));
  });
});

describe("clampDa", () => {
  it("passes an amount inside the ceiling through untouched", () => {
    expect(clampDa(500, 0, 800)).toEqual({ value: 500, clamped: false });
  });

  it("holds an amount above the ceiling at the ceiling", () => {
    expect(clampDa(2000, 0, 800)).toEqual({ value: 800, clamped: true });
  });

  it("floors to whole dollars so the held figure cannot exceed the ceiling", () => {
    expect(clampDa(2000, 0, 800.9)).toEqual({ value: 800, clamped: true });
  });

  it("never holds back a decrease, even with no room left", () => {
    expect(clampDa(100, 900, -50)).toEqual({ value: 100, clamped: false });
    expect(clampDa(-500, 0, 0)).toEqual({ value: -500, clamped: false });
  });

  it("holds at the stored amount rather than reducing it when there is no room", () => {
    expect(clampDa(1000, 900, -50)).toEqual({ value: 900, clamped: true });
  });

  it("tolerates sub-cent noise rather than reporting a clamp", () => {
    expect(clampDa(800.005, 0, 800)).toEqual({ value: 800.005, clamped: false });
  });

  it("leaves a row that draws from no pool unbounded", () => {
    expect(clampDa(9_999, 0, Infinity)).toEqual({ value: 9_999, clamped: false });
  });
});

describe("daGrants", () => {
  it("reports nothing for an unchanged document", () => {
    expect(daGrants(data.emp, data, {}, {})).toEqual([]);
    expect(daGrants(data.emp, data, { A: { daEdit: 300 } }, { A: { daEdit: 300 } })).toEqual([]);
  });

  it("names the row, the movement and the ceiling that applied", () => {
    const grants = daGrants(data.emp, data, {}, { A: { daEdit: 300 } });
    expect(grants).toEqual([
      { empId: "A", name: "Ann Alpha", from: 0, to: 300, amount: 300, headroom: 300 },
    ]);
  });

  it("measures the ceiling before the change, not after", () => {
    // from 300 to 500: the headroom recorded is the one that bounded the
    // decision, which is the pre-change figure
    const grants = daGrants(data.emp, data, { A: { daEdit: 300 } }, { A: { daEdit: 500 } });
    expect(grants[0].from).toBe(300);
    expect(grants[0].amount).toBe(200);
    const stored = pooled({ A: { daEdit: 300 } });
    expect(grants[0].headroom).toBe(
      daHeadroom(row(stored.rows, "A"), stored.rows, data)
    );
  });

  it("reports a reduction as a negative amount", () => {
    const grants = daGrants(data.emp, data, { A: { daEdit: 300 } }, { A: { daEdit: 100 } });
    expect(grants[0].amount).toBe(-200);
  });

  it("reports every changed row", () => {
    const grants = daGrants(data.emp, data, {}, { A: { daEdit: 100 }, B: { daEdit: 50 } });
    expect(grants.map((g) => g.empId).sort()).toEqual(["A", "B"]);
  });

  it("ignores sub-cent drift", () => {
    expect(daGrants(data.emp, data, { A: { daEdit: 300 } }, { A: { daEdit: 300.005 } })).toEqual([]);
  });
});

describe("daImpact", () => {
  it("names each pool it moves and where it leaves it", () => {
    const impact = daImpact(data.emp, data, {}, { A: { daEdit: 300 } });
    expect(impact.granted).toBe(300);
    expect(impact.pools).toEqual([
      { key: "VIC", before: 1200, after: 1500, cap: 1500 },
      { key: "GROUP", before: 1200, after: 1500, cap: 5000 },
    ]);
  });

  it("reports nobody reduced: a grant is not taken from anyone", () => {
    const impact = daImpact(data.emp, data, {}, { A: { daEdit: 300 } });
    expect(impact.reducedCount).toBe(0);
    expect(impact.totalReduction).toBeCloseTo(0, 6);
    expect(impact.averageReduction).toBe(0);
    expect(impact.largestReduction).toBe(0);
    expect(impact.grants).toHaveLength(1);
  });

  it("still counts locked bonuses, which a grant leaves alone either way", () => {
    const impact = daImpact(
      data.emp,
      data,
      { C: { locked: true, lockedFinal: 400 } },
      { C: { locked: true, lockedFinal: 400 }, A: { daEdit: 300 } }
    );
    expect(impact.lockedUnaffected).toBe(1);
    expect(impact.reducedCount).toBe(0);
  });

  it("reports a clean sheet for an unchanged document", () => {
    const impact = daImpact(data.emp, data, {}, {});
    expect(impact.grants).toEqual([]);
    expect(impact.granted).toBe(0);
    expect(impact.pools).toEqual([]);
    expect(impact.reducedCount).toBe(0);
    expect(impact.averageReduction).toBe(0);
    expect(impact.largestReduction).toBe(0);
  });

  it("takes the pool total back down when a grant is given back", () => {
    const impact = daImpact(data.emp, data, { A: { daEdit: 300 } }, { A: { daEdit: 0 } });
    expect(impact.granted).toBe(-300);
    expect(impact.reducedCount).toBe(0);
    expect(impact.pools).toEqual([
      { key: "VIC", before: 1500, after: 1200, cap: 1500 },
      { key: "GROUP", before: 1500, after: 1200, cap: 5000 },
    ]);
  });

  it("adds up across several grants in one save", () => {
    const impact = daImpact(data.emp, data, {}, { A: { daEdit: 100 }, B: { daEdit: 100 } });
    expect(impact.granted).toBe(200);
    expect(impact.reducedCount).toBe(0);
    expect(impact.pools[0]).toEqual({ key: "VIC", before: 1200, after: 1400, cap: 1500 });
  });

  it("lists every pool a multi-state save moves, group last", () => {
    const mixed: Dataset = {
      ...data,
      emp: [
        data.emp[0],
        emp({ id: "N", gn: "Nia", sn: "Nu", st: "NSW", vp: 0, np: 1, bipm: 400 }),
        emp({ id: "S", gn: "Sam", sn: "Sigma", st: "SHARED", vp: 0.5, np: 0.5, bipm: 400 }),
      ],
    };
    const impact = daImpact(mixed.emp, mixed, {}, { A: { daEdit: 10 }, N: { daEdit: 20 }, S: { daEdit: 30 } });
    expect(impact.pools.map((p) => p.key)).toEqual(["VIC", "NSW", "SHARED", "GROUP"]);
    expect(impact.pools.find((p) => p.key === "SHARED")!.cap).toBeNull();
    const group = impact.pools.find((p) => p.key === "GROUP")!;
    expect(group.after - group.before).toBeCloseTo(60, 8);
  });
});
