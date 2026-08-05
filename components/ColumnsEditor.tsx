"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { ColumnConfig, ColumnConfigEntry } from "@/lib/columns";
import { TexcoX, TexcoWordmark } from "./TexcoBrand";

const FORMAT_LABELS = {
  currency: "Currency ($1,234)",
  percent: "Percent (90%)",
  number: "Number (1.2345)",
} as const;

export default function ColumnsEditor({
  initialConfig,
  saveAction,
}: {
  initialConfig: ColumnConfig;
  saveAction: (formData: FormData) => Promise<void>;
}) {
  const [config, setConfig] = useState<ColumnConfig>(initialConfig);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  function update(i: number, patch: Partial<ColumnConfigEntry>) {
    setSaved(false);
    setConfig((prev) =>
      prev.map((c, j) => (j === i ? ({ ...c, ...patch } as ColumnConfigEntry) : c))
    );
  }

  function move(i: number, dir: -1 | 1) {
    setSaved(false);
    setConfig((prev) => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  function submit() {
    const fd = new FormData();
    fd.set("config", JSON.stringify(config));
    startTransition(async () => {
      await saveAction(fd);
      setSaved(true);
    });
  }

  const inputCls =
    "rounded-md border-2 border-neutral-200 px-2 py-1.5 text-[13px] outline-none focus:border-[#FC4D0F]";

  return (
    <div className="flex min-h-screen flex-col">
      <div className="sticky top-0 z-40 flex items-center justify-between bg-[#191919] px-6 py-3">
        <div className="flex items-center">
          <TexcoX className="mr-2.5 h-[22px] w-[22px] shrink-0" />
          <TexcoWordmark className="mr-4 h-[18px] w-auto shrink-0" />
          <span className="hidden text-xs font-medium uppercase tracking-[2px] text-[#FC4D0F] sm:inline">
            Columns
          </span>
        </div>
        <Link
          href="/"
          className="rounded border border-[#FC4D0F]/50 px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#F79470] transition-colors hover:bg-[#FC4D0F] hover:text-white"
        >
          Back to dashboard
        </Link>
      </div>

      <div className="mx-auto w-full max-w-[1100px] flex-1 px-5 py-6">
        <h1 className="mb-1 text-lg font-bold">Table columns</h1>
        <p className="mb-4 text-[13px] text-[#5C5C5C]">
          Controls how the dashboard table is presented: which columns show,
          what they&apos;re called, their order and number format. This
          changes the display only — it never changes who is allowed to see
          which figures, and it has no effect on any calculation.
          &ldquo;Scale factor&rdquo; controls the multiplier shown on the
          pool cards.
        </p>

        <div className="mb-4 overflow-x-auto rounded-lg shadow-sm">
          <table className="w-full border-collapse bg-white text-[13px]">
            <thead>
              <tr>
                {["Show", "Label", "Field", "Order", "Format", "Decimals"].map((h) => (
                  <th
                    key={h}
                    className="whitespace-nowrap bg-[#191919] px-3 py-2.5 text-left text-[11px] uppercase tracking-wide text-white"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {config.map((c, i) => (
                <tr key={c.field} className="border-b border-neutral-100 hover:bg-neutral-50">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[#FC4D0F]"
                      checked={c.visible}
                      onChange={(e) => update(i, { visible: e.target.checked })}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="text"
                      value={c.label}
                      maxLength={40}
                      onChange={(e) => update(i, { label: e.target.value })}
                      className={`${inputCls} w-[180px]`}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <span className="rounded bg-neutral-200 px-1.5 py-0.5 font-mono text-[11px] text-neutral-600">
                      {c.field}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <button
                      type="button"
                      onClick={() => move(i, -1)}
                      disabled={i === 0}
                      className="rounded border border-neutral-300 px-2 py-0.5 text-[12px] disabled:opacity-30"
                    >
                      ↑
                    </button>{" "}
                    <button
                      type="button"
                      onClick={() => move(i, 1)}
                      disabled={i === config.length - 1}
                      className="rounded border border-neutral-300 px-2 py-0.5 text-[12px] disabled:opacity-30"
                    >
                      ↓
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    <select
                      value={c.format}
                      onChange={(e) =>
                        update(i, { format: e.target.value as ColumnConfigEntry["format"] })
                      }
                      className={`${inputCls} bg-white`}
                      disabled={c.field === "scale"}
                    >
                      {Object.entries(FORMAT_LABELS).map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      min={0}
                      max={6}
                      value={c.decimals}
                      onChange={(e) =>
                        update(i, {
                          decimals: Math.max(0, Math.min(6, Math.round(Number(e.target.value) || 0))),
                        })
                      }
                      className={`${inputCls} w-[70px]`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={pending}
            onClick={submit}
            className="rounded-md bg-[#FC4D0F] px-6 py-2.5 text-[12px] font-bold uppercase tracking-[2px] text-white transition-colors hover:bg-[#e0440d] disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save"}
          </button>
          {saved && !pending && (
            <span className="text-[13px] font-semibold text-[#191919]">
              Saved — the dashboard now uses these settings.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
