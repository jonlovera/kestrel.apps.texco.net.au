"use client";

import type { ReactNode } from "react";

/** Pool summary card, matching the prototype's .pool-card. */

export function PoolCard({
  title,
  value,
  footer,
}: {
  title: string;
  value: string;
  /** The editable pool-cap line, for the cards that have one. */
  footer?: ReactNode;
}) {
  return (
    <div className="min-w-[280px] flex-1 border-t-4 border-brand-orange bg-white p-5 shadow-sm">
      <h3 className="mb-1 text-[13px] font-bold text-brand-95">{title}</h3>
      <div className="text-lg font-bold tabular-nums text-brand-95">{value}</div>
      {footer}
    </div>
  );
}
