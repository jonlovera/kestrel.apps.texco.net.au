/**
 * Redistribution: the arithmetic that spends a lead's remaining pool across the
 * people they selected. The properties that matter are exactness (the shares must
 * sum to the target, or an automatic re-run redistributes the residue forever)
 * and idempotency (pressing the button twice must not double anyone's amount).
 */
import { describe, it, expect } from "vitest";
import { redistribute, eligible, type Redistributable } from "./redistribute";

function row(over: Partial<Redistributable> & { id: string }): Redistributable {
  return {
    daEdit: 0,
    locked: false,
    calcBonus: 10_000,
    sm: 0,
    st: "VIC",
    inPool: true,
    ...over,
  };
}

/** every row ticked, which is the common case in these tests */
const all = (rows: readonly Redistributable[]) => new Set(rows.map((r) => r.id));

const sum = (m: Map<string, number>) => [...m.values()].reduce((s, v) => s + v, 0);

describe("who takes part", () => {
  it("only selected, unlocked, adjustable rows", () => {
    const rows = [
      row({ id: "in" }),
      row({ id: "notPicked" }),
      row({ id: "locked", locked: true }),
      row({ id: "noPool", inPool: false }),
      row({ id: "vicSm", sm: 1, st: "VIC" }),
      row({ id: "nswSm", sm: 1, st: "NSW" }),
    ];
    // everything ticked EXCEPT notPicked; NSW site managers are adjustable,
    // VIC ones are not (lib/calc.ts)
    const picked = new Set(["in", "locked", "noPool", "vicSm", "nswSm"]);
    expect(eligible(rows, picked).map((r) => r.id)).toEqual(["in", "nswSm"]);
    // an admin holding the VIC site managers grant (26 Aug 2026) may include them
    expect(eligible(rows, picked, { vicSiteManagers: true }).map((r) => r.id)).toEqual([
      "in",
      "vicSm",
      "nswSm",
    ]);
  });

  it("a selection that names nobody eligible writes nothing", () => {
    const rows = [row({ id: "A" })];
    expect(redistribute(rows, 5_000, new Set<string>()).size).toBe(0);
    expect(redistribute(rows, 5_000, new Set(["someone-else"])).size).toBe(0);
  });
});

describe("the split", () => {
  it("is pro-rata by calculated bonus and sums to the target exactly", () => {
    const rows = [
      row({ id: "A", calcBonus: 60_000 }),
      row({ id: "B", calcBonus: 40_000 }),
      row({ id: "C", calcBonus: 20_000 }),
    ];
    const got = redistribute(rows, 120_000, all(rows));
    expect(got.get("A")).toBe(60_000);
    expect(got.get("B")).toBe(40_000);
    expect(got.get("C")).toBe(20_000);
    expect(sum(got)).toBe(120_000);
  });

  it("lands exactly on an amount that does not divide evenly", () => {
    const rows = [
      row({ id: "A", calcBonus: 1 }),
      row({ id: "B", calcBonus: 1 }),
      row({ id: "C", calcBonus: 1 }),
    ];
    const got = redistribute(rows, 100, all(rows));
    expect(sum(got)).toBe(100); // 33 / 33 / 34, not 99
    expect([...got.values()].sort()).toEqual([33, 33, 34]);
  });

  it("whole dollars only — no cents anywhere", () => {
    const rows = [
      row({ id: "A", calcBonus: 7_777 }),
      row({ id: "B", calcBonus: 3_333 }),
      row({ id: "C", calcBonus: 1_111 }),
    ];
    const got = redistribute(rows, 120_483, all(rows));
    for (const v of got.values()) expect(Number.isInteger(v)).toBe(true);
    expect(sum(got)).toBe(120_483);
  });

  it("falls back to an equal split when there is no weight to go on", () => {
    const rows = [
      row({ id: "A", calcBonus: 0 }),
      row({ id: "B", calcBonus: 0 }),
    ];
    const got = redistribute(rows, 1_000, all(rows));
    expect(got.get("A")).toBe(500);
    expect(got.get("B")).toBe(500);
  });

  it("adds on top of an amount already there", () => {
    const rows = [
      row({ id: "A", calcBonus: 10_000, daEdit: 2_500 }),
      row({ id: "B", calcBonus: 10_000, daEdit: 0 }),
    ];
    const got = redistribute(rows, 1_000, all(rows));
    expect(got.get("A")).toBe(3_000); // 2,500 existing + 500 share
    expect(got.get("B")).toBe(500);
  });
});

