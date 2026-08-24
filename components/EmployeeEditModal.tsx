"use client";

import { useEffect, useState } from "react";

type State = "VIC" | "NSW" | "SHARED";

export interface EditableEmployee {
  id: string;
  name: string;
  pos: string;
  st: State;
  /** current VIC share (0..1); fractional means the cost splits across pools */
  vp: number;
}

const STATE_OPTIONS: { value: State; label: string; note: string }[] = [
  { value: "VIC", label: "VIC pool", note: "a VIC employee" },
  { value: "NSW", label: "NSW pool", note: "an NSW employee" },
  {
    value: "SHARED",
    label: "Shared Services",
    note: "belongs to neither state — always split",
  },
];

/** Does this VIC share divide across both pools? */
const isSplit = (vp: number) => vp > 0 && vp < 1;

/**
 * The per-person admin actions that aren't inline figures: which pool someone
 * belongs to, how their cost divides between the two, and removing them from
 * the model entirely (which used to be the ✕ button on the row). All writes go
 * through the caller's patchDataset, which snapshots first and records history.
 *
 * Pool and split are separate questions. Shared Services is for people who
 * belong to neither state and is always split; VIC and NSW default to their
 * whole pool but can carry a split too, which is how a VIC employee who does a
 * portion of NSW work is modelled — VIC on the tab and the VIC card, cost
 * divided across both pools.
 */
export default function EmployeeEditModal({
  employee,
  busy,
  error,
  onApplyState,
  onRemove,
  onClose,
}: {
  employee: EditableEmployee;
  busy: boolean;
  /** the dashboard's dataset error, surfaced inline while the modal is open */
  error: string | null;
  onApplyState: (st: State, vicShare?: number) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [st, setSt] = useState<State>(employee.st);
  // Pre-filled from whatever split they already have, whatever their state, so
  // re-flagging a split person keeps their percentages without retyping them.
  const [vicPct, setVicPct] = useState<number>(
    Math.round((isSplit(employee.vp) ? employee.vp : 0.5) * 100)
  );
  const [splitEnabled, setSplitEnabled] = useState<boolean>(isSplit(employee.vp));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Shared Services is always split; VIC and NSW are split only on request,
  // and otherwise take the whole of their own pool.
  const showSplit = st === "SHARED" || splitEnabled;
  const vicShare = showSplit ? vicPct / 100 : st === "VIC" ? 1 : 0;
  const dirty = st !== employee.st || vicShare !== employee.vp;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Edit ${employee.name}`}
        className="flex max-h-[85vh] w-full max-w-[440px] flex-col overflow-y-auto bg-white shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-neutral-100 px-5 py-4">
          <div>
            <div className="text-[14px] font-bold">{employee.name}</div>
            <div className="mt-0.5 text-[12px] text-brand-70">{employee.pos}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="px-2 text-[18px] leading-none text-brand-70 transition-colors hover:text-brand-orange"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4">
          {error && (
            <div className="mb-3 border-2 border-error bg-error-tint px-3 py-2 text-[12px] font-semibold">
              {error}
            </div>
          )}

          <div className="mb-1 text-[11px] font-bold tracking-wide text-brand-70">
            POOL
          </div>
          <div className="space-y-1.5">
            {STATE_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className="flex cursor-pointer items-baseline gap-2 text-[13px]"
              >
                <input
                  type="radio"
                  name="employee-state"
                  checked={st === opt.value}
                  disabled={busy}
                  onChange={() => setSt(opt.value)}
                  className="translate-y-[1px] accent-brand-orange"
                />
                <span className="font-semibold">{opt.label}</span>
                <span className="text-[11px] text-brand-70">{opt.note}</span>
              </label>
            ))}
          </div>

          {st !== "SHARED" && (
            <label className="mt-3 flex cursor-pointer items-baseline gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={splitEnabled}
                disabled={busy}
                onChange={(e) => setSplitEnabled(e.target.checked)}
                className="translate-y-[1px] accent-brand-orange"
              />
              <span className="font-semibold">Cost splits across both states</span>
              <span className="text-[11px] text-brand-70">
                stays {st}, drawing part of their bonus from the other pool
              </span>
            </label>
          )}

          {showSplit && (
            <div className="mt-3 flex items-center gap-2 text-[13px]">
              <span>VIC</span>
              <input
                type="number"
                min={0}
                max={100}
                value={vicPct}
                disabled={busy}
                onChange={(e) =>
                  setVicPct(
                    Math.min(100, Math.max(0, Math.round(Number(e.target.value) || 0)))
                  )
                }
                className="w-[64px] border border-neutral-300 px-2 py-1 text-right tabular-nums focus:border-brand-orange focus:outline-none"
              />
              <span>% · NSW {100 - vicPct}%</span>
            </div>
          )}

          <p className="mt-3 text-[11px] text-brand-70">
            The spreadsheet import stays the source of truth for the figures,
            including any split percentages above. The pool is yours to set: the
            workbook only guesses at it from the split, so an import that still
            splits {employee.name} keeps the pool you choose here.
          </p>

          <button
            type="button"
            disabled={busy || !dirty}
            onClick={() => onApplyState(st, showSplit ? vicShare : undefined)}
            className="mt-3 bg-brand-orange px-4 py-1.5 text-[12px] font-bold text-white transition-colors hover:bg-brand-orange-hover disabled:opacity-50"
          >
            {busy ? "Saving…" : "Apply pool change"}
          </button>

          <div className="mt-5 border-t border-neutral-100 pt-4">
            <div className="mb-1 text-[11px] font-bold tracking-wide text-brand-70">
              REMOVE
            </div>
            <p className="mb-2 text-[11px] text-brand-70">
              Removes {employee.name} from the model permanently. They won&apos;t
              reappear even if a future import still lists them. This can be
              undone from Admin → Import.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={onRemove}
              className="border-2 border-error px-4 py-1.5 text-[12px] font-bold text-error transition-colors hover:bg-error hover:text-white disabled:opacity-50"
            >
              Remove from model
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
