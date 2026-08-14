"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Employee } from "@/lib/schema";
import { fmt } from "@/lib/fmt";

/**
 * The check → preview → apply state machine, shared by /admin/import and the
 * dashboard's drop-anywhere modal. Nothing is written until the user has seen
 * the preview and pressed Apply; /api/import only parses and reports.
 */

export interface Preview {
  rowCount: number;
  added: string[];
  removed: string[];
  removedWithData: string[];
  totalBefore: number;
  totalAfter: number;
  /** in the file, but on the permanent exclude list — named so it's obvious */
  excludedInFile: string[];
  /** will import with a frozen bonus, from the sheet's own Locked Amount column */
  lockedInFile: string[];
}

export type Stage =
  | { step: "pick" }
  | { step: "checking" }
  | { step: "errors"; errors: string[] }
  | {
      step: "preview";
      preview: Preview;
      rows: Employee[];
      lockedAmounts: Record<string, number>;
      confirm: boolean;
    }
  | { step: "done"; preview: Preview };

export function useImportFlow(onApplied?: () => void) {
  const [stage, setStage] = useState<Stage>({ step: "pick" });
  const [busy, setBusy] = useState(false);
  const [fatal, setFatal] = useState("");
  // guards a late response from an earlier file overwriting a newer one
  const runId = useRef(0);
  // apply() needs the current stage without depending on it (and so being
  // recreated whenever the confirm checkbox moves), so every transition goes
  // through commit(), which keeps the ref and the state in step
  const stageRef = useRef(stage);
  const commit = useCallback((next: Stage) => {
    stageRef.current = next;
    setStage(next);
  }, []);

  const check = useCallback(async (file: File) => {
    const id = ++runId.current;
    setBusy(true);
    setFatal("");
    commit({ step: "checking" });
    try {
      const fd = new FormData();
      fd.set("file", file);
      const res = await fetch("/api/import", { method: "POST", body: fd });
      const data = await res.json();
      if (id !== runId.current) return;
      if (!res.ok) {
        commit({
          step: "errors",
          errors: data.errors ?? [data.error ?? "Upload failed"],
        });
      } else {
        commit({
          step: "preview",
          preview: data.preview,
          rows: data.rows,
          lockedAmounts: data.lockedAmounts ?? {},
          confirm: false,
        });
      }
    } catch {
      if (id !== runId.current) return;
      setFatal("Upload failed — check your connection and try again.");
      commit({ step: "pick" });
    } finally {
      if (id === runId.current) setBusy(false);
    }
  }, [commit]);

  const apply = useCallback(async () => {
    const snapshot = stageRef.current;
    if (snapshot.step !== "preview") return;
    setBusy(true);
    setFatal("");
    try {
      const res = await fetch("/api/import/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: snapshot.rows,
          confirmRemovals: snapshot.confirm,
          totalAfter: snapshot.preview.totalAfter,
          lockedAmounts: snapshot.lockedAmounts,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFatal(data.error ?? "Import failed");
        return;
      }
      commit({ step: "done", preview: snapshot.preview });
      onApplied?.();
    } catch {
      setFatal("Import failed — nothing was changed. Try again.");
    } finally {
      setBusy(false);
    }
  }, [commit, onApplied]);

  const reset = useCallback(() => {
    runId.current += 1;
    commit({ step: "pick" });
    setFatal("");
  }, [commit]);

  const setConfirm = useCallback(
    (confirm: boolean) => {
      const s = stageRef.current;
      if (s.step === "preview") commit({ ...s, confirm });
    },
    [commit]
  );

  return { stage, busy, fatal, check, apply, reset, setConfirm };
}

/** The expected spreadsheet layout — shown wherever a file can be dropped. */
export function ExpectedColumns() {
  return (
    <div className="mt-3 text-[12px] text-neutral-400">
      <p>
        <strong className="font-semibold">The EBS model workbook</strong> is
        read as it is — its VIC, NSW and Shared sheets for the latest financial
        year are found automatically, so there is nothing to rearrange first.
      </p>
      <p className="mt-1.5">
        A plain one-row-per-employee file works too, with these columns: ID,
        Surname, Given name, Position, Department, Manager, Category, State, VIC
        %, NSW %, Package, Bonus %, IPM %, After IPM, Disc adj, FY25 bonus, Site
        manager. An optional Eligibility % column is picked up if it&apos;s there.
      </p>
    </div>
  );
}

