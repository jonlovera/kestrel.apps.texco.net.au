"use client";

import { useTransition } from "react";

interface SnapshotRow {
  ts: string;
  actor: string;
  reason: string;
  employees: number;
  overrides: number;
}

const REASON_LABELS: Record<string, string> = {
  edit: "Bonus edits",
  "access-change": "Access change",
  "pre-restore": "Before a restore",
  import: "Data import",
  params: "Parameter change",
  columns: "Column change",
};

export default function SnapshotList({
  snapshots,
  restoreAction,
}: {
  snapshots: SnapshotRow[];
  restoreAction: (formData: FormData) => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <div>
      <div className="mx-auto w-full max-w-[1100px] flex-1 px-5 py-6">
        <h1 className="mb-1 text-lg font-bold">Snapshots</h1>
        <p className="mb-4 text-[13px] text-[#5C5C5C]">
          A full copy of the data, edits, parameters and column settings is
          taken automatically before every change. Restoring puts everything
          back exactly as it was — and takes its own snapshot first, so a
          restore can itself be undone. The most recent 50 are kept; download
          any of them to keep a copy off the platform.
        </p>

        <div className="overflow-x-auto rounded-lg shadow-sm">
          <table className="w-full border-collapse bg-white text-[13px]">
            <thead>
              <tr>
                {["When", "Who", "Why", "Contents", "", ""].map((h, i) => (
                  <th
                    key={i}
                    className="whitespace-nowrap bg-[#191919] px-3 py-2.5 text-left text-[11px] uppercase tracking-wide text-white"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {snapshots.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-[#5C5C5C]">
                    No snapshots yet — one is taken before every change.
                  </td>
                </tr>
              )}
              {snapshots.map((s) => (
                <tr key={s.ts} className="border-b border-neutral-100 hover:bg-neutral-50">
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
                  <td className="whitespace-nowrap px-3 py-2 text-[#5C5C5C]">
                    {s.employees} employees · {s.overrides} edited
                  </td>
                  <td className="px-3 py-2">
                    <a
                      href={`/api/snapshots/download?ts=${encodeURIComponent(s.ts)}`}
                      className="rounded border border-neutral-300 px-3 py-1 text-[11px] font-semibold uppercase text-[#5C5C5C] transition-colors hover:border-[#FC4D0F] hover:text-[#FC4D0F]"
                    >
                      Download
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
                        className="rounded bg-[#FC4D0F] px-3 py-1 text-[11px] font-bold uppercase text-white transition-colors hover:bg-[#e0440d] disabled:opacity-50"
                      >
                        {pending ? "Restoring…" : "Restore"}
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
