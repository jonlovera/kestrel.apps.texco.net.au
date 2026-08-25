"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DisplayRow } from "@/lib/payload-types";

/**
 * The Letter column's split button: the square downloads Word, and the chevron
 * beside it opens a menu to pick Word or PDF.
 *
 * WHY THE MENU IS `fixed` AND MEASURED, not absolutely positioned inside the
 * cell: the table is an overflow-auto box full of sticky cells, so anything
 * absolute in a cell is clipped by the scroll container. That is the same
 * problem that pushed ColumnMenu into a modal (see its header), and there is
 * no portal anywhere in this codebase — every floating panel is a fixed
 * overlay. This follows that, anchored off the chevron's own rect.
 *
 * Which also means the menu has to close on scroll. A fixed element anchored
 * to a row that is moving underneath it detaches and hangs over the wrong
 * person's line, which on a table of salaries is worse than merely untidy.
 */
export default function LetterButton({
  row,
  why,
  pending,
  signedBy,
  onDownload,
}: {
  row: DisplayRow;
  /** why the letter is unavailable, or null when it is */
  why: string | null;
  /** this row's PDF is being rendered right now */
  pending: boolean;
  /** "Clint Cassar and Jonathan Glick", for the tooltip */
  signedBy: string;
  onDownload: (format: "docx" | "pdf") => void;
}) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const anchor = useRef<HTMLDivElement>(null);

  // Measure before paint so the menu never appears at 0,0 and jump.
  useLayoutEffect(() => {
    if (!open) return;
    const rect = anchor.current?.getBoundingClientRect();
    if (rect) setAt({ top: rect.bottom + 2, left: rect.right - 148 });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // `true` so a scroll inside the table's own box is caught, not just the
    // window's — the table is what actually scrolls here.
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const blocked = why !== null;
  const tone = blocked
    ? "cursor-help border-neutral-200 text-neutral-300"
    : "border-neutral-300 text-brand-orange hover:border-brand-orange";
  const title = why ?? `Download ${row.name}'s letter — signed by ${signedBy}`;

  return (
    <>
      <div ref={anchor} className="inline-flex items-stretch">
        <button
          type="button"
          aria-disabled={blocked}
          title={pending ? "Producing the PDF…" : title}
          onClick={() => onDownload("docx")}
          className={`inline-flex h-7 w-7 items-center justify-center border-[1.5px] bg-transparent transition-colors ${tone}`}
        >
          {pending ? (
            // A plain spinner: the PDF is rendered by LibreOffice on the
            // server, which is about a second warm and closer to ten cold.
            <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
          ) : (
            /* An SVG rather than the ⬇ character: the colour IS the state
               here, and a font free to render that codepoint as a colour emoji
               would ignore `text-`. `currentColor` cannot. */
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
              <path d="M7 1h2v7.1l2.6-2.6 1.4 1.4L8 12 3 6.9l1.4-1.4L7 8.1V1Z" />
              <path d="M3 13h10v2H3z" />
            </svg>
          )}
        </button>
        <button
          type="button"
          aria-disabled={blocked}
          aria-haspopup="menu"
          aria-expanded={open}
          title={blocked ? why : "Choose a format"}
          onClick={() => (blocked ? onDownload("docx") : setOpen((o) => !o))}
          className={`-ml-px inline-flex h-7 w-4 items-center justify-center border-[1.5px] bg-transparent transition-colors ${tone}`}
        >
          <svg viewBox="0 0 16 16" className="h-2.5 w-2.5" fill="currentColor" aria-hidden="true">
            <path d="M2 5h12L8 12 2 5Z" />
          </svg>
        </button>
      </div>

      {open && at && (
        <>
          {/* Catches the click that dismisses, so choosing a format does not
              also count as an outside click on the row underneath. */}
          <div className="fixed inset-0 z-[70]" onMouseDown={() => setOpen(false)} />
          <div
            role="menu"
            style={{ top: at.top, left: Math.max(8, at.left) }}
            className="fixed z-[71] w-[148px] border border-neutral-200 bg-white py-1 shadow-lg"
          >
            {([
              ["docx", "Word (.docx)"],
              ["pdf", "PDF"],
            ] as const).map(([format, label]) => (
              <button
                key={format}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onDownload(format);
                }}
                className="block w-full px-3 py-1.5 text-left text-[12px] text-brand-95 transition-colors hover:bg-neutral-100"
              >
                {label}
                {format === "docx" && (
                  <span className="ml-1 text-[11px] text-brand-70">default</span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}
