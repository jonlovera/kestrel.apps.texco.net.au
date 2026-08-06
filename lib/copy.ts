/**
 * The dashboard's editable wording — pure module (schema, defaults, merge),
 * no I/O.
 *
 * Same separation as lib/columns.ts: this decides what is WORDED, never what
 * is sent. Nothing here touches entitlement (lib/scope-core.ts) or the calc
 * engine (lib/calc.ts), so it is safe to put on every payload regardless of
 * scope.
 *
 * Deliberately NOT included: the `metadata.title = "Texco"` on every page and
 * the /login and /no-access wording. Those are the pre-auth scrubbing — the
 * scheme must not be named on any surface an unauthenticated visitor can
 * reach — so they stay in code where a self-service edit cannot undo them.
 */
import { z } from "zod";

const line = (max: number) => z.string().trim().min(1).max(max);

export const CopySchema = z.object({
  /** header eyebrow beside the logo */
  schemeName: line(80),
  /** the strip under the header; hidden entirely when bannerVisible is false */
  bannerText: line(80),
  bannerVisible: z.boolean(),
  /** the three editor pool-card titles */
  poolTitles: z.object({
    vic: line(40),
    nsw: line(40),
    group: line(40),
  }),
  footerText: line(160),
});
export type Copy = z.infer<typeof CopySchema>;

/**
 * What a stored doc may look like: any subset, so a doc written before a
 * field existed still loads (the missing field falls back to its default).
 */
export const StoredCopySchema = CopySchema.partial().extend({
  poolTitles: CopySchema.shape.poolTitles.partial().optional(),
});

/** Today's exact wording — first load must read identically. */
export const DEFAULT_COPY: Copy = {
  schemeName: "FY26 Employee Bonus Scheme",
  bannerText: "Draft — not final",
  bannerVisible: true,
  poolTitles: { vic: "VIC pool", nsw: "NSW pool", group: "Group total" },
  footerText:
    "texco | FY26 Employee Bonus Scheme | Confidential | Innovate. Design. Deliver.",
};

/** Merge a stored (possibly partial) doc over the defaults. */
export function resolveCopy(stored: unknown): Copy {
  const parsed = StoredCopySchema.safeParse(stored ?? {});
  if (!parsed.success) return DEFAULT_COPY;
  const s = parsed.data;
  return {
    schemeName: s.schemeName ?? DEFAULT_COPY.schemeName,
    bannerText: s.bannerText ?? DEFAULT_COPY.bannerText,
    bannerVisible: s.bannerVisible ?? DEFAULT_COPY.bannerVisible,
    poolTitles: {
      vic: s.poolTitles?.vic ?? DEFAULT_COPY.poolTitles.vic,
      nsw: s.poolTitles?.nsw ?? DEFAULT_COPY.poolTitles.nsw,
      group: s.poolTitles?.group ?? DEFAULT_COPY.poolTitles.group,
    },
    footerText: s.footerText ?? DEFAULT_COPY.footerText,
  };
}
