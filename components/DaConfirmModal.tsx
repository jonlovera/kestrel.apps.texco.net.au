"use client";

import { useEffect } from "react";
import { fmt } from "@/lib/fmt";
import type { DaImpact, DaPoolImpact } from "@/lib/da-impact";

/**
 * The confirmation step for a discretionary grant (owner decision, 24 August
 * 2026).
 *
 * A grant adds to a pool's total on top of the calculated bonuses (25 August
 * 2026), so what it spends is the room left under the caps. That is easy to
 * miss on the row being edited — the recipient's figure goes up and the cap the
 * grant just consumed is a card away — so it gets said here, against each cap,
 * before anything is committed.
 *
 * The figures come from the server (/api/state answers 428 with them rather
 * than saving), so what is confirmed is what will actually happen, and the
 * confirmation cannot be skipped by an autosave or a tab-close flush.
 */
export default function DaConfirmModal({
  impact,
  poolTitles,
  busy,
  onConfirm,
  onCancel,
}: {
  impact: DaImpact;
  /** the card labels, so this names each pool exactly as the dashboard does */
  poolTitles: { vic: string; nsw: string; group: string };
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const increases = impact.grants.filter((g) => g.amount > 0);
  const decreases = impact.grants.filter((g) => g.amount < 0);
  const title = (p: DaPoolImpact) =>
    p.key === "VIC"
      ? poolTitles.vic
      : p.key === "NSW"
        ? poolTitles.nsw
        : p.key === "SHARED"
          ? "Shared Services"
          : poolTitles.group;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={busy ? undefined : onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Confirm discretionary grant"
        className="flex max-h-[85vh] w-full max-w-[520px] flex-col overflow-y-auto bg-white shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-neutral-100 px-5 py-4">
          <div className="text-[14px] font-bold">
            Confirm {impact.grants.length === 1 ? "this discretionary change" : "these discretionary changes"}
          </div>
          <p className="mt-1 text-[12px] text-brand-70">
            A discretionary amount adds to the pool total on top of the
            calculated bonuses. It cannot take a pool past its cap. Here is
            where this leaves them.
          </p>
        </div>

        <div className="px-5 py-4">
          <div className="mb-1 text-[11px] font-bold tracking-wide text-brand-70">
            {increases.length > 0 && decreases.length > 0
              ? "CHANGING"
              : decreases.length > 0
                ? "REDUCING"
                : "GRANTING"}
          </div>
          <ul className="mb-4 space-y-1">
            {impact.grants.map((g) => (
              <li
                key={g.empId}
                className="flex items-baseline justify-between gap-4 text-[13px]"
              >
                <span className="font-semibold">{g.name}</span>
                <span className="tabular-nums">
                  {fmt(g.from)} → {fmt(g.to)}
                  <span className="ml-2 text-[11px] text-brand-70">
                    ({g.amount > 0 ? "+" : ""}
                    {fmt(g.amount)})
                  </span>
                </span>
              </li>
            ))}
          </ul>

          <div className="mb-1 text-[11px] font-bold tracking-wide text-brand-70">
            WHAT IT DOES TO THE POOLS
          </div>
          <dl className="divide-y divide-neutral-100 border-y border-neutral-100 text-[13px]">
            {impact.pools.map((p) => (
              <Row
                key={p.key}
                label={title(p)}
                value={
                  p.cap === null
                    ? `${fmt(p.before)} → ${fmt(p.after)}`
                    : `${fmt(p.before)} → ${fmt(p.after)} of ${fmt(p.cap)}`
                }
                note={
                  p.cap === null
                    ? "no cap"
                    : `${fmt(Math.max(0, p.cap - p.after))} left`
                }
              />
            ))}
          </dl>
          {/* Which of these is true depends on the "Always redistribute" tick,
              so it is read off the MEASURED impact rather than asserted:
              da-impact.ts counts the rows that actually dropped, so this
              cannot claim nobody moved while the engine is moving people. */}
          {impact.reducedCount > 0 ? (
            <p className="mt-2 text-[11px] font-bold text-brand-orange">
              This is funded from the pool, so it comes out of other people:{" "}
              {impact.reducedCount}{" "}
              {impact.reducedCount === 1 ? "person's bonus" : "people's bonuses"}{" "}
              {impact.reducedCount === 1 ? "falls" : "fall"} by{" "}
              {fmt(impact.totalReduction)} in total ({fmt(impact.averageReduction)}{" "}
              on average, {fmt(impact.largestReduction)} at most).
            </p>
          ) : (
            <p className="mt-2 text-[11px] text-brand-70">
              Nobody else&apos;s bonus changes — a discretionary amount is not
              taken from the other allocations.
            </p>
          )}

          <div className="mt-5 flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onConfirm}
              className="bg-brand-orange px-4 py-1.5 text-[12px] font-bold text-white transition-colors hover:bg-brand-orange-hover disabled:opacity-50"
            >
              {busy ? "Saving…" : "Confirm and save"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onCancel}
              className="px-4 py-1.5 text-[12px] font-semibold text-brand-70 underline underline-offset-2 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
          <p className="mt-2 text-[11px] text-brand-70">
            Cancelling leaves the figures on screen unsaved — nothing is
            discarded, and nothing is recorded until you confirm.
          </p>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-brand-70">{label}</dt>
      <dd className="text-right font-semibold tabular-nums">
        {value}
        {note && (
          <span className="ml-2 text-[11px] font-normal text-brand-70">
            ({note})
          </span>
        )}
      </dd>
    </div>
  );
}
