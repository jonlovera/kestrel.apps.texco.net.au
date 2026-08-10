"use client";

import { useState } from "react";
import { beginViewAs, endViewAs } from "@/app/actions/view-as";

/**
 * The View as control and its banner.
 *
 * Read-only by design: while active, every route that persists refuses the
 * write (lib/api-guard.ts). The banner says so plainly, because an admin who
 * forgets which view they are in and then can't save would reasonably think
 * the tool was broken.
 *
 * The banner is deliberately not brand orange — that already means "Draft" on
 * this screen, and two different meanings in the same colour is how someone
 * misreads a figure.
 */

export interface ViewAsState {
  actor: string;
  viewingAs: string | null;
  candidates: { email: string; summary: string }[];
}

export function ViewAsBanner({ actor, viewingAs }: ViewAsState) {
  if (!viewingAs) return null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-3 bg-brand-lavender px-6 py-2 text-center text-xs font-bold text-brand-95">
      <span>
        Viewing as <strong>{viewingAs}</strong> — you are {actor}
      </span>
      <span className="font-normal">Changes are disabled in this view.</span>
      <form action={endViewAs}>
        <button
          type="submit"
          className="border border-brand-95 px-3 py-1 text-[11px] font-bold text-brand-95 transition-colors hover:bg-brand-95 hover:text-white"
        >
          Exit
        </button>
      </form>
    </div>
  );
}

export function ViewAsPicker({ candidates }: { candidates: ViewAsState["candidates"] }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");

  if (candidates.length === 0) return null;

  const q = filter.trim().toLowerCase();
  const shown = q
    ? candidates.filter(
        (c) =>
          c.email.toLowerCase().includes(q) || c.summary.toLowerCase().includes(q)
      )
    : candidates;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="See the dashboard exactly as someone else sees it"
        className="border border-brand-orange/50 px-3.5 py-1.5 text-[11px] font-semibold tracking-wide text-brand-orange-soft transition-colors hover:bg-brand-orange hover:text-white"
      >
        View as
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-1 max-h-[60vh] w-[340px] overflow-auto border border-neutral-200 bg-white p-2 shadow-2xl">
          <input
            autoFocus
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by email or access…"
            className="mb-2 w-full border-2 border-neutral-200 px-2.5 py-1.5 text-[13px] outline-none focus:border-brand-orange"
          />
          {shown.length === 0 && (
            <p className="px-2 py-3 text-center text-[12px] text-brand-70">
              Nobody matches.
            </p>
          )}
          {shown.map((c) => (
            <form key={c.email} action={beginViewAs}>
              <input type="hidden" name="email" value={c.email} />
              <button
                type="submit"
                className="block w-full px-2 py-2 text-left text-[13px] hover:bg-neutral-50"
              >
                <span className="font-semibold text-brand-95">{c.email}</span>
                <br />
                <span className="text-[12px] text-brand-70">{c.summary}</span>
              </button>
            </form>
          ))}
        </div>
      )}
    </div>
  );
}
