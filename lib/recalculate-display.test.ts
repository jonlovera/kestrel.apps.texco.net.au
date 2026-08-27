/**
 * The printed before/after/difference must subtract. See
 * lib/recalculate-display.ts for why three independent roundings do not.
 */
import { describe, it, expect } from "vitest";
import { fmt } from "./fmt";
import { moneyChange } from "./recalculate-display";

describe("moneyChange — the figures on screen agree with each other", () => {
  it("fixes the real reproduction: 2,867,528.5958 → 2,738,642.4640", () => {
    // Traced from the live dataset. The first rounds UP 40c, the second DOWN
    // 46c, so the old fmt(after − before) printed −$128,886 beside a
    // subtraction that gives −$128,887.
    const before = 2_867_528.5958;
    const after = 2_738_642.464;
    const m = moneyChange(before, after);

    expect(fmt(m.from)).toBe("$2,867,529");
    expect(fmt(m.to)).toBe("$2,738,642");
    expect(m.to - m.from).toBe(m.delta);
    expect(fmt(m.magnitude)).toBe("$128,887");
    expect(m.direction).toBe("down");

    // and the old behaviour really did disagree — this is what was fixed
    expect(Math.round(after - before)).toBe(-128_886);
    expect(m.delta).toBe(-128_887);
  });

  it("never prints a difference the shown figures do not produce", () => {
    // Sweep fractional parts across the rounding boundary in both figures.
    for (let a = 0; a < 100; a++) {
      for (let b = 0; b < 100; b++) {
        const from = 1_000_000 + a / 100;
        const to = 900_000 + b / 100;
        const m = moneyChange(from, to);
        expect(m.to - m.from).toBe(m.delta);
        expect(fmt(m.to)).toBe(fmt(to));
        expect(fmt(m.from)).toBe(fmt(from));
      }
    }
  });

  it("moves ONLY the difference — the two figures print as they always did", () => {
    const from = 2_867_528.5958;
    const to = 2_738_642.464;
    const m = moneyChange(from, to);
    expect(fmt(m.from)).toBe(fmt(from));
    expect(fmt(m.to)).toBe(fmt(to));
  });

  it("reports magnitude only, so the glyph is not doubled by a minus sign", () => {
    const down = moneyChange(100, 40);
    expect(down.direction).toBe("down");
    expect(down.magnitude).toBe(60);
    expect(fmt(down.magnitude)).toBe("$60"); // "▼ $60", never "▼ –$60"

    const up = moneyChange(40, 100);
    expect(up.direction).toBe("up");
    expect(up.magnitude).toBe(60);
  });

  it("an exact-zero difference has no direction", () => {
    const m = moneyChange(1234.4, 1234.4);
    expect(m.direction).toBe("none");
    expect(m.magnitude).toBe(0);
  });

  it("a difference that rounds away is 'none', not a $0 arrow", () => {
    // both figures print $1,234, so the screen must not claim a movement
    const m = moneyChange(1234.4, 1234.4999);
    expect(fmt(m.from)).toBe(fmt(m.to));
    expect(m.direction).toBe("none");
  });

  it("handles a rise as readily as a fall", () => {
    const m = moneyChange(2_738_642.464, 2_867_528.5958);
    expect(m.direction).toBe("up");
    expect(m.to - m.from).toBe(m.delta);
    expect(fmt(m.magnitude)).toBe("$128,887");
  });
});
