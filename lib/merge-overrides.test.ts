/**
 * The three-way merge behind conflict-safe saving. The load-bearing
 * assertions: changes that touch different slots always combine, a slot both
 * sides changed differently is surfaced rather than silently overwritten, and
 * the lock pair can never end up half-ours half-theirs.
 */
import { describe, it, expect } from "vitest";
import type { Overrides } from "./schema";
import { mergeOverrides, resolveConflicts } from "./merge-overrides";

describe("mergeOverrides", () => {
  it("combines changes to different employees with no conflict", () => {
    const base: Overrides = { A: { daEdit: 100 } };
    const ours: Overrides = { A: { daEdit: 100 }, B: { ipmEdit: 0.8 } };
    const theirs: Overrides = { A: { daEdit: 250 } };
    const res = mergeOverrides(base, ours, theirs);
    expect(res.conflicts).toEqual([]);
    expect(res.merged).toEqual({ A: { daEdit: 250 }, B: { ipmEdit: 0.8 } });
  });

  it("combines changes to different fields on the same employee", () => {
    const base: Overrides = {};
    const ours: Overrides = { A: { daEdit: 100 } };
    const theirs: Overrides = { A: { ipmEdit: 0.9 } };
    const res = mergeOverrides(base, ours, theirs);
    expect(res.conflicts).toEqual([]);
    expect(res.merged).toEqual({ A: { daEdit: 100, ipmEdit: 0.9 } });
  });

  it("takes theirs when we didn't touch the slot", () => {
    const base: Overrides = { A: { daEdit: 100 } };
    const res = mergeOverrides(base, base, { A: { daEdit: 300 } });
    expect(res.conflicts).toEqual([]);
    expect(res.merged).toEqual({ A: { daEdit: 300 } });
  });

  it("keeps ours when they didn't touch the slot", () => {
    const base: Overrides = { A: { daEdit: 100 } };
    const res = mergeOverrides(base, { A: { daEdit: 150 } }, base);
    expect(res.conflicts).toEqual([]);
    expect(res.merged).toEqual({ A: { daEdit: 150 } });
  });

  it("treats clearing as a change: their clear survives our untouched copy", () => {
    const base: Overrides = { A: { daEdit: 100, ipmEdit: 0.9 } };
    const ours: Overrides = { A: { daEdit: 100, ipmEdit: 0.9 } };
    const theirs: Overrides = { A: { ipmEdit: 0.9 } };
    const res = mergeOverrides(base, ours, theirs);
    expect(res.conflicts).toEqual([]);
    expect(res.merged).toEqual({ A: { ipmEdit: 0.9 } });
  });

  it("both cleared the same slot: no conflict, slot stays cleared", () => {
    const base: Overrides = { A: { daEdit: 100 } };
    const res = mergeOverrides(base, {}, {});
    expect(res.conflicts).toEqual([]);
    expect(res.merged).toEqual({});
  });

  it("one cleared, one changed: that is a conflict", () => {
    const base: Overrides = { A: { daEdit: 100 } };
    const res = mergeOverrides(base, {}, { A: { daEdit: 400 } });
    expect(res.conflicts).toEqual([
      { empId: "A", field: "daEdit", ours: undefined, theirs: 400 },
    ]);
    // merged holds OUR side (the clear) until the user settles it
    expect(res.merged).toEqual({});
  });

  it("both changed to different values: conflict, merged keeps ours", () => {
    const base: Overrides = { A: { daEdit: 100 } };
    const res = mergeOverrides(base, { A: { daEdit: 200 } }, { A: { daEdit: 300 } });
    expect(res.conflicts).toEqual([
      { empId: "A", field: "daEdit", ours: 200, theirs: 300 },
    ]);
    expect(res.merged).toEqual({ A: { daEdit: 200 } });
  });

  it("both made the identical change: no conflict", () => {
    const base: Overrides = {};
    const res = mergeOverrides(base, { A: { daEdit: 200 } }, { A: { daEdit: 200 } });
    expect(res.conflicts).toEqual([]);
    expect(res.merged).toEqual({ A: { daEdit: 200 } });
  });

  it("works from an empty base, which is how a lead's session starts", () => {
    const ours: Overrides = { V1: { daEdit: 50 } };
    const theirs: Overrides = { N1: { ipmEdit: 0.7 }, S1: { daEdit: 250 } };
    const res = mergeOverrides({}, ours, theirs);
    expect(res.conflicts).toEqual([]);
    expect(res.merged).toEqual({
      V1: { daEdit: 50 },
      N1: { ipmEdit: 0.7 },
      S1: { daEdit: 250 },
    });
  });

  it("moves the lock pair as one unit — flag and frozen figure travel together", () => {
    const base: Overrides = {};
    const ours: Overrides = { A: { daEdit: 100 } };
    const theirs: Overrides = { A: { locked: true, lockedFinal: 5000 } };
    const res = mergeOverrides(base, ours, theirs);
    expect(res.conflicts).toEqual([]);
    expect(res.merged).toEqual({ A: { daEdit: 100, locked: true, lockedFinal: 5000 } });
  });

  it("conflicting locks never mix one side's flag with the other's figure", () => {
    const base: Overrides = { A: { locked: true, lockedFinal: 1000 } };
    const ours: Overrides = { A: { locked: true, lockedFinal: 2000 } };
    const theirs: Overrides = { A: {} }; // they unlocked
    const res = mergeOverrides(base, ours, theirs);
    expect(res.conflicts).toEqual([
      { empId: "A", field: "lock", ours: true, theirs: undefined },
    ]);
    expect(res.merged).toEqual({ A: { locked: true, lockedFinal: 2000 } });

    const resolved = resolveConflicts(res.merged, theirs, res.conflicts, "theirs");
    expect(resolved).toEqual({});
  });

  it("carries stored bonus % through from theirs untouched", () => {
    const base: Overrides = { A: { bpEdit: 0.2 } };
    const ours: Overrides = { A: { bpEdit: 0.2, daEdit: 50 } };
    const theirs: Overrides = { A: { bpEdit: 0.2 } };
    const res = mergeOverrides(base, ours, theirs);
    expect(res.merged).toEqual({ A: { bpEdit: 0.2, daEdit: 50 } });
  });
});

