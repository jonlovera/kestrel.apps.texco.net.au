"use client";

import { useEffect } from "react";
import { fmt } from "@/lib/fmt";
import { moneyChange, type MoneyChange } from "@/lib/recalculate-display";

/** One row's movement, as /api/recalculate reports it. */
export interface RecalcChangeRow {
  empId: string;
  name: string;
  from: number;
  to: number;
}

export interface RecalcPreview {
  scaleFrom: { vic: number; nsw: number };
  scaleTo: { vic: number; nsw: number };
  firstRun: boolean;
  vic: { available: number; potential: number; fixed: number; scale: number };
  nsw: { available: number; potential: number; fixed: number; scale: number };
  eligible: number;
  moving: number;
  carveFunded: number;
  totalBefore: number;
  totalAfter: number;
  changes: RecalcChangeRow[];
  truncated: number;
}

const pct = (n: number) => `${(n * 100).toFixed(3)}%`;

/** ▼ down, ▲ up — the app's own direction glyphs (EmployeeTable's sort caret). */
const GLYPH = { down: "▼", up: "▲", none: "" } as const;
/**
 * Red for a fall, green for a rise. Red already means "negative money" here
 * (PoolCard's alert tone on a Remaining below zero); green is a defined token.
 * Colour is never the only signal — the glyph and the sign carry it too.
 */
const TONE = {
  down: "text-error",
  up: "text-success",
  none: "text-brand-70",
} as const;

/** Screen readers get words; the glyph alone says nothing out loud. */
function spoken(c: MoneyChange): string {
  if (c.direction === "none") return "no change to the total payout";
  return `${c.direction === "down" ? "down" : "up"} ${fmt(c.magnitude)}`;
}

/**
 * The confirmation for Recalculate — the one operation that moves everybody's
 * bonus at once, so it is the one operation that gets asked twice.
 *
 * Read top to bottom it answers, in order: what is about to happen, how much
 * the total payout moves, why this particular run is special, where the Scale
 * Factor lands, who individually moves, and then confirm or cancel. That order
 * is the whole design — it used to present all of that at one visual weight,
 * which read as a calculation trace rather than a financial decision.
 *
 * Every figure comes from the server running the SAME function the commit runs
 * (lib/recalculate.ts, via /api/recalculate's `preview` mode), never from an
 * estimate computed here. That is what makes "what you were shown is what
 * happened" true rather than merely likely. The only arithmetic done in this
 * file is lib/recalculate-display.ts's rounding rule, which decides how the
 * figures are PRINTED and changes none of them.
 */
