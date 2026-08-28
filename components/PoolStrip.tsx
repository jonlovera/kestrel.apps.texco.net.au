"use client";

import { fmt } from "@/lib/fmt";

/**
 * The pool figures as data, shared between the full cards (rendered in
 * DashboardClient, where the cap editors live) and this strip. `over` /
 * `alert` carry the same red-figure rules the cards use, so the two renderings
 * can never disagree about which number is a problem.
 */
export type PoolSummary =
  | {
    kind: "editor";
    items: {
      key: string;
      title: string;
      value: number;
      cap?: number;
      remaining?: number;
      /**
       * the waterfall that reaches the headline (Total cap → carve-outs), as
       * plain figures — see PoolCard's `buildUp`, where the cards turn the
       * editable row into an input; here it is only ever read
       */
      buildUp?: { key: string; label: string; value: number }[];
      /** further figures shown inside the same card — see PoolCard's `lines` */
      lines?: { label: string; value: number }[];
      over: boolean;
    }[];
  }
  | {
    kind: "manager";
    items: { key: string; title: string; value: string; alert?: boolean }[];
  };

/**
 * The collapsed form of the pool cards: one thin line of the figures that
 * matter while the table has the room, so "how much is left" stays on screen.
 *
 * An admin's strip is deliberately NOT everything the cards hold (owner
 * decision, 26 Aug 2026): the build-up rows and the Shared Services lines made
 * it three lines of eleven numbers. It shows four — Total cap (the group cap),
 * the two state pools, and the group total — in that order. A manager's strip
 * is their four header figures as before.
 */
export function PoolStrip({ summary }: { summary: PoolSummary }) {
  let items: { key: string; title: string; value: string; alert: boolean }[];
  if (summary.kind === "editor") {
    const by = (key: string) => summary.items.find((it) => it.key === key);
    const vic = by("vic");
    const nsw = by("nsw");
    const group = by("group");
    const vicRemaining = { key: "vicRemaining", title: "VIC Remaining", value: vic?.remaining ?? 0, over: false };
    const nswRemaining = { key: "nswRemaining", title: "NSW Remaining", value: nsw?.remaining ?? 0, over: false };
    items = [];
    if (group?.cap !== undefined)
      items.push({ key: "cap", title: "Total cap", value: fmt(group.cap), alert: false });
    for (const it of [vic, vicRemaining, nsw, nswRemaining, group]) {
      if (!it) continue;
      items.push({ key: it.key, title: it.title, value: fmt(it.value), alert: it.over });
    }
  } else {
    items = summary.items.map((it) => ({
      key: it.key,
      title: it.title,
      value: it.value,
      alert: it.alert ?? false,
    }));
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t-2 border-brand-orange bg-white px-4 py-1.5 text-[12px] shadow-sm">
      {items.map((it, i) => (
        <span key={it.key} className="flex items-center gap-1.5 whitespace-nowrap">
          {i > 0 && <span className="mr-2.5 text-neutral-300" aria-hidden="true">·</span>}
          <span className="text-[11px] text-brand-70">{it.title}</span>
          <span
            className={`font-bold tabular-nums ${it.alert ? "text-red-600" : "text-brand-95"}`}
          >
            {it.value}
          </span>
        </span>
      ))}
    </div>
  );
}
