"use client";

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
export default function ImportPanel() {
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
          .xlsx or .csv, one row per employee, headers in the first row. Nothing
          changes until you review the preview and apply. Manager-entered IPMs,
          discretionary adjustments and locks are kept; a snapshot is taken
          automatically so an import can be undone.
        </p>

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