export function ImportErrors({ errors }: { errors: string[] }) {
  return (
    <div className="bg-white p-5 shadow-sm">
      <h2 className="mb-2 text-[13px] font-bold text-error">
        The file can&apos;t be imported — nothing was changed
      </h2>
      <ul className="list-inside list-disc text-[13px] leading-6">
        {errors.map((e, i) => (
          <li key={i}>{e}</li>
        ))}
      </ul>
    </div>
  );
}

export function ImportPreview({
  preview,
  confirm,
  setConfirm,
  busy,
  onApply,
  onCancel,
}: {
  preview: Preview;
  confirm: boolean;
  setConfirm: (v: boolean) => void;
  busy: boolean;
  onApply: () => void;
  onCancel: () => void;
}) {
  const needsConfirm = preview.removedWithData.length > 0;
  return (
    <div className="bg-white p-5 shadow-sm">
      <h2 className="mb-3 text-[13px] font-bold">
        Preview — nothing has been changed yet
      </h2>
      <div className="mb-3 grid grid-cols-1 gap-2 text-[13px] sm:grid-cols-2">
        <div>
          Rows in file: <strong>{preview.rowCount}</strong>
        </div>
        <div>
          Total pool:{""}
          <strong>
            {fmt(preview.totalBefore)} → {fmt(preview.totalAfter)}
          </strong>{""}
          <span className="text-brand-70">(reconcile against your spreadsheet)</span>
        </div>
        <div>
          Added ({preview.added.length}):{""}
          <span className="text-brand-70">{preview.added.join(", ") || "none"}</span>
        </div>
        <div>
          Removed ({preview.removed.length}):{""}
          <span className="text-brand-70">{preview.removed.join(", ") || "none"}</span>
        </div>
      </div>

      {preview.excludedInFile.length > 0 && (
        <div className="mb-3 border-2 border-neutral-200 bg-surface-sunken p-3 text-[13px]">
          <strong>
            {preview.excludedInFile.length} permanently excluded
            {preview.excludedInFile.length === 1 ? " person is" : " people are"} still in
            this file and will not be imported:
          </strong>{" "}
          <span className="text-brand-70">{preview.excludedInFile.join(", ")}</span>
        </div>
      )}

      {preview.lockedInFile.length > 0 && (
        <div className="mb-3 border-2 border-neutral-200 bg-surface-sunken p-3 text-[13px]">
          <strong>
            {preview.lockedInFile.length} employee
            {preview.lockedInFile.length === 1 ? "" : "s"} will import with a bonus
            frozen at the spreadsheet&apos;s own figure (its Locked Amount column):
          </strong>{" "}
          <span className="text-brand-70">{preview.lockedInFile.join(", ")}</span>
        </div>
      )}

      {needsConfirm && (
        <div className="mb-3 border-2 border-error bg-error-tint p-3 text-[13px]">
          <strong>
            These employees have manager-entered figures that will be deleted
            with them:
          </strong>{""}
          {preview.removedWithData.join(", ")}
          <label className="mt-2 flex items-center gap-2 font-semibold">
            <input
              type="checkbox"
              className="h-4 w-4 accent-brand-orange"
              checked={confirm}
              onChange={(e) => setConfirm(e.target.checked)}
            />
            Yes, remove them and their entered figures
          </label>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={busy || (needsConfirm && !confirm)}
          onClick={onApply}
          className="bg-brand-orange px-6 py-2.5 text-[12px] font-bold text-white transition-colors hover:bg-brand-orange-hover disabled:opacity-50"
        >
          {busy ? "Importing…" : "Apply import"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="bg-neutral-200 px-6 py-2.5 text-[12px] font-bold text-neutral-600 hover:bg-neutral-300"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Close-on-Escape modal wrapper used by the dashboard. */
export function ImportModal({
  onClose,
  closable,
  children,
}: {
  onClose: () => void;
  closable: boolean;
  children: React.ReactNode;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && closable) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, closable]);

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center overflow-auto bg-black/40 p-6">
      <div className="w-full max-w-[720px]" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
