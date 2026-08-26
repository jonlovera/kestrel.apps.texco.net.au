"use client";

import { useCallback, useMemo, useState } from "react";
import { fmt, fmtPct } from "@/lib/fmt";
import Dropzone from "./Dropzone";
import { ImportErrors } from "./ImportFlow";
import { summarise, type PackageIncreaseDoc } from "@/lib/remuneration";

/**
 * /admin/package-increase — drop the FY27 remuneration review, see who moved.
 *
 * Deliberately simpler than /admin/import: that flow needs a preview because
 * applying it moves everybody's payout, and this changes nothing but its own
 * document. Upload replaces, and the table below is what was stored.
 *
 * The table defaults to the people who actually moved, because that is the
 * question being asked — but the unchanged rows are kept and one click away,
 * since the letter run will need their held figure just as much.
 */
export default function PackageIncreasePanel({
  initial,
}: {
  initial: PackageIncreaseDoc | null;
}) {
  const [doc, setDoc] = useState<PackageIncreaseDoc | null>(initial);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const upload = useCallback(async (file: File) => {
    setBusy(true);
    setErrors([]);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/packages", { method: "POST", body });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrors(json.errors ?? [json.error ?? "The file couldn't be read."]);
        return;
      }
      setDoc(json.doc as PackageIncreaseDoc);
      setShowAll(false);
    } catch {
      setErrors(["The file couldn't be uploaded — check your connection."]);
    } finally {
      setBusy(false);
    }
  }, []);

  const summary = useMemo(() => (doc ? summarise(doc.rows) : null), [doc]);
  const rows = useMemo(() => {
    if (!doc) return [];
    const list = showAll ? doc.rows : doc.rows.filter((r) => r.increased);
    // Largest increase first — the figures anyone reviewing this looks at
    // first. Unchanged rows sort by name so the "all" view stays readable.
    return [...list].sort(
      (a, b) => b.increase - a.increase || a.name.localeCompare(b.name)
    );
  }, [doc, showAll]);

  return (
    <div className="mx-auto w-full max-w-[1000px] flex-1 px-5 py-6">
      <h1 className="mb-1 text-lg font-bold">Package increase</h1>
      <p className="mb-4 text-[13px] text-brand-70">
        Drop the FY27 remuneration review anywhere on this page (or choose the
        file below) to record who has moved package. This is remuneration data
        only — it changes no bonus figure, no pool and no payout. Uploading
        again replaces what is held.
      </p>

      <Dropzone
        onFile={(f) => void upload(f)}
        disabled={busy}
        label="Drop the FY27 remuneration review"
      />

      <div className="mb-5 border-t-4 border-brand-orange bg-white p-5 shadow-sm">
        <input
          type="file"
          accept=".xlsx,.xlsm"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
          className="block text-[13px] file:mr-4 file:border-0 file:bg-brand-orange file:px-4 file:py-2 file:text-[12px] file:font-bold file:tracking-wide file:text-white hover:file:bg-brand-orange-hover"
        />
        {busy && <p className="mt-3 text-[13px] text-brand-70">Reading the file…</p>}
        <p className="mt-3 text-[12px] text-brand-70">
          The workbook needs a header row carrying{" "}
          <span className="font-semibold">Jobpac Employee ID</span>,{" "}
          <span className="font-semibold">Current Total Salary Package</span> and{" "}
          <span className="font-semibold">FY27 Salary Package</span>. Columns can
          be in any order.
        </p>
      </div>

      {errors.length > 0 && (
        <div className="mb-5">
          <ImportErrors errors={errors} />
        </div>
      )}

      {!doc && errors.length === 0 && (
        <div className="bg-white p-5 text-[13px] text-brand-70 shadow-sm">
          Nothing uploaded yet.
        </div>
      )}

      {doc && summary && (
        <div className="bg-white p-5 shadow-sm">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <h2 className="text-[13px] font-bold text-brand-95">
                {summary.increased} package increase
                {summary.increased === 1 ? "" : "s"} across {summary.people} people
                {" · "}
                {fmt(summary.totalIncrease)} total
              </h2>
              <p className="mt-0.5 text-[12px] text-brand-70">
                {doc.filename} · uploaded{" "}
                {new Date(doc.uploadedAt).toLocaleString("en-AU", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}{" "}
                by {doc.uploadedBy}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="bg-neutral-200 px-4 py-2 text-[12px] font-bold tracking-wide text-neutral-600 hover:bg-neutral-300"
            >
              {showAll
                ? `Show only the ${summary.increased} increases`
                : `Show all ${summary.people} people`}
            </button>
          </div>

          {summary.unmatched > 0 && (
            <p className="mb-3 border-l-2 border-neutral-300 pl-3 text-[12px] text-brand-70">
              {summary.unmatched} of these people aren&apos;t on the bonus scheme
              roster, so nothing downstream can produce a letter for them. They
              are kept here so the review reconciles against its own source.
            </p>
          )}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-[13px]">
              <thead>
                <tr className="border-b-2 border-brand-95 text-left text-[11px] uppercase tracking-wide text-brand-70">
                  <th className="py-2 pr-3 font-bold">Name</th>
                  <th className="py-2 pr-3 font-bold">Position</th>
                  <th className="py-2 pr-3 text-right font-bold">Current package</th>
                  <th className="py-2 pr-3 text-right font-bold">New package</th>
                  <th className="py-2 pr-3 text-right font-bold">Increase</th>
                  <th className="py-2 text-right font-bold">%</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-neutral-100">
                    <td className="py-1.5 pr-3">
                      {r.name}
                      {!r.inDataset && (
                        <span
                          title="Not on the bonus scheme roster"
                          className="ml-1.5 text-[10px] text-brand-70"
                        >
                          (not on scheme)
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-brand-70">{r.title ?? ""}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {fmt(r.current)}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {fmt(r.fy27)}
                    </td>
                    <td
                      className={`py-1.5 pr-3 text-right font-semibold tabular-nums ${
                        r.increased ? "text-brand-95" : "text-neutral-400"
                      }`}
                    >
                      {r.increased ? fmt(r.increase) : "—"}
                    </td>
                    <td
                      className={`py-1.5 text-right tabular-nums ${
                        r.increased ? "text-brand-95" : "text-neutral-400"
                      }`}
                    >
                      {r.increased ? fmtPct(r.increasePct) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
