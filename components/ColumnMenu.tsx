"use client";

import { useEffect, useState } from "react";
import {
  COLUMN_FORMATS,
  DEFAULT_COLUMNS,
  isIdentityField,
  type ColumnConfig,
  type ColumnConfigEntry,
} from "@/lib/columns";

/**
 * The dashboard's column control: which columns show, in what order, under
 * what heading and number format. Replaces the old /admin/columns page.
 *
 * Display only — it can't change a figure or who is entitled to see one; the
 * server re-derives both from lib/scope-core.ts on the next load, and
 * lib/columns.test.ts holds that line.
 *
 * Opens as a centred modal rather than a popover: it now lives inside the
 * Filters & options panel, whose own scrolling would clip a 440px-wide
 * floating list. A modal escapes every stacking and overflow question, and a
 * 19-row configuration table reads better centred anyway.
 */

const FORMAT_LABELS: Record<(typeof COLUMN_FORMATS)[number], string> = {
  currency: "Currency ($1,234)",
  percent: "Percent (90%)",
  number: "Number (1.2345)",
  text: "Text",
};

export default function ColumnMenu({
  config,
  onChange,
  busy,
}: {
  config: ColumnConfig;
  onChange: (next: ColumnConfig) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  function update(i: number, patch: Partial<ColumnConfigEntry>) {
    onChange(
      config.map((c, j) => (j === i ? ({ ...c, ...patch } as ColumnConfigEntry) : c))
    );
  }

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= config.length) return;
    const next = [...config];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  }

  const shown = config.filter((c) => c.visible).length;
  const inputCls =
    "border border-neutral-300 px-1.5 py-1 text-[12px] outline-none focus:border-brand-orange";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="border-2 border-neutral-300 px-3.5 py-1.5 text-[11px] font-bold tracking-wide text-brand-70 transition-colors hover:border-brand-orange hover:text-brand-orange"
      >
        Columns ({shown})…
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[60] flex items-start justify-center overflow-auto bg-black/40 p-6 pt-20"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="w-[480px] max-w-full border border-neutral-200 bg-white p-3 shadow-2xl">
            <div className="mb-2 flex items-start justify-between gap-3">
              <p className="text-[12px] text-brand-70">
                Tick to show, arrows to reorder, and type over a heading to rename
                it. Changes are display only — they never alter a figure or who can
                see one.
              </p>
              <div className="flex shrink-0 items-center gap-2">
                {/* One click back to the order in lib/columns.ts. Worth having
                    because a stored config only ever drifts one way: fields
                    added since it was saved are appended at the far right, so
                    an old config ends up with Name adrift in the middle and
                    nine ↑ presses to fix by hand. */}
                <button
                  type="button"
                  onClick={() => {
                    if (
                      confirm(
                        "Reset every column to its default order, label and visibility?"
                      )
                    ) {
                      onChange(DEFAULT_COLUMNS.map((c) => ({ ...c })));
                    }
                  }}
                  className="border border-neutral-300 px-2.5 py-1 text-[11px] font-semibold text-brand-70 transition-colors hover:border-brand-orange hover:text-brand-orange"
                >
                  Reset to default
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="border border-neutral-300 px-2.5 py-1 text-[11px] font-semibold text-brand-70 transition-colors hover:border-brand-orange hover:text-brand-orange"
                >
                  Close
                </button>
              </div>
            </div>
            <table className="w-full border-collapse text-[12px]">
              <tbody>
                {config.map((c, i) => (
                  <tr key={c.field} className="border-b border-neutral-100 last:border-0">
                    <td className="py-1 pr-1">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-brand-orange"
                        checked={c.visible}
                        disabled={busy}
                        onChange={(e) => update(i, { visible: e.target.checked })}
                        aria-label={`Show ${c.label}`}
                      />
                    </td>
                    <td className="py-1 pr-1">
                      <input
                        type="text"
                        value={c.label}
                        maxLength={40}
                        disabled={busy}
                        onChange={(e) => update(i, { label: e.target.value })}
                        className={`${inputCls} w-[120px]`}
                      />
                    </td>
                    <td className="py-1 pr-1 text-neutral-400">
                      {c.field}
                    </td>
                    <td className="py-1 pr-1 whitespace-nowrap">
                      <button
                        type="button"
                        disabled={busy || i === 0}
                        onClick={() => move(i, -1)}
                        className="border border-neutral-300 px-1.5 disabled:opacity-30"
                        aria-label={`Move ${c.label} up`}
                      >
                        ↑
                      </button>{""}
                      <button
                        type="button"
                        disabled={busy || i === config.length - 1}
                        onClick={() => move(i, 1)}
                        className="border border-neutral-300 px-1.5 disabled:opacity-30"
                        aria-label={`Move ${c.label} down`}
                      >
                        ↓
                      </button>
                    </td>
                    <td className="py-1">
                      {isIdentityField(c.field) ? (
                        <span className="text-neutral-400">text</span>
                      ) : (
                        <>
                          <select
                            value={c.format}
                            disabled={busy}
                            onChange={(e) =>
                              update(i, {
                                format: e.target.value as ColumnConfigEntry["format"],
                              })
                            }
                            className={`${inputCls} w-[125px]`}
                          >
                            {COLUMN_FORMATS.filter((f) => f !== "text").map((f) => (
                              <option key={f} value={f}>
                                {FORMAT_LABELS[f]}
                              </option>
                            ))}
                          </select>{""}
                          <input
                            type="number"
                            min={0}
                            max={6}
                            value={c.decimals}
                            disabled={busy}
                            onChange={(e) =>
                              update(i, { decimals: Number(e.target.value) || 0 })
                            }
                            className={`${inputCls} w-[48px]`}
                            aria-label={`${c.label} decimal places`}
                          />
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
