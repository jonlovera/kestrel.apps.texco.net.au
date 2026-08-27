"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";

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
  manual: "Taken by hand",
};

const when = (ts: string) =>
  new Date(ts).toLocaleString("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

export default function SnapshotList({
  snapshots,
  page,
  pageCount,
  total,
  restoreAction,
  snapshotAction,
  restoreBackupAction,
}: {
  snapshots: SnapshotRow[];
  /** 1-based page currently shown */
  page: number;
  pageCount: number;
  /** total snapshots kept, across all pages */
  total: number;
  restoreAction: (formData: FormData) => Promise<void>;
  /** takes a snapshot on demand, so a restore point can be marked deliberately */
  snapshotAction: () => Promise<void>;
  /** validates and restores an uploaded backup file; returns why if it refused */
  restoreBackupAction: (
    formData: FormData
  ) => Promise<{ error: string } | { ok: true }>;
}) {
  const [pending, startTransition] = useTransition();
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  /**
   * Typed, not clicked. Restoring from a file rewrites every figure and every
   * access rule from something the server cannot authenticate, so it asks for
   * more deliberateness than the row-level restore's confirm() — this is the
   * one action whose only way back is the pre-restore snapshot.
   */
  const [confirmWord, setConfirmWord] = useState("");
  const CONFIRM = "RESTORE";
  const [openTs, setOpenTs] = useState<string | null>(null);
  const open = openTs ? (snapshots.find((s) => s.ts === openTs) ?? null) : null;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenTs(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

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
          its own snapshot first, so a restore can itself be undone. Every
          snapshot is kept, newest first, 25 to a page; download any of them
          to keep a copy off the platform.
        </p>

        <div className="mb-4 border border-neutral-200 bg-white p-3">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={pending}
              onClick={() => startTransition(() => void snapshotAction())}
              className="border-2 border-neutral-300 px-3.5 py-1.5 text-[11px] font-bold tracking-wide text-brand-70 transition-colors hover:border-brand-orange hover:text-brand-orange disabled:opacity-50"
            >
              Take a snapshot now
            </button>
            <a
              href="/api/backup"
              className="border-2 border-neutral-300 px-3.5 py-1.5 text-[11px] font-bold tracking-wide text-brand-70 transition-colors hover:border-brand-orange hover:text-brand-orange"
            >
              Download full backup
            </a>
            <span className="text-[12px] text-brand-70">
              A snapshot is a restore point kept here. The backup is one file
              holding everything — including every salary and the access rules —
              that survives losing the database. Treat it like the source
              spreadsheet.
            </span>
          </div>

          <details className="mt-3 border-t border-neutral-100 pt-3">
            <summary className="cursor-pointer text-[12px] font-semibold text-brand-70">
              Restore from a backup file…
            </summary>
            <form
              action={(fd) => {
                setBackupError(null);
                setBackupBusy(true);
                void restoreBackupAction(fd)
                  .then((r) => {
                    if ("error" in r) setBackupError(r.error);
                    else setConfirmWord("");
                  })
                  .finally(() => setBackupBusy(false));
              }}
              className="mt-2 flex flex-wrap items-center gap-3"
            >
              <input
                type="file"
                name="file"
                accept="application/json,.json"
                required
                className="text-[12px]"
              />
              <input
                type="text"
                value={confirmWord}
                onChange={(e) => setConfirmWord(e.target.value)}
                placeholder={`Type ${CONFIRM}`}
                aria-label={`Type ${CONFIRM} to confirm`}
                className="border border-neutral-300 px-2 py-1 text-[12px] outline-none focus:border-brand-orange"
              />
              <button
                type="submit"
                disabled={backupBusy || confirmWord !== CONFIRM}
                className="border-2 border-red-300 px-3.5 py-1.5 text-[11px] font-bold tracking-wide text-red-700 transition-colors hover:border-red-600 disabled:opacity-40"
              >
                {backupBusy ? "Restoring…" : "Restore everything from this file"}
              </button>
              <span className="w-full text-[12px] text-brand-70">
                Replaces all data, edits, parameters, columns, wording and
                access rules with the file&apos;s. A snapshot is taken first so
                this can be undone, and you keep your own access whatever the
                file says. The audit history is never overwritten.
              </span>
              {backupError && (
                <p className="w-full border border-red-300 bg-red-50 px-3 py-2 text-[12px] text-red-700">
                  {backupError}
                </p>
              )}
            </form>
          </details>
        </div>

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
              {total === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-brand-70">
                    No snapshots yet — one is taken before every change.
                  </td>
                </tr>
              )}
              {snapshots.map((s) => (
                <tr key={s.ts} className="border-b border-neutral-100 hover:bg-neutral-50">
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums">{when(s.ts)}</td>
                  <td className="whitespace-nowrap px-3 py-2">{s.actor}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {REASON_LABELS[s.reason] ?? s.reason}
                  </td>
                  <td className="px-3 py-2">
                    {s.changes.lines.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => setOpenTs(s.ts)}
                        className="text-left text-brand-70 underline decoration-neutral-300 underline-offset-2 transition-colors hover:text-brand-orange"
                        title="Show each change"
                      >
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pager. Plain links, not transitions: each page is a fresh
            server render, and a linkable ?page= URL is the point. */}
        {total > 0 && (
          <div className="mt-3 flex items-center justify-between text-[12px] text-brand-70">
            {page > 1 ? (
              <Link
                href={page === 2 ? "/admin/snapshots" : `/admin/snapshots?page=${page - 1}`}
                className="border border-neutral-300 px-3 py-1 font-semibold transition-colors hover:border-brand-orange hover:text-brand-orange"
              >
                ← Newer
              </Link>
            ) : (
              <span className="border border-neutral-200 px-3 py-1 font-semibold opacity-40">
                ← Newer
              </span>
            )}
            <span>
              Page {page} of {pageCount} · {total} snapshot{total === 1 ? "" : "s"}
            </span>
            {page < pageCount ? (
              <Link
                href={`/admin/snapshots?page=${page + 1}`}
                className="border border-neutral-300 px-3 py-1 font-semibold transition-colors hover:border-brand-orange hover:text-brand-orange"
              >
                Older →
              </Link>
            ) : (
              <span className="border border-neutral-200 px-3 py-1 font-semibold opacity-40">
                Older →
              </span>
            )}
          </div>
        )}
      </div>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOpenTs(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="What changed"
            className="flex max-h-[80vh] w-full max-w-[680px] flex-col bg-white shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-neutral-100 px-5 py-4">
              <div>
                <div className="text-[14px] font-bold">
                  {REASON_LABELS[open.reason] ?? open.reason} — {when(open.ts)}
                </div>
                <div className="mt-0.5 text-[12px] text-brand-70">
                  {open.actor} · {open.changes.headline}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpenTs(null)}
                aria-label="Close"
                className="px-2 text-[18px] leading-none text-brand-70 transition-colors hover:text-brand-orange"
              >
                ×
              </button>
            </div>
            <div className="overflow-y-auto px-5 py-4">
              <ul className="ml-4 list-disc space-y-1 text-[13px] text-brand-70">
                {open.changes.lines.map((l, i) => (
                  <li key={i}>{l.text}</li>
                ))}
                {open.changes.more > 0 && (
                  <li className="list-none italic">
                    …and {open.changes.more} more change
                    {open.changes.more === 1 ? "" : "s"} — restore or download
                    the snapshot for the full picture
                  </li>
                )}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
