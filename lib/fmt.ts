/** Currency/percent formatting, ported from the prototype. Client-safe. */

export function fmt(v: number | null | undefined): string {
  if (v == null || isNaN(v)) return "$0";
  const n = Math.round(v);
  if (n < 0) return "–$" + Math.abs(n).toLocaleString("en-AU");
  return "$" + n.toLocaleString("en-AU");
}

export function fmtPct(v: number): string {
  return (v * 100).toFixed(1) + "%";
}

export function fmtPctWhole(v: number): string {
  return Math.round(v * 100) + "%";
}

/**
 * A percentage with only the decimals it actually has, up to two: 0.9 → "90%",
 * 0.875 → "87.5%", 0.095 → "9.5%". For figures a person typed — IPM, bonus %,
 * a split — where rounding to a whole percent would show them something other
 * than what they entered (an IPM of 87.5% used to read "88%").
 */
export function fmtPctSmart(v: number): string {
  return +(v * 100).toFixed(2) + "%";
}

/**
 * Config-driven formatting for the column presentation settings.
 * Currency keeps the prototype's `($1,234)` negative style.
 */
export function fmtValue(
  format: "currency" | "percent" | "number" | "text",
  decimals: number,
  v: number | null | undefined
): string {
  // 'text' belongs to the identity columns, which render their own strings and
  // never reach here; treat it as a plain passthrough rather than throwing.
  if (format === "text") return v == null || isNaN(v) ? "" : String(v);
  if (v == null || isNaN(v)) return format === "percent" ? "0%" : "0";
  const opts = { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
  if (format === "currency") {
    const abs = Math.abs(v).toLocaleString("en-AU", opts);
    return v < 0 ? `–$${abs}` : `$${abs}`;
  }
  if (format === "percent") {
    // `decimals` is the minimum shown; a figure carrying more precision than
    // that keeps up to two places rather than being rounded away, so an IPM of
    // 87.5% reads "87.5%" in a column configured for whole percentages while
    // 90% still reads "90%".
    return (
      (v * 100).toLocaleString("en-AU", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: Math.max(decimals, 2),
      }) + "%"
    );
  }
  return v.toLocaleString("en-AU", opts);
}
