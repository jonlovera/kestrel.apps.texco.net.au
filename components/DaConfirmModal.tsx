"use client";

import { useEffect } from "react";
import { fmt } from "@/lib/fmt";
import type { DaImpact } from "@/lib/da-impact";

/**
 * The confirmation step for a discretionary grant (owner decision, 24 August
 * 2026).
 *
 * A grant is funded from the pool, which means it is funded by everyone else's
 * unlocked bonus. That is invisible on the row being edited — the recipient's
 * figure goes up and nothing on screen says whose went down — so it gets said
 * here, in the numbers the owner asked for, before anything is committed.
 *
 * The figures come from the server (/api/state answers 428 with them rather
 * than saving), so what is confirmed is what will actually happen, and the
 * confirmation cannot be skipped by an autosave or a tab-close flush.
 */
export default function DaConfirmModal({
  impact,
  busy,
  onConfirm,
  onCancel,
}: {
  impact: DaImpact;
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
  const nobodyPays = impact.reducedCount === 0;

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
            A discretionary amount is funded from the pool, so it is paid for by
            the bonuses that aren&apos;t locked. Here is what this does.
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
            WHO PAYS FOR IT
          </div>
          {nobodyPays ? (
            <p className="text-[13px]">
              Nobody&apos;s bonus goes down. This change frees money back into
              the pool rather than drawing from it.
            </p>
          ) : (
            <dl className="divide-y divide-neutral-100 border-y border-neutral-100 text-[13px]">
              <Row label="Bonuses reduced" value={String(impact.reducedCount)} />
              <Row
                label="Average reduction per person"
                value={fmt(impact.averageReduction)}
              />
              <Row
                label="Largest single reduction"
                value={fmt(impact.largestReduction)}
              />
              <Row
                label="Locked bonuses, unaffected"
                value={String(impact.lockedUnaffected)}
              />
            </dl>
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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-brand-70">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