describe("safety properties", () => {
  it("pressing it twice does not double up — the remaining is zero by then", () => {
    const rows = [
      row({ id: "A", calcBonus: 60_000 }),
      row({ id: "B", calcBonus: 40_000 }),
    ];
    const first = redistribute(rows, 100_000, all(rows));
    // applying it drives remaining to 0, which is what the engine then measures
    const applied = rows.map((r) => ({ ...r, daEdit: first.get(r.id) ?? r.daEdit }));
    expect(redistribute(applied, 0, all(applied)).size).toBe(0);
  });

  it("is deterministic — the same input gives the same split every time", () => {
    const rows = [
      row({ id: "A", calcBonus: 1 }),
      row({ id: "B", calcBonus: 1 }),
      row({ id: "C", calcBonus: 1 }),
    ];
    const a = redistribute(rows, 100, all(rows));
    const b = redistribute(rows, 100, all(rows));
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it("a negative remaining reclaims pro-rata, never over-reclaiming", () => {
    const rows = [
      row({ id: "A", calcBonus: 60_000, daEdit: 60_000 }),
      row({ id: "B", calcBonus: 40_000, daEdit: 40_000 }),
    ];
    const got = redistribute(rows, -10_000, all(rows));
    expect(got.get("A")).toBe(54_000);
    expect(got.get("B")).toBe(36_000);
    // exactly -10,000 given back, not -10,001
    expect(sum(got) - 100_000).toBe(-10_000);
  });

  it("an odd negative still lands exactly", () => {
    const rows = [
      row({ id: "A", calcBonus: 1, daEdit: 100 }),
      row({ id: "B", calcBonus: 1, daEdit: 100 }),
      row({ id: "C", calcBonus: 1, daEdit: 100 }),
    ];
    const got = redistribute(rows, -100, all(rows));
    expect(sum(got) - 300).toBe(-100);
  });

  it("never spends the cents: a remaining of 9,685.60 hands out 9,685, not 9,686", () => {
    // the server floors the room it judges each grant against (getMaxDA), so
    // rounding up would land the pool 40¢ over — a red card and, for a dollar,
    // a refused save
    const rows = [row({ id: "a", calcBonus: 60_000 }), row({ id: "b", calcBonus: 40_000 })];
    const shares = redistribute(rows, 9_685.6, all(rows));
    expect(sum(shares)).toBe(9_685);
    // and a remaining under a dollar is nothing to hand out
    expect(redistribute(rows, 0.9, all(rows)).size).toBe(0);
    // the same toward zero when reclaiming
    expect(sum(redistribute(rows, -9_685.6, all(rows)))).toBe(-9_685);
  });

  it("a zero remaining writes nothing at all", () => {
    expect(redistribute([row({ id: "A" })], 0, new Set(["A"])).size).toBe(0);
  });
});

describe("NSW", () => {
  it("works identically for an NSW-only population — the whole point", () => {
    // Under the scale-based model this was inert: nswScale is pinned at 1, so
    // there was nothing to move. Writing amounts does not care.
    const nsw = [
      row({ id: "A", st: "NSW", calcBonus: 60_000 }),
      row({ id: "B", st: "NSW", calcBonus: 40_000 }),
    ];
    const vic = [
      row({ id: "A", calcBonus: 60_000 }),
      row({ id: "B", calcBonus: 40_000 }),
    ];
    expect([...redistribute(nsw, 120_483, all(nsw)).entries()]).toEqual([
      ...redistribute(vic, 120_483, all(vic)).entries(),
    ]);
  });
});
