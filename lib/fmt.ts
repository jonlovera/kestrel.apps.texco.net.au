/** Currency/percent formatting, ported from the prototype. Client-safe. */

export function fmt(v: number | null | undefined): string {
  if (v == null || isNaN(v)) return "$0";
  const n = Math.round(v);
  if (n < 0) return "($" + Math.abs(n).toLocaleString("en-AU") + ")";
  return "$" + n.toLocaleString("en-AU");
}

export function fmtPct(v: number): string {
  return (v * 100).toFixed(1) + "%";
}

export function fmtPctWhole(v: number): string {
  return Math.round(v * 100) + "%";
}

/**
 * Config-driven formatting for the column presentation settings.
 * Currency keeps the prototype's `($1,234)` negative style.
 */
export function fmtValue(
  format: "currency" | "percent" | "number",
  decimals: number,
  v: number | null | undefined
): string {
  if (v == null || isNaN(v)) return format === "percent" ? "0%" : "0";
  const opts = { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
  if (format === "currency") {
    const abs = Math.abs(v).toLocaleString("en-AU", opts);
    return v < 0 ? `($${abs})` : `$${abs}`;
  }
  if (format === "percent") {
    return (v * 100).toLocaleString("en-AU", opts) + "%";
  }
  return v.toLocaleString("en-AU", opts);
}
