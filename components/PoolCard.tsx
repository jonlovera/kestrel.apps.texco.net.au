"use client";

import type { ReactNode } from "react";

/** Pool summary card, matching the prototype's .pool-card. */

export function PoolCard({
  title,
  value,
  buildUp,
  lines,
  footer,
  /**
   * Colours the figure. `alert` is for a manager's Remaining at or below zero:
   * the one card whose value is a verdict rather than a measurement.
   */
  tone = "normal",
  kind,
}: {
  title: string;
  value: string;
  /**
   * How the headline is REACHED, shown above it: the rows of a waterfall whose
   * last line is the headline itself (Total cap → less shared services → less
   * split state → state pool). Values are nodes rather than strings so the row
   * that is editable — the total cap — can carry its input right where the
   * figure is read, instead of in a separate footer line nobody connects to
   * the headline.
   */
  buildUp?: { key: string; label: string; value: ReactNode }[];
  /**
   * Further figures belonging to the same box, under the headline one. Shared
   * Services uses it to carry the two SS Other portions rather than spending a
   * card each on them.
   */
  lines?: { label: string; value: string }[];
  /** The editable pool-cap line, for the cards that have one. */
  footer?: ReactNode;
  tone?: "normal" | "alert";
  kind?: "manager" | "editor";
}) {
  return (
    <div className="min-w-[280px] flex-1 border-t-4 border-brand-orange bg-white p-5 shadow-sm">
      <h3 className="mb-1 text-[13px] font-bold text-brand-95">{title}</h3>
      {buildUp && buildUp.length > 0 && (
        <div className="mb-1.5 space-y-0.5 border-b border-neutral-100 pb-1.5">
          {buildUp.map((b) => (
            <div
              key={b.key}
              className="flex items-baseline justify-between gap-3 text-[11px]"
            >
              <span className="text-brand-70">{b.label}</span>
              <span className="font-semibold tabular-nums text-brand-95">
                {b.value}
              </span>
            </div>
          ))}
        </div>
      )}
      <div
        className={`text-lg font-bold tabular-nums ${tone === "alert" ? "text-red-600" : "text-brand-95"
          }`}
      >
        {!['Shared Services', 'Group total'].includes(title) && !kind ? `${title.replace(' pool', ' State')} Cap:` : ""} {value}
      </div>
      {lines && lines.length > 0 && (
        <div className="mt-2 space-y-1 border-t border-neutral-100 pt-2">
          {lines.map((l) => (
            <div
              key={l.label}
              className="flex items-baseline justify-between gap-3 text-[11px]"
            >
              <span className="text-brand-70">{l.label}</span>
              <span className="font-bold tabular-nums text-brand-95">
                {l.value}
              </span>
            </div>
          ))}
        </div>
      )}
      {footer}
    </div>
  );
}
