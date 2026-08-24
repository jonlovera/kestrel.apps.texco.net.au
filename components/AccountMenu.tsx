"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useDismissable } from "@/lib/use-dismissable";
import { ViewAsCandidateList, type ViewAsState } from "./ViewAsBar";

/**
 * The top bar's actions, folded into one menu behind the user's own name so
 * the bar itself stays lean: Save and Show everything stay outside (they're
 * the controls pressed all day), everything else lives here. "View as" opens
 * as an accordion section inside the menu rather than a nested popover; the
 * menu's own scroll handles a long candidate list, and picking one is a
 * server action that navigates, which tears the menu down by itself.
 */
export default function AccountMenu({
  userName,
  scopeLabel,
  viewAs,
  viewingAs,
  isEditor,
  exporting,
  onExport,
}: {
  userName: string;
  scopeLabel: string;
  viewAs?: ViewAsState;
  viewingAs: string | null;
  isEditor: boolean;
  exporting: boolean;
  onExport: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [viewAsOpen, setViewAsOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useDismissable(wrapRef, open, () => setOpen(false));

  const itemCls =
    "block w-full px-3 py-2 text-left text-[13px] text-brand-95 transition-colors hover:bg-neutral-50 disabled:opacity-40";
  const canViewAs = !!viewAs && !viewingAs && viewAs.candidates.length > 0;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          setViewAsOpen(false);
        }}
        title="Account and actions"
        className={`flex items-center gap-2 border px-3 py-1 text-right text-xs leading-tight text-brand-orange-soft transition-colors hover:border-brand-orange/50 ${
          open ? "border-brand-orange/50" : "border-transparent"
        }`}
      >
        <span>
          {userName}
          <br />
          <span className="text-[10px] opacity-80">{scopeLabel}</span>
        </span>
        <span className="text-[9px]" aria-hidden="true">
          {open ? "▴" : "▾"}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-1 max-h-[80vh] w-[300px] overflow-y-auto border border-neutral-200 bg-white py-1 shadow-2xl">
          {canViewAs && (
            <>
              <button
                type="button"
                onClick={() => setViewAsOpen((o) => !o)}
                title="See the dashboard exactly as someone else sees it"
                className={itemCls}
              >
                View as… <span className="text-[9px]">{viewAsOpen ? "▴" : "▾"}</span>
              </button>
              {viewAsOpen && viewAs && (
                <ViewAsCandidateList candidates={viewAs.candidates} />
              )}
            </>
          )}

          {isEditor && !viewingAs && (
            <button
              type="button"
              onClick={() => {
                onExport();
                setOpen(false);
              }}
              disabled={exporting}
              title="Download the current figures as an Excel workbook, for the HR folder. Unsaved changes are saved first."
              className={itemCls}
            >
              {exporting ? "Exporting…" : "Export"}
            </button>
          )}

          {isEditor && !viewingAs && (
            <Link href="/admin" className={itemCls}>
              Admin
            </Link>
          )}

          <div className="my-1 border-t border-neutral-100" />
          <a href="/logout" className={itemCls}>
            Logout
          </a>
        </div>
      )}
    </div>
  );
}
