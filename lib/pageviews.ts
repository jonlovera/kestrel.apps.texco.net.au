import { z } from "zod";

/**
 * Durable visitor logging, separate from the core bonus-data domain model in
 * schema.ts. Two shapes: a page view by someone who's signed in (attributed
 * to their email), and a hit from someone who isn't (anonymous — bots,
 * scanners, anyone who never gets through login). Both are rows in the
 * existing `kestrel_log` table (lib/store.ts); no new table needed.
 */
export const PageviewEntrySchema = z.object({
  ts: z.string(), // ISO timestamp, server-side
  path: z.string(),
  email: z.string(),
  name: z.string().optional(),
});

export type PageviewEntry = z.infer<typeof PageviewEntrySchema>;

/**
 * Anonymous hit to a page other than /login. `ipPrefix` is truncated (see
 * truncateIp below) — never a full IP, just enough to tell distinct sources
 * apart roughly.
 */
export const AnonVisitEntrySchema = z.object({
  ts: z.string(),
  path: z.string(),
  ipPrefix: z.string().nullable(),
});

export type AnonVisitEntry = z.infer<typeof AnonVisitEntrySchema>;

/**
 * Zero out the last IPv4 octet or the trailing IPv6 groups, so what's stored
 * can distinguish roughly-distinct sources without ever holding a full,
 * individually-identifying IP address.
 */
export function truncateIp(ip: string): string {
  const v4 = ip.split(".");
  if (v4.length === 4 && v4.every((p) => /^\d{1,3}$/.test(p))) {
    return `${v4[0]}.${v4[1]}.${v4[2]}.0`;
  }
  if (ip.includes(":")) {
    // Drop the empty segments "::" compression leaves behind (e.g. loopback
    // "::1" → ["", "", "1"]) before taking the leading groups, so a short
    // address doesn't come back with a doubled "::".
    const groups = ip.split(":").filter((g) => g.length > 0);
    return `${groups.slice(0, 3).join(":")}::`;
  }
  return ip;
}

/**
 * Client IP from the standard proxy header Vercel sets. Returns null rather
 * than throwing when absent (local dev, or a header shape we don't expect) —
 * a page view is still worth logging without a source.
 */
export function clientIpFrom(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (!forwarded) return null;
  const first = forwarded.split(",")[0]?.trim();
  return first || null;
}
