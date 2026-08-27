/**
 * Recalculate: the one operation that derives a Scale Factor, from POTENTIAL
 * BONUS AT 100% IPM, and re-bases every eligible payout from it.
 *
 * The invariant these tests exist to pin:
 *   editing an IPM does not change the Scale Factor;
 *   pressing Recalculate can.
 */
import { describe, it, expect } from "vitest";
import type { Employee, Overrides } from "./schema";
import { applyOverrides, computeScalesAndBonuses } from "./calc";
import { isEligible, isFixed, recalcChanges, recalculatePool } from "./recalculate";

function emp(over: Partial<Employee> & { id: string }): Employee {
  return {
    sn: "S", gn: over.id, pos: "P", dept: "D", mgr: "M", cat: "C",
    st: "VIC", vp: 1, np: 0, pkg: 1000, bp: 0.1, ipm: 1, bipm: 100, da: 0, f25: 0, sm: 0,
    ...over,
  };
}
// cpm is derived so pkg × bp × cpm × ipm === bipm; with these figures preIpm
// (Potential Bonus) is 100 for every fixture row.
const CAPS = { vCap: 1000, nCap: 1000, gCap: 2000 };

/** Run the engine first, as recalculatePool's contract requires. */
function priced(emps: Employee[], overrides: Overrides = {}) {
  const rows = applyOverrides(emps, overrides);
  computeScalesAndBonuses(rows, CAPS);
  return rows;
}

describe("recalculatePool — the Scale Factor", () => {
  it("is available pool ÷ potential at 100% IPM", () => {
    // 4 VIC rows × 100 potential = 400 denominator; 1000 cap, nothing fixed.
    // 1000/400 clamps to 1.
    const emps = ["A", "B", "C", "D"].map((id) => emp({ id }));
    const r = recalculatePool(priced(emps), CAPS);
    expect(r.vic.potential).toBeCloseTo(400, 10);
    expect(r.vic.fixed).toBe(0);
    expect(r.vic.available).toBeCloseTo(1000, 10);
    expect(r.vic.scale).toBe(1);
  });

  it("scales down an oversubscribed pool", () => {
    // 10 rows × 100 = 1000 potential against a 500 cap → 0.5
    const emps = Array.from({ length: 10 }, (_, i) => emp({ id: `E${i}` }));
    const r = recalculatePool(priced(emps), { ...CAPS, vCap: 500 });
    expect(r.vic.potential).toBeCloseTo(1000, 10);
    expect(r.vic.scale).toBeCloseTo(0.5, 10);
  });

  it("DOES NOT USE CURRENT IPMs in the denominator — the whole point", () => {
    const emps = ["A", "B"].map((id) => emp({ id }));
    const caps = { ...CAPS, vCap: 100 };
    const flat = recalculatePool(priced(emps), caps);
    // Halve one person's IPM and re-run. Under the old, post-IPM denominator
    // this would have moved the scale; against potential it cannot.
    const edited = recalculatePool(priced(emps, { A: { ipmEdit: 0.5 } }), caps);
    expect(edited.vic.potential).toBeCloseTo(flat.vic.potential, 10);
    expect(edited.vic.scale).toBeCloseTo(flat.vic.scale, 10);
  });

  it("clamps to [0, 1]", () => {
    const emps = [emp({ id: "A" })];
    expect(recalculatePool(priced(emps), { ...CAPS, vCap: 99_999 }).vic.scale).toBe(1);
    // fixed rows eat more than the cap → a negative numerator floors at 0
    const withFixed = [emp({ id: "A" }), emp({ id: "L" })];
    const r = recalculatePool(
      priced(withFixed, { L: { locked: true, baseAmount: 5000 } }),
      CAPS
    );
    expect(r.vic.available).toBeLessThan(0);
    expect(r.vic.scale).toBe(0);
  });

  it("is 1 when there is nobody eligible to divide by", () => {
    const r = recalculatePool(priced([emp({ id: "A", sm: 1 })]), CAPS);
    expect(r.vic.potential).toBe(0);
    expect(r.vic.scale).toBe(1);
  });

  it("NSW stays pinned at full entitlement", () => {
    const emps = Array.from({ length: 50 }, (_, i) =>
      emp({ id: `N${i}`, st: "NSW", vp: 0, np: 1 })
    );
    // 5000 potential against a 1000 cap would derive 0.2 if NSW scaled
    const r = recalculatePool(priced(emps), CAPS);
    expect(r.nsw.potential).toBeCloseTo(5000, 10);
    expect(r.nsw.scale).toBe(1);
  });
});

