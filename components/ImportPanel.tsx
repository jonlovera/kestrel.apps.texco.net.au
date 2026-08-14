"use client";

import { useState } from "react";
import Link from "next/link";
import { fmt } from "@/lib/fmt";
import Dropzone from "./Dropzone";
import {
  useImportFlow,
  ExpectedColumns,
  ImportErrors,
  ImportPreview,
} from "./ImportFlow";

/**
 * /admin/import — the same check → preview → apply flow the dashboard runs in
 * a modal (components/ImportFlow.tsx), with a drop target and a file picker.
 */
/**
 * The permanent exclude list (lib/schema.ts's excludedIds, set from the
 * dashboard table's ✕ action) — shown here because this is the screen that
 * already explains what an import will and won't bring in, and excluding
 * someone is exactly a standing exception to "the spreadsheet is the truth".
 * Un-excluding only stops future drops; it can't restore the row itself,
 * since by the time this list is visible the row is long gone from `emp`.
 */
function ExcludedPanel({
  initial,
  datasetVersion,
}: {
  initial: { id: string; name: string }[];
  datasetVersion: number;
}) {
  const [list, setList] = useState(initial);
  const [version, setVersion] = useState(datasetVersion);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  if (list.length === 0) return null;

  async function unexclude(id: string, name: string) {
    if (
      !confirm(
        `Stop permanently excluding ${name}?\n\nThis doesn't bring their row back by itself — only a later import that still lists them will.`
      )
    )
      return;
    setBusyId(id);
    setError("");
    try {
      const res = await fetch("/api/dataset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version, patch: { op: "unexclude", id } }),
      });
      if (res.status === 409) {
        alert(
          "Someone else changed the employee data since this page loaded. Reloading to pick up the latest."
        );
        window.location.reload();
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? "That change could not be saved.");
        return;
      }
      setVersion(body.version);
      setList((prev) => prev.filter((e) => e.id !== id));
    } catch {
      setError("That change could not be saved — check your connection.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mb-5 border-t-4 border-neutral-300 bg-white p-5 shadow-sm">
      <h2 className="mb-1 text-[13px] font-bold">Permanently excluded</h2>
      <p className="mb-3 text-[13px] text-brand-70">
        Dropped from every import, even if the spreadsheet still lists them.
        Un-excluding stops that going forward — it doesn&apos;t restore their
        row on its own; a later import that still has them will.
      </p>
      <ul className="divide-y divide-neutral-100">
        {list.map((e) => (
          <li key={e.id} className="flex items-center justify-between py-2 text-[13px]">
            <span>{e.name}</span>
            <button
              type="button"
              disabled={busyId === e.id}
              onClick={() => unexclude(e.id, e.name)}
              className="bg-neutral-200 px-3 py-1.5 text-[12px] font-bold text-neutral-600 hover:bg-neutral-300 disabled:opacity-50"
            >
              {busyId === e.id ? "Removing…" : "Un-exclude"}
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-[13px] text-error">{error}</p>}
    </div>
  );
}

export default function ImportPanel({
  excluded,
  datasetVersion,
}: {
  excluded: { id: string; name: string }[];
  datasetVersion: number;
}) {
  const { stage, busy, fatal, check, apply, reset, setConfirm } = useImportFlow();

  return (
    <div>
      <Dropzone
        onFile={check}
        disabled={busy || stage.step === "preview"}
        label="Drop the spreadsheet to check it"
      />

      <div className="mx-auto w-full max-w-[900px] flex-1 px-5 py-6">
        <h1 className="mb-1 text-lg font-bold">Import employee data</h1>
        <p className="mb-4 text-[13px] text-brand-70">
          Drop the spreadsheet anywhere on this page (or choose a file below) —
          the EBS model workbook as it comes, or a plain .xlsx or .csv with one
          row per employee. Nothing changes until you review the preview and
          apply. Manager-entered IPMs, discretionary adjustments and locks are
          kept; a snapshot is taken automatically so an import can be undone.
        </p>

        <ExcludedPanel initial={excluded} datasetVersion={datasetVersion} />

        {fatal && (
          <div className="mb-4 border-2 border-error bg-error-tint px-4 py-2 text-[13px] font-semibold">
            {fatal}
          </div>
        )}

        {(stage.step === "pick" ||
          stage.step === "checking" ||
          stage.step === "errors") && (
          <div className="mb-5 border-t-4 border-brand-orange bg-white p-5 shadow-sm">
            <input
              type="file"
              accept=".xlsx,.xlsm,.csv"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) check(f);
              }}
              className="block text-[13px] file:mr-4 file:border-0 file:bg-brand-orange file:px-4 file:py-2 file:text-[12px] file:font-bold file:tracking-wide file:text-white hover:file:bg-brand-orange-hover"
            />
            {stage.step === "checking" && (
              <p className="mt-3 text-[13px] text-brand-70">Checking the file…</p>
            )}
            <ExpectedColumns />
          </div>
        )}

        {stage.step === "errors" && (
          <div className="mb-5">
            <ImportErrors errors={stage.errors} />
          </div>
        )}

        {stage.step === "preview" && (
          <div className="mb-5">
            <ImportPreview
              preview={stage.preview}
              confirm={stage.confirm}
              setConfirm={setConfirm}
              busy={busy}
              onApply={apply}
              onCancel={reset}
            />
          </div>
        )}

        {stage.step === "done" && (
          <div className="mb-5 border-t-4 border-brand-orange bg-white p-5 shadow-sm">
            <h2 className="mb-2 text-[13px] font-bold">
              Import applied
            </h2>
            <p className="text-[13px]">
              {stage.preview.rowCount} employees imported
              ({stage.preview.added.length} added, {stage.preview.removed.length}{""}
              removed). Total pool: {fmt(stage.preview.totalAfter)}.{""}
              <Link href="/" className="font-semibold text-brand-orange underline">
                Open the dashboard
              </Link>{""}
              or{""}
              <Link href="/admin/snapshots" className="font-semibold text-brand-orange underline">
                view snapshots
              </Link>{""}
              if it needs to be undone.
            </p>
            <button
              type="button"
              onClick={reset}
              className="mt-3 bg-neutral-200 px-4 py-2 text-[12px] font-bold tracking-wide text-neutral-600 hover:bg-neutral-300"
            >
              Import another
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