export default function RecalculateModal({
  preview,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  preview: RecalcPreview;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  // Round first, subtract second, so the three figures below agree with each
  // other on screen. See lib/recalculate-display.ts.
  const total = moneyChange(preview.totalBefore, preview.totalAfter);
  const cell = "px-3 py-1.5 text-right tabular-nums";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => !busy && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Recalculate the pool"
        className="flex max-h-[85vh] w-full max-w-180 flex-col bg-white shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 1 — what is going to happen */}
        <div className="flex items-start justify-between gap-4 border-b border-neutral-100 px-5 py-4">
          <div>
            <div className="text-[15px] font-bold text-brand-95">
              Recalculate the pool
            </div>
            <div className="mt-0.5 text-[12px] text-brand-70">
              Recalculates the pool using the latest Scale Factor and updates
              eligible bonuses.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="px-2 text-[18px] leading-none text-brand-70 transition-colors hover:text-brand-orange disabled:opacity-40"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <div className="mb-4 border-2 border-error bg-error-tint px-3 py-2 text-[12px] font-semibold">
              {error}
            </div>
          )}

          {/* 2 — how much the total payout changes. The headline of the whole
              screen: this is the number somebody is actually approving. */}
          <div className="mb-4 border-t-4 border-brand-orange bg-surface-sunken px-5 py-4">
            <div className="text-[12px] font-semibold text-brand-70">
              <span className="font-bold text-brand-95">
                {preview.moving}{" "}
                {preview.moving === 1 ? "bonus moves" : "bonuses move"}
              </span>{" "}
              · of {preview.eligible} eligible
            </div>

            <div className="mt-3 text-[11px] font-bold tracking-wide text-brand-70">
              TOTAL PAYOUT
            </div>
            <div className="mt-0.5 text-[17px] font-semibold tabular-nums text-brand-95">
              {fmt(total.from)}{" "}
              <span className="px-1 font-normal text-brand-70">&rarr;</span>{" "}
              {fmt(total.to)}
            </div>

            <div
              className={`mt-2 text-[26px] font-bold leading-none tabular-nums ${TONE[total.direction]}`}
              aria-label={spoken(total)}
            >
              {total.direction === "none" ? (
                <span className="text-[15px] font-semibold">
                  No change to the total payout
                </span>
              ) : (
                <>
                  <span aria-hidden="true" className="text-[20px]">
                    {GLYPH[total.direction]}
                  </span>{" "}
                  {fmt(total.magnitude)}
                </>
              )}
            </div>
          </div>

          {/* 3 — why this recalculation is special */}
          {preview.firstRun && (
            <div className="mb-4 border-2 border-brand-orange/40 bg-brand-orange-tint/40 px-3 py-2.5 text-[12px] leading-relaxed">
              <div className="font-bold text-brand-95">
                This is the first recalculation for this pool.
              </div>
              <p className="mt-1">
                No Scale Factor has been stored yet, so no IPM edit has changed
                anyone&apos;s payout.
              </p>
              <p className="mt-1">
                Confirming this recalculation will lock in the new Scale Factor.
                From that point forward, changing an employee&apos;s IPM will
                only affect that employee&apos;s payout.
              </p>
            </div>
          )}

          {/* 4 — where the Scale Factor lands */}
          <div className="mb-3 grid grid-cols-2 gap-3">
            {(
              [
                ["vic", "VIC"],
                ["nsw", "NSW"],
              ] as const
            ).map(([k, label]) => {
              const p = preview[k];
              const was = preview.scaleFrom[k];
              return (
                <div key={k} className="border border-neutral-200 px-3 py-2.5">
                  <div className="text-[11px] font-bold tracking-wide text-brand-70">
                    {label} SCALE FACTOR
                  </div>
                  <div className="mt-1 text-[17px] font-bold tabular-nums text-brand-95">
                    <span className="font-semibold text-brand-70">
                      {pct(was)}
                    </span>
                    <span className="px-1 font-normal text-brand-70">
                      &rarr;
                    </span>
                    {pct(p.scale)}
                  </div>
                  {/* Supporting figures, deliberately secondary — the same
                      label/value treatment PoolCard uses for its build-up. */}
                  <div className="mt-2 space-y-0.5 border-t border-neutral-100 pt-1.5">
                    {[
                      ["Available pool", p.available],
                      ["Potential at 100% IPM", p.potential],
                    ].map(([l, v]) => (
                      <div
                        key={l as string}
                        className="flex items-baseline justify-between gap-3 text-[11px]"
                      >
                        <span className="text-brand-70">{l as string}</span>
                        <span className="font-semibold tabular-nums text-brand-95">
                          {fmt(v as number)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Two lines rather than one sentence: the first is the reassurance
              somebody scans for before approving, the second is detail. */}
          <div className="mb-4 text-[11px] leading-relaxed text-brand-70">
            <span className="block font-bold text-brand-95">
              Locked and issued bonuses are not changed.
            </span>
            <span className="mt-0.5 block">
              Discretionary amounts remain exactly as entered.
              {preview.carveFunded > 0 && (
                <>
                  {" "}
                  Includes {preview.carveFunded} part-split / shared-services{" "}
                  {preview.carveFunded === 1 ? "person" : "people"}.
                </>
              )}
            </span>
          </div>

          {/* 5 — who individually moves */}
          {preview.changes.length === 0 ? (
            <div className="border border-neutral-200 px-3 py-4 text-center text-[12px] text-brand-70">
              No payout would change.
            </div>
          ) : (
            <div className="max-h-70 overflow-y-auto border border-neutral-200">
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 bg-neutral-100 text-[11px] font-bold tracking-wide text-brand-70">
                  <tr>
                    <th className="px-3 py-1.5 text-left">NAME</th>
                    <th className="px-3 py-1.5 text-right">NOW</th>
                    <th className="px-3 py-1.5 text-right">AFTER</th>
                    <th className="px-3 py-1.5 text-right">CHANGE</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.changes.map((c) => {
                    // Same rounding rule as the headline, so every row's three
                    // figures subtract too.
                    const m = moneyChange(c.from, c.to);
                    return (
                      <tr key={c.empId} className="border-t border-neutral-100">
                        <td className="px-3 py-1.5">{c.name}</td>
                        <td className={cell}>{fmt(m.from)}</td>
                        <td className={cell}>{fmt(m.to)}</td>
                        <td
                          className={`${cell} font-bold ${TONE[m.direction]}`}
                          aria-label={spoken(m)}
                        >
                          <span aria-hidden="true" className="text-[10px]">
                            {GLYPH[m.direction]}
                          </span>{" "}
                          {fmt(m.magnitude)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {preview.truncated > 0 && (
                <div className="border-t border-neutral-100 px-3 py-1.5 text-[11px] text-brand-70">
                  and {preview.truncated} more — all of them will be updated.
                </div>
              )}
            </div>
          )}
        </div>

        {/* 6 — confirm or cancel. The reassurance sits here rather than in the
            subtitle: this is the moment it is actually needed. */}
        <div className="flex items-center justify-between gap-4 border-t border-neutral-100 px-5 py-3">
          <span className="text-[12px] font-semibold text-brand-70">
            Nothing is saved until you confirm.
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="px-3 py-1.5 text-[12px] font-semibold text-brand-70 underline underline-offset-2 disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              className="bg-brand-orange px-4 py-1.5 text-[12px] font-bold tracking-wide text-white transition-colors hover:bg-brand-orange-hover disabled:opacity-40"
            >
              {busy ? "Recalculating…" : "Confirm and recalculate"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
