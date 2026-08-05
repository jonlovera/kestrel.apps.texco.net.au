"use client";

import Link from "next/link";
import { useState } from "react";
import type { Employee } from "@/lib/schema";
import { fmt } from "@/lib/fmt";
import { TexcoX, TexcoWordmark } from "./TexcoBrand";

interface Preview {
  rowCount: number;
  added: string[];
  removed: string[];
  removedWithData: string[];
  totalBefore: number;
  totalAfter: number;
}

type Stage =
  | { step: "pick" }
  | { step: "errors"; errors: string[] }
  | { step: "preview"; preview: Preview; rows: Employee[]; confirm: boolean }
  | { step: "done"; preview: Preview };

export default function ImportPanel() {
  const [stage, setStage] = useState<Stage>({ step: "pick" });
  const [busy, setBusy] = useState(false);
  const [fatal, setFatal] = useState("");

  async function check(file: File) {
    setBusy(true);
    setFatal("");
    try {
      const fd = new FormData();
      fd.set("file", file);
      const res = await fetch("/api/import", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) {
        setStage({ step: "errors", errors: data.errors ?? [data.error ?? "Upload failed"] });
      } else {
        setStage({ step: "preview", preview: data.preview, rows: data.rows, confirm: false });
      }
    } catch {
      setFatal("Upload failed — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (stage.step !== "preview") return;
    setBusy(true);
    setFatal("");
    try {
      const res = await fetch("/api/import/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: stage.rows,
          confirmRemovals: stage.confirm,
          totalAfter: stage.preview.totalAfter,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFatal(data.error ?? "Import failed");
      } else {
        setStage({ step: "done", preview: stage.preview });
      }
    } catch {
      setFatal("Import failed — nothing was changed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const needsConfirm =
    stage.step === "preview" && stage.preview.removedWithData.length > 0;

  return (
    <div className="flex min-h-screen flex-col">
      <div className="sticky top-0 z-40 flex items-center justify-between bg-[#191919] px-6 py-3">
        <div className="flex items-center">
          <TexcoX className="mr-2.5 h-[22px] w-[22px] shrink-0" />
          <TexcoWordmark className="mr-4 h-[18px] w-auto shrink-0" />
          <span className="hidden text-xs font-medium uppercase tracking-[2px] text-[#FC4D0F] sm:inline">
            Import data
          </span>
        </div>
        <Link
          href="/"
          className="rounded border border-[#FC4D0F]/50 px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#F79470] transition-colors hover:bg-[#FC4D0F] hover:text-white"
        >
          Back to dashboard
        </Link>
      </div>

      <div className="mx-auto w-full max-w-[900px] flex-1 px-5 py-6">
        <h1 className="mb-1 text-lg font-bold">Import employee data</h1>
        <p className="mb-4 text-[13px] text-[#5C5C5C]">
          Upload the spreadsheet (.xlsx or .csv, one row per employee, headers
          in the first row). Nothing changes until you review the preview and
          apply. Manager-entered IPMs, discretionary adjustments and locks are
          kept; a snapshot is taken automatically so an import can be undone.
        </p>

        {fatal && (
          <div className="mb-4 rounded-md border-2 border-[#FC4D0F] bg-[#FED9CC] px-4 py-2 text-[13px] font-semibold">
            {fatal}
          </div>
        )}

        {(stage.step === "pick" || stage.step === "errors") && (
          <div className="mb-5 rounded-lg border-t-4 border-[#FC4D0F] bg-white p-5 shadow-sm">
            <input
              type="file"
              accept=".xlsx,.xlsm,.csv"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) check(f);
              }}
              className="block text-[13px] file:mr-4 file:rounded-md file:border-0 file:bg-[#FC4D0F] file:px-4 file:py-2 file:text-[12px] file:font-bold file:uppercase file:tracking-wide file:text-white hover:file:bg-[#e0440d]"
            />
            {busy && <p className="mt-3 text-[13px] text-[#5C5C5C]">Checking the file…</p>}
            <p className="mt-3 text-[12px] text-neutral-400">
              Expected columns: ID, Surname, Given name, Position, Department,
              Manager, Category, State, VIC %, NSW %, Package, Bonus %, IPM %,
              After IPM, Disc adj, FY25 bonus, Site manager.
            </p>
          </div>
        )}

        {stage.step === "errors" && (
          <div className="mb-5 rounded-lg bg-white p-5 shadow-sm">
            <h2 className="mb-2 text-[13px] font-bold uppercase tracking-[1.5px] text-[#FC4D0F]">
              The file can&apos;t be imported — nothing was changed
            </h2>
            <ul className="list-inside list-disc text-[13px] leading-6">
              {stage.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        )}

        {stage.step === "preview" && (
          <div className="mb-5 rounded-lg bg-white p-5 shadow-sm">
            <h2 className="mb-3 text-[13px] font-bold uppercase tracking-[1.5px]">
              Preview — nothing has been changed yet
            </h2>
            <div className="mb-3 grid grid-cols-1 gap-2 text-[13px] sm:grid-cols-2">
              <div>Rows in file: <strong>{stage.preview.rowCount}</strong></div>
              <div>
                Total pool:{" "}
                <strong>
                  {fmt(stage.preview.totalBefore)} → {fmt(stage.preview.totalAfter)}
                </strong>{" "}
                <span className="text-[#5C5C5C]">(reconcile against your spreadsheet)</span>
              </div>
              <div>
                Added ({stage.preview.added.length}):{" "}
                <span className="text-[#5C5C5C]">
                  {stage.preview.added.join(", ") || "none"}
                </span>
              </div>
              <div>
                Removed ({stage.preview.removed.length}):{" "}
                <span className="text-[#5C5C5C]">
                  {stage.preview.removed.join(", ") || "none"}
                </span>
              </div>
            </div>

            {needsConfirm && (
              <div className="mb-3 rounded-md border-2 border-[#FC4D0F] bg-[#FED9CC] p-3 text-[13px]">
                <strong>
                  These employees have manager-entered figures that will be
                  deleted with them:
                </strong>{" "}
                {stage.preview.removedWithData.join(", ")}
                <label className="mt-2 flex items-center gap-2 font-semibold">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[#FC4D0F]"
                    checked={stage.confirm}
                    onChange={(e) =>
                      setStage({ ...stage, confirm: e.target.checked })
                    }
                  />
                  Yes, remove them and their entered figures
                </label>
              </div>
            )}

            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={busy || (needsConfirm && !stage.confirm)}
                onClick={apply}
                className="rounded-md bg-[#FC4D0F] px-6 py-2.5 text-[12px] font-bold uppercase tracking-[2px] text-white transition-colors hover:bg-[#e0440d] disabled:opacity-50"
              >
                {busy ? "Importing…" : "Apply import"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setStage({ step: "pick" })}
                className="rounded-md bg-neutral-200 px-6 py-2.5 text-[12px] font-bold uppercase tracking-[2px] text-neutral-600 hover:bg-neutral-300"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {stage.step === "done" && (
          <div className="mb-5 rounded-lg border-t-4 border-[#FC4D0F] bg-white p-5 shadow-sm">
            <h2 className="mb-2 text-[13px] font-bold uppercase tracking-[1.5px]">
              Import applied
            </h2>
            <p className="text-[13px]">
              {stage.preview.rowCount} employees imported
              ({stage.preview.added.length} added, {stage.preview.removed.length}{" "}
              removed). Total pool: {fmt(stage.preview.totalAfter)}.{" "}
              <Link href="/" className="font-semibold text-[#FC4D0F] underline">
                Open the dashboard
              </Link>{" "}
              or{" "}
              <Link href="/admin/snapshots" className="font-semibold text-[#FC4D0F] underline">
                view snapshots
              </Link>{" "}
              if it needs to be undone.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
