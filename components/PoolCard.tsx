"use client";

/** Pool summary card, matching the prototype's .pool-card. */

export interface PoolMetric {
  label: string;
  value: string;
  negative?: boolean;
  bold?: boolean;
  /**
   * Present on the "Pool cap" row in edit mode: the figure becomes an input
   * and the caller recalculates the whole dashboard as it is typed, so the
   * live cards are the impact preview.
   */
  onEdit?: (raw: string) => void;
  editValue?: number;
}

export function PoolCard({
  title,
  titleNode,
  metrics,
  utilPct,
  busy = false,
}: {
  title: string;
  /** replaces the heading text when it is editable */
  titleNode?: React.ReactNode;
  metrics: PoolMetric[];
  utilPct: number;
  busy?: boolean;
}) {
  const pct = Math.min(utilPct * 100, 100);
  const over = utilPct > 1;
  return (
    <div className="min-w-[280px] flex-1 border-t-4 border-brand-orange bg-white p-5 shadow-sm">
      <h3 className="mb-3 text-[13px] font-bold text-brand-95">
        {titleNode ?? title}
      </h3>
      {metrics.map((m) => (
        <div
          key={m.label}
          className="flex items-center justify-between border-b border-neutral-100 py-[5px] text-[13px] last:border-b-0"
        >
          <span className="text-brand-70">{m.label}</span>
          {m.onEdit ? (
            <input
              key={`${m.label}-${m.editValue}`}
              type="text"
              defaultValue={Math.round(m.editValue ?? 0)}
              disabled={busy}
              aria-label={m.label}
              onFocus={(e) => e.target.select()}
              onBlur={(e) => m.onEdit!(e.target.value)}
              onKeyDown={(e) => {
                const el = e.target as HTMLInputElement;
                if (e.key === "Enter") el.blur();
                if (e.key === "Escape") {
                  el.value = String(Math.round(m.editValue ?? 0));
                  el.blur();
                }
              }}
              className="w-[120px] border border-neutral-300 px-1.5 py-0.5 text-right text-[13px] font-bold tabular-nums outline-none focus:border-brand-orange disabled:opacity-50"
            />
          ) : (
            <span
              className={`font-bold ${m.negative ? "text-brand-orange" : "text-brand-95"} ${
                m.bold ? "text-sm" : ""
              }`}
            >
              {m.value}
            </span>
          )}
        </div>
      ))}
      <div className="mt-2.5 h-2 overflow-hidden bg-neutral-200">
        <div
          className={`h-full transition-all ${over ? "bg-brand-95" : "bg-brand-orange"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
