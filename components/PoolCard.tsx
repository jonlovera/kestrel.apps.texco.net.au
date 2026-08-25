"use client";

import type { ReactNode } from "react";

/** Pool summary card, matching the prototype's .pool-card. */

export function PoolCard({
  title,
  value,
  lines,
  footer,
  /**
   * Colours the figure. `alert` is for a manager's Remaining at or below zero:
   * the one card whose value is a verdict rather than a measurement.
   */
  tone = "normal",
}: {
  title: string;
  value: string;
  /**
   * Further figures belonging to the same box, under the headline one. Shared
   * Services uses it to carry the two SS Other portions rather than spending a
   * card each on them.
   */
  lines?: { label: string; value: string }[];
  /** The editable pool-cap line, for the cards that have one. */
  footer?: ReactNode;
  tone?: "normal" | "alert";
}) {
  return (
    <div className="min-w-[280px] flex-1 border-t-4 border-brand-orange bg-white p-5 shadow-sm">
      <h3 className="mb-1 text-[13px] font-bold text-brand-95">{title}</h3>
      <div
        className={`text-lg font-bold tabular-nums ${
          tone === "alert" ? "text-red-600" : "text-brand-95"
        }`}
      >
        {value}
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