describe("resolveConflicts", () => {
  const base: Overrides = { A: { daEdit: 100 }, B: { ipmEdit: 0.5 } };
  const ours: Overrides = { A: { daEdit: 200 }, B: { ipmEdit: 0.5 }, C: { daEdit: 10 } };
  const theirs: Overrides = { A: { daEdit: 300 }, B: { ipmEdit: 0.5 } };

  it('"ours" keeps the merged document as is', () => {
    const res = mergeOverrides(base, ours, theirs);
    const resolved = resolveConflicts(res.merged, theirs, res.conflicts, "ours");
    expect(resolved).toEqual({ A: { daEdit: 200 }, B: { ipmEdit: 0.5 }, C: { daEdit: 10 } });
  });

  it('"theirs" replaces only the conflicted slots, keeping our other work', () => {
    const res = mergeOverrides(base, ours, theirs);
    const resolved = resolveConflicts(res.merged, theirs, res.conflicts, "theirs");
    expect(resolved).toEqual({ A: { daEdit: 300 }, B: { ipmEdit: 0.5 }, C: { daEdit: 10 } });
  });

  it('"theirs" on a cleared slot removes it, dropping an emptied entry', () => {
    const res = mergeOverrides({ A: { daEdit: 100 } }, { A: { daEdit: 200 } }, {});
    expect(res.conflicts).toHaveLength(1);
    const resolved = resolveConflicts(res.merged, {}, res.conflicts, "theirs");
    expect(resolved).toEqual({});
  });

  it("does not mutate the merged document it was given", () => {
    const res = mergeOverrides(base, ours, theirs);
    const before = JSON.parse(JSON.stringify(res.merged));
    resolveConflicts(res.merged, theirs, res.conflicts, "theirs");
    expect(res.merged).toEqual(before);
  });
});
