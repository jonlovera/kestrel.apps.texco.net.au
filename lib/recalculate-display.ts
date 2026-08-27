/**
 * How a money change is PRESENTED. Pure, no React, no I/O — the arithmetic a
 * reader can check with their own eyes, kept out of the component so it can be
 * tested directly.
 *
 * WHY THIS EXISTS. Every figure in this app reaches the screen through fmt()
 * (lib/fmt.ts), which rounds to whole dollars. A before/after/difference trio
 * therefore gets rounded THREE separate times, and rounding is not additive:
 *
 *     raw     2,867,528.5958  →  2,738,642.4640   (true difference −128,886.13)
 *     printed    $2,867,529   →     $2,738,642    and    −$128,886
 *     but        $2,738,642   −     $2,867,529     =     −$128,887
 *
 * The first figure rounds UP by 40c and the second rounds DOWN by 46c, so the
 * subtraction a reader performs on screen lands a dollar away from the
 * difference printed beside it. Nothing is miscalculated — the underlying
 * figures are exact to the cent — but a confirmation screen whose three numbers
 * visibly disagree is not one anybody should approve a bonus run from.
 *
 * THE RULE: round first, subtract second. The difference is derived from the
 * figures actually shown, so it always subtracts. The cost is that the shown
 * difference can sit up to $1 from the exact difference; on a screen already
 * rounded to whole dollars that is invisible, and it buys arithmetic the reader
 * can verify. Showing cents was the alternative and was rejected: it is exact
 * but contradicts whole-dollar display everywhere else, and makes a sixty-row
 * table much harder to scan.
 *
 * The direction is returned rather than left to the sign, because the glyph
 * carries it on screen: ▼ $128,887 and never ▼ –$128,887.
 */

export interface MoneyChange {
  /** the "before" figure as printed — whole dollars */
  from: number;
  /** the "after" figure as printed — whole dollars */
  to: number;
  /** to − from, in whole dollars: subtracts on screen by construction */
  delta: number;
  /** magnitude only; the glyph carries the sign */
  magnitude: number;
  direction: "up" | "down" | "none";
}

/**
 * Resolve a raw before/after pair into the figures to print.
 *
 * Feed the results straight to fmt(). Passing already-rounded integers through
 * it is a no-op, so `from` and `to` print exactly as they always did — only the
 * difference moves, and only ever by the dollar that made it disagree.
 */
export function moneyChange(fromRaw: number, toRaw: number): MoneyChange {
  const from = Math.round(fromRaw);
  const to = Math.round(toRaw);
  const delta = to - from;
  return {
    from,
    to,
    delta,
    magnitude: Math.abs(delta),
    direction: delta === 0 ? "none" : delta > 0 ? "up" : "down",
  };
}
