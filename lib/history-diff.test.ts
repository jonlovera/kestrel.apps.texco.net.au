import { describe, it, expect } from "vitest";
import type { Employee, Overrides } from "./schema";
import { diffOverrides } from "./history-diff";

const emp: Employee = {
  id: "ABCDE",
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
};

const TS = "2026-08-05T04:00:00.000Z";
const diff = (prev: Overrides, next: Overrides) =>
  diffOverrides([emp], prev, next, "jlovera@texco.net.au", TS);

describe("diffOverrides", () => {
  it("no changes → no entries", () => {
    expect(diff({}, {})).toEqual([]);
    expect(diff({ ABCDE: { daEdit: 500 } }, { ABCDE: { daEdit: 500 } })).toEqual([]);
  });

  it("a DA change produces a currency-formatted entry with from/to", () => {
    const [e] = diff({}, { ABCDE: { daEdit: 5000 } });
    expect(e.summary).toBe("Set Discretionary for Alan Bidychak: $0 → $5,000");
    expect(e).toMatchObject({ kind: "edit", field: "da", from: 0, to: 5000, actor: "jlovera@texco.net.au", ts: TS });
  });

  it("reverting a field back to base also records (override removed)", () => {
    const [e] = diff({ ABCDE: { daEdit: 5000 } }, {});
    expect(e.summary).toBe("Set Discretionary for Alan Bidychak: $5,000 → $0");
  });

  it("percent fields format as whole percents", () => {
    const [e] = diff({}, { ABCDE: { ipmEdit: 0.75 } });
    expect(e.summary).toBe("Set IPM% for Alan Bidychak: 90% → 75%");
  });

  it("lock and unlock produce lock-kind entries", () => {
    const [locked] = diff({}, { ABCDE: { locked: true, lockedFinal: 38545 } });
    expect(locked.summary).toBe("Locked Alan Bidychak at $38,545");
    expect(locked.kind).toBe("lock");
    const [unlocked] = diff({ ABCDE: { locked: true, lockedFinal: 38545 } }, {});
    expect(unlocked.summary).toBe("Unlocked Alan Bidychak");
  });

  it("re-locking at a different amount records the moved figure", () => {
    const [e] = diff(
      { ABCDE: { locked: true, lockedFinal: 38545 } },
      { ABCDE: { locked: true, lockedFinal: 42000 } }
    );
    expect(e.summary).toBe("Locked amount for Alan Bidychak: $38,545 → $42,000");
    expect(e).toMatchObject({ kind: "lock", field: "lock", from: 38545, to: 42000 });
  });

  it("an unchanged lock produces no entry", () => {
    expect(
      diff(
        { ABCDE: { locked: true, lockedFinal: 38545 } },
        { ABCDE: { locked: true, lockedFinal: 38545 } }
      )
    ).toEqual([]);
  });

  it("a batched change yields one entry per field", () => {
    const entries = diff({}, { ABCDE: { daEdit: 100, ipmEdit: 0.8, bpEdit: 0.25 } });
    expect(entries).toHaveLength(3);
  });
});