describe("recalculatePool — who is fixed", () => {
  it("a locked row is fixed: off the denominator, off the top of the pool", () => {
    const emps = [emp({ id: "A" }), emp({ id: "L" })];
    const r = recalculatePool(
      priced(emps, { L: { locked: true, baseAmount: 250 } }),
      CAPS
    );
    expect(r.vic.potential).toBeCloseTo(100, 10); // A only
    expect(r.vic.fixed).toBeCloseTo(250, 10);
    expect(r.vic.available).toBeCloseTo(750, 10);
    expect(r.bases.has("L")).toBe(false);
  });

  it("an issued row is fixed, and deducted at its committed amount", () => {
    const issued = { amount: 300, at: "2026-08-27T00:00:00.000Z", by: "a@b.c" };
    const emps = [emp({ id: "A" }), emp({ id: "I" })];
    const r = recalculatePool(
      priced(emps, { I: { locked: true, issued, baseAmount: 10 } }),
      CAPS
    );
    expect(r.vic.fixed).toBeCloseTo(300, 10);
    expect(r.bases.has("I")).toBe(false);
  });

  it("a site manager is fixed — their bonus carries no scale", () => {
    const emps = [emp({ id: "A" }), emp({ id: "S", sm: 1 })];
    const r = recalculatePool(priced(emps, { S: { baseAmount: 100 } }), CAPS);
    expect(r.vic.potential).toBeCloseTo(100, 10);
    expect(r.vic.fixed).toBeCloseTo(100, 10);
    expect(r.bases.has("S")).toBe(false);
  });

  it("a row drawing from no pool is neither fixed nor re-based", () => {
    const none = emp({ id: "Z", vp: 0, np: 0 });
    const r = recalculatePool(priced([none]), CAPS);
    expect(isFixed(priced([none])[0])).toBe(false);
    expect(isEligible(priced([none])[0])).toBe(false);
    expect(r.bases.has("Z")).toBe(false);
    expect(r.vic.potential).toBe(0);
  });

  it("a fixed row's DISCRETIONARY is not charged to the pool", () => {
    // base 200 + amount 100. Only the base is pool money; the amount rides on
    // top, so charging it here would shrink everybody else's scale to pay it.
    const emps = [emp({ id: "A" }), emp({ id: "L" })];
    const r = recalculatePool(
      priced(emps, { L: { locked: true, baseAmount: 200, daEdit: 100 } }),
      CAPS
    );
    expect(r.vic.fixed).toBeCloseTo(200, 10);
  });

  it("splits a fixed part-split row's cost across both pools by its weights", () => {
    const emps = [emp({ id: "P", vp: 0.6, np: 0.4 })];
    const r = recalculatePool(priced(emps, { P: { locked: true, baseAmount: 500 } }), CAPS);
    expect(r.vic.fixed).toBeCloseTo(300, 10);
    expect(r.nsw.fixed).toBeCloseTo(200, 10);
  });
});

describe("recalculatePool — the new bases", () => {
  it("re-bases as Potential × new Scale × current IPM", () => {
    const emps = Array.from({ length: 10 }, (_, i) => emp({ id: `E${i}` }));
    const r = recalculatePool(
      priced(emps, { E0: { ipmEdit: 0.5 } }),
      { ...CAPS, vCap: 500 }
    );
    expect(r.vic.scale).toBeCloseTo(0.5, 10);
    // E0: 100 potential × 0.5 scale × 0.5 IPM
    expect(r.bases.get("E0")).toBeCloseTo(25, 10);
    // everyone else: 100 × 0.5 × 1
    expect(r.bases.get("E1")).toBeCloseTo(50, 10);
    expect(r.moved).toBe(10);
  });

  it("splits an eligible part-split row across both pools at their own scales", () => {
    const emps = [emp({ id: "P", vp: 0.5, np: 0.5 }), emp({ id: "A" })];
    const r = recalculatePool(priced(emps), { ...CAPS, vCap: 75 });
    // VIC potential = 50 (P) + 100 (A) = 150 against 75 → 0.5; NSW pinned at 1
    expect(r.vic.scale).toBeCloseTo(0.5, 10);
    expect(r.bases.get("P")).toBeCloseTo(100 * (0.5 * 0.5 + 0.5 * 1), 10);
  });

  it("leaves discretionary alone — Final becomes newBase + the amount", () => {
    const emps = Array.from({ length: 10 }, (_, i) => emp({ id: `E${i}` }));
    const overrides: Overrides = { E0: { daEdit: 40, baseAmount: 100 } };
    const r = recalculatePool(priced(emps, overrides), { ...CAPS, vCap: 500 });
    const next: Overrides = { ...overrides, E0: { ...overrides.E0, baseAmount: r.bases.get("E0")! } };
    const rows = applyOverrides(emps, next);
    computeScalesAndBonuses(rows, CAPS);
    const e0 = rows.find((e) => e.id === "E0")!;
    expect(e0.daEdit).toBe(40);
    expect(e0.finalBonus).toBeCloseTo(50 + 40, 10);
  });

  it("an issued row's payout survives being re-based around it", () => {
    const issued = { amount: 300, at: "2026-08-27T00:00:00.000Z", by: "a@b.c" };
    const emps = [emp({ id: "A" }), emp({ id: "I" })];
    const overrides: Overrides = { I: { locked: true, issued, baseAmount: 10 } };
    const r = recalculatePool(priced(emps, overrides), CAPS);
    const next: Overrides = { ...overrides };
    for (const [id, base] of r.bases) next[id] = { ...next[id], baseAmount: base };
    const rows = applyOverrides(emps, next);
    computeScalesAndBonuses(rows, CAPS);
    expect(rows.find((e) => e.id === "I")!.finalBonus).toBe(300);
  });
});

describe("recalcChanges — the preview", () => {
  it("lists only rows whose payout actually moves, largest first", () => {
    const emps = [emp({ id: "A" }), emp({ id: "B" })];
    // B already sits at what the recalculation would give it, so it must not
    // be listed; A is far away and must be.
    const rows = priced(emps, { A: { baseAmount: 10 }, B: { baseAmount: 100 } });
    const r = recalculatePool(rows, CAPS);
    const changes = recalcChanges(rows, r);
    expect(changes.map((c) => c.empId)).toEqual(["A"]);
    expect(changes[0]).toMatchObject({ from: 10, to: 100 });
  });

  it("measures 'from' before the discretionary amount", () => {
    const emps = [emp({ id: "A" })];
    const rows = priced(emps, { A: { baseAmount: 10, daEdit: 55 } });
    const changes = recalcChanges(rows, recalculatePool(rows, CAPS));
    expect(changes[0].from).toBeCloseTo(10, 10);
  });

  it("is empty when nothing would move", () => {
    const emps = [emp({ id: "A" })];
    const rows = priced(emps, { A: { baseAmount: 100 } });
    expect(recalcChanges(rows, recalculatePool(rows, CAPS))).toEqual([]);
  });
});
