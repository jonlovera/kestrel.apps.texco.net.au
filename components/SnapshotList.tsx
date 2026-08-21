"use client";

import { useState, useTransition } from "react";

interface SnapshotRow {
  ts: string;
  actor: string;
  reason: string;
  employees: number;
  edited: number;
  locked: number;
  changes: {
    headline: string;
    lines: { area: string; text: string }[];
    more: number;
  };
}

const REASON_LABELS: Record<string, string> = {
  edit: "Bonus edits",
  autosave: "Autosave",
  dataset: "Data edit",
  "access-change": "Access change",
  "pre-restore": "Before a restore",
  import: "Data import",
  params: "Parameter change",
  columns: "Column change",
  copy: "Wording change",
};

export default function SnapshotList({
  snapshots,
  restoreAction,
}: {
  snapshots: SnapshotRow[];
  restoreAction: (formData: FormData) => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  const [expandedTs, setExpandedTs] = useState<string | null>(null);

  return (
    <div>
      <div className="mx-auto w-full max-w-[1100px] flex-1 px-5 py-6">
        <h1 className="mb-1 text-lg font-bold">Snapshots</h1>
        <p className="mb-4 text-[13px] text-brand-70">
          A full copy of the data, edits, parameters, column settings, wording
          and access rules is taken automatically before every change (with
          one exception: restoring a snapshot from before access rules were
          included leaves today&apos;s access untouched, and the restoring
          admin always keeps their own access either way). &quot;What
          changed&quot; shows what that person&apos;s action changed;
          restoring a row puts everything back to just before it, and takes
          its own snapshot first, so a restore can itself be undone. The most
          recent 50 are kept; download any of them to keep a copy off the
          platform.
        </p>

        <div className="overflow-x-auto shadow-sm">
          <table className="w-full border-collapse bg-white text-[13px]">
            <thead>
              <tr>
                {["When", "Who", "Why", "What changed", "Contents", "", ""].map((h, i) => (
                  <th
                    key={i}
                    className="whitespace-nowrap bg-brand-95 px-3 py-2.5 text-left text-[11px] tracking-wide text-white"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {snapshots.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-brand-70">
                    No snapshots yet — one is taken before every change.
                  </td>
                </tr>
              )}
              {snapshots.map((s) => {
                const expanded = expandedTs === s.ts;
                const hasDetail = s.changes.lines.length > 0;
                return [
                  <tr
                    key={s.ts}
                    className="border-b border-neutral-100 hover:bg-neutral-50"
                  >
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                      {new Date(s.ts).toLocaleString("en-AU", {
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{s.actor}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {REASON_LABELS[s.reason] ?? s.reason}
                    </td>
                    <td className="px-3 py-2">
                      {hasDetail ? (
                        <button
                          type="button"
                          aria-expanded={expanded}
                          onClick={() => setExpandedTs(expanded ? null : s.ts)}
                          className="text-left text-brand-70 transition-colors hover:text-brand-orange"
                          title={expanded ? "Hide the detail" : "Show each change"}
                        >
                          <span className="mr-1 inline-block w-3 text-[10px]">
                            {expanded ? "▾" : "▸"}
                          </span>
                          {s.changes.headline}
                        </button>
                      ) : (
                        <span className="text-brand-70">
                          {s.changes.headline || "No changes recorded"}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-brand-70">
                      {s.employees} employees
                      {s.edited > 0 && <> · {s.edited} edited</>}
                      {s.locked > 0 && <> · {s.locked} locked</>}
                    </td>
                    <td className="px-3 py-2">
                      <a
                        href={`/api/export?ts=${encodeURIComponent(s.ts)}`}
                        title="Download this version as an Excel workbook"
                        className="border border-neutral-300 px-3 py-1 text-[11px] font-semibold text-brand-70 transition-colors hover:border-brand-orange hover:text-brand-orange"
                      >
                        Excel
                      </a>
                    </td>
                    <td className="px-3 py-2">
                      <form
                        action={(fd) => {
                          if (
                            !confirm(
                              `Restore everything to ${new Date(s.ts).toLocaleString("en-AU")}?\n\nAll data, edits and settings will be put back exactly as they were then. A snapshot of the current state is taken first, so this can be undone.`
                            )
                          )
                            return;
                          startTransition(() => restoreAction(fd));
                        }}
                      >
                        <input type="hidden" name="ts" value={s.ts} />
                        <button
                          type="submit"
                          disabled={pending}
                          className="bg-brand-orange px-3 py-1 text-[11px] font-bold text-white transition-colors hover:bg-brand-orange-hover disabled:opacity-50"
                        >
                          {pending ? "Restoring…" : "Restore"}
                        </button>
                      </form>
                    </td>
                  </tr>,
                  expanded && (
                    <tr key={`${s.ts}-detail`} className="border-b border-neutral-100 bg-neutral-50">
                      <td colSpan={7} className="px-3 py-2">
                        <ul className="ml-7 list-disc space-y-0.5 py-1 text-[12px] text-brand-70">
                          {s.changes.lines.map((l, i) => (
                            <li key={i}>{l.text}</li>
                          ))}
                          {s.changes.more > 0 && (
                            <li className="list-none italic">
                              …and {s.changes.more} more change
                              {s.changes.more === 1 ? "" : "s"} — restore or
                              download the snapshot for the full picture
                            </li>
                          )}
                        </ul>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
