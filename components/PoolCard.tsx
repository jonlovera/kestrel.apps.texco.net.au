/** Pool summary card, matching the prototype's .pool-card. */

export interface PoolMetric {
  label: string;
  value: string;
  negative?: boolean;
  bold?: boolean;
}

export function PoolCard({
  title,
  metrics,
  utilPct,
  scaleFactor,
  scaleLabel,
}: {
  title: string;
  metrics: PoolMetric[];
  utilPct: number;
  scaleFactor?: number | null;
  scaleLabel?: string;
}) {
  const pct = Math.min(utilPct * 100, 100);
  const over = utilPct > 1;
  return (
    <div className="min-w-[280px] flex-1 rounded-lg border-t-4 border-[#FC4D0F] bg-white p-5 shadow-sm">
      <h3 className="mb-3 text-[13px] font-bold uppercase tracking-[1.5px] text-[#191919]">
        {title}
      </h3>
      {metrics.map((m) => (
        <div
          key={m.label}
          className="flex justify-between border-b border-neutral-100 py-[5px] text-[13px] last:border-b-0"
        >
          <span className="text-[#5C5C5C]">{m.label}</span>
          <span
            className={`font-bold ${m.negative ? "text-[#FC4D0F]" : "text-[#191919]"} ${
              m.bold ? "text-sm" : ""
            }`}
          >
            {m.value}
          </span>
        </div>
      ))}
      <div className="mt-2.5 h-2 overflow-hidden rounded bg-neutral-200">
        <div
          className={`h-full rounded transition-all ${over ? "bg-[#191919]" : "bg-[#FC4D0F]"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {scaleFactor !== null && scaleFactor !== undefined && (
        <>
          <div className="mt-2.5 text-center text-[28px] font-medium tracking-tight text-[#FC4D0F]">
            {scaleFactor.toFixed(4)}x
          </div>
          <div className="mt-0.5 text-center text-[10px] uppercase tracking-[1.5px] text-[#5C5C5C]">
            {scaleLabel ?? "Scale factor"}
          </div>
        </>
      )}
    </div>
  );
}
