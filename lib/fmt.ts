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
