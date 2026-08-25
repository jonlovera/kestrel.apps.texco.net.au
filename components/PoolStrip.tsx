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
 * The collapsed form of the pool cards: one thin line of the same figures, so
 * "remaining to allocate" stays on screen while the table has the room.
 */
export function PoolStrip({ summary }: { summary: PoolSummary }) {
  const items =
    summary.kind === "editor"
      ? summary.items.flatMap((it) => [
        { key: it.key, title: it.title, value: fmt(it.value), alert: it.over },
        // a card's extra figures become their own entries here: the collapsed
        // strip is one line of everything, so nothing should vanish with it
        ...(it.lines ?? []).map((l) => ({
          key: `${it.key}:${l.label}`,
          title: l.label,
          value: fmt(l.value),
          alert: false,
        })),
      ])
      : summary.items.map((it) => ({
        key: it.key,
        title: it.title,
        value: it.value,
        alert: it.alert ?? false,
      }));

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
