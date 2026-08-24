"use client";

import { useState } from "react";
import { beginViewAs, endViewAs } from "@/app/actions/view-as";

/**
 * The View as control, in two parts since the account menu absorbed the
 * trigger: `ViewAsCandidateList` (the filter + candidate list) renders inline
 * inside that menu, while `ViewAsExitButton` stays out in the top bar — an
 * active view is state the person must be able to see and leave at a glance,
 * not a command to bury one click deep.
 *
 * A view is faithful, not flattened: the target's own cells are live, so an
 * admin can see what that person can change and try a figure to see what they
 * would see. By default nothing can be persisted — every route that writes
 * refuses while a view is active (lib/api-guard.ts), and the affordances that
 * commit on blur rather than on Save are switched off in the dashboard
 * instead of being left to fail against that refusal. The one exception is
 * the per-target "can act for" delegation (lib/view-as-core.ts): for those
 * views the Save path works, within the target's own window, recorded
 * against the actor, and the button reads "Editing as" instead.
 *
 * While a view is active the exit button carries that state — styled
 * lavender rather than brand orange, since orange already means "Draft" on
 * this screen and two different meanings in the same colour is how someone
 * misreads a figure. Clicking it exits the view immediately.
 */

export interface ViewAsState {
  actor: string;
  viewingAs: string | null;
  candidates: { email: string; summary: string }[];
  /**
   * Whether the active view is one the actor may make changes in (the
   * "can act for" delegation). Always false outside a view.
   */
  canAct: boolean;
}

export function ViewAsExitButton({
  viewingAs,
  canAct,
}: {
  viewingAs: string;
  canAct: boolean;
}) {
  return (
    <form action={endViewAs}>
      <button
        type="submit"
        title={
          canAct
            ? "You can make changes in this view. Click to exit."
            : "Exit this view"
        }
        className="bg-brand-lavender px-3.5 py-1.5 text-[11px] font-bold tracking-wide text-brand-95 transition-colors hover:bg-brand-lavender/80"
      >
        {canAct ? "Editing as" : "Viewing as"} {viewingAs}
      </button>
    </form>
  );
}

/** The candidate list, rendered inline inside the account menu. Submitting a
 *  candidate is a server action that navigates, tearing the menu down with it. */
export function ViewAsCandidateList({
  candidates,
}: {
  candidates: ViewAsState["candidates"];
}) {
  const [filter, setFilter] = useState("");

  const q = filter.trim().toLowerCase();
  const shown = q
    ? candidates.filter(
        (c) =>
          c.email.toLowerCase().includes(q) || c.summary.toLowerCase().includes(q)
      )
    : candidates;

  return (
    <div className="px-2 pb-1">
      <input
        autoFocus
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter by email or access…"
        className="mb-1 w-full border-2 border-neutral-200 px-2.5 py-1.5 text-[13px] outline-none focus:border-brand-orange"
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
  );
}
