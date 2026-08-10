"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Window-level drag target: drop a spreadsheet anywhere on the page.
 *
 * Renders nothing of its own except the overlay shown while a file is being
 * dragged — it does not wrap or lay out its children, so it can be dropped
 * into any page without affecting it.
 *
 * `dragenter`/`dragleave` fire for every element the pointer crosses, so the
 * enters are counted rather than treated as a boolean; otherwise the overlay
 * flickers as the cursor moves between children.
 */

const EXTENSIONS = [".xlsx", ".xlsm", ".csv"];

const accepted = (file: File) =>
  EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext));

export default function Dropzone({
  onFile,
  disabled = false,
  label = "Drop the spreadsheet to update the figures",
}: {
  onFile: (file: File) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    if (disabled) return;

    // only react to an actual file drag, never to text or a dragged link
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");

    function onEnter(e: DragEvent) {
      if (!hasFiles(e)) return;
      depth.current += 1;
      setDragging(true);
    }
    function onOver(e: DragEvent) {
      if (!hasFiles(e)) return;
      e.preventDefault(); // required, or the browser opens the file itself
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    }
    function onLeave(e: DragEvent) {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    }
    function onDrop(e: DragEvent) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      if (!accepted(file)) {
        setRejected(true);
        return;
      }
      setRejected(false);
      onFile(file);
    }

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [onFile, disabled]);

  if (disabled) return null;

  if (rejected) {
    return (
      <div className="fixed inset-x-0 top-0 z-[60] flex justify-center px-4 pt-4">
        <div className="flex items-center gap-4 border-2 border-error bg-error-tint px-4 py-2.5 text-[13px] font-semibold shadow-lg">
          That file type can&apos;t be imported — use .xlsx, .xlsm or .csv.
          <button
            type="button"
            onClick={() => setRejected(false)}
            className="text-[11px] tracking-wide underline"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  if (!dragging) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center bg-brand-95/70 p-8">
      <div className="border-4 border-dashed border-brand-orange bg-white px-12 py-10 text-center shadow-2xl">
        <p className="text-[15px] font-bold text-brand-95">
          {label}
        </p>
        <p className="mt-2 text-[13px] text-brand-70">
          .xlsx, .xlsm or .csv — you&apos;ll see a preview before anything changes.
        </p>
      </div>
    </div>
  );
}
