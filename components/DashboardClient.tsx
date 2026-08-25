"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { DashboardPayload, DisplayRow } from "@/lib/payload-types";
import { NUMERIC_FIELDS, type NumericField } from "@/lib/access-types";
import { effectiveColumns, BUILDUP_FIELDS, type ColumnConfig } from "@/lib/columns";
import { DEFAULT_COPY, type Copy } from "@/lib/copy";
import type { Params } from "@/lib/params-apply";
import type { Employee, Overrides, HistoryEntry } from "@/lib/schema";
import type { ManagerPool } from "@/lib/manager-pool";
import type { DatasetPatch } from "@/lib/dataset-edit";
import {
  mergeOverrides,
  resolveConflicts,
  type OverrideConflict,
} from "@/lib/merge-overrides";
import {
  applyOverrides,
  computeScalesAndBonuses,
  isDaEditable,
  isLockable,
  parsePercentInput,
  rowRule,
  parseDaInput,
  poolCardTotals,
  sumAllocated,
  type CalcEmployee,
  type PoolState,
} from "@/lib/calc";
import { clampDa, daHeadroom } from "@/lib/da-impact";
import { redistribute, eligible, type Redistributable } from "@/lib/redistribute";
import { letterUnavailableReason } from "@/lib/letter-blocks";
import type { LetterFormat } from "@/lib/letter-docx";
import { fmt } from "@/lib/fmt";
import { TexcoX, TexcoWordmark } from "./TexcoBrand";
import { PoolCard } from "./PoolCard";
import { PoolStrip, type PoolSummary } from "./PoolStrip";
import EmployeeTable, { type TableColumn } from "./EmployeeTable";
import EmployeeEditModal from "./EmployeeEditModal";
import EmployeeAddModal from "./EmployeeAddModal";
import FiltersMenu from "./FiltersMenu";
import AccountMenu from "./AccountMenu";
import EditableText from "./EditableText";
import Dropzone from "./Dropzone";
import { ViewAsExitButton, type ViewAsState } from "./ViewAsBar";
import { useScrollCollapse } from "@/lib/use-scroll-collapse";
import {
  useImportFlow,
  ImportErrors,
  ImportPreview,
  ImportModal,
} from "./ImportFlow";

type Tab = "ALL" | "VIC" | "NSW" | "SHARED" | "HISTORY";
type SaveStatus = "idle" | "saving" | "saved" | "error";

/**
 * TEMPORARY — pinned pool-card headlines for the admin view.
 *
 * These three figures come from the finance model and are shown INSTEAD of the
 * derived ones on the VIC pool, NSW pool and Shared Services cards. Display
 * only: substituted where each card's value is read, and nothing else. No
 * calculation is affected — poolCardTotals still computes the real figures, the
 * Cap and Remaining lines still use them, and no payout moves.
 *
 * Group total is deliberately absent and still derives: no pinned value was
 * given for it.
 *
 * TO REMOVE: delete this const and restore the three `cards.*` references it
 * replaces in poolSummary (search for PINNED_CARD_HEADLINES). Anything else that
 * disagrees with these numbers — Remaining, the tabs, "Total bonuses", a grant
 * ceiling — is the derivation still telling the truth underneath.
 */
const PINNED_CARD_HEADLINES = {
  vic: 1_343_396,
  nsw: 1_194_970,
  shared: 308_047,
} as const;

/**
 * Which columns can be typed into, and down which write path.
 *
 * Bonus % left this list when it became spreadsheet-only, and so did package,
 * FY25 and every identity field. What remains is Discretionary and IPM
 * through the overrides doc, and After IPM through the dataset. The server
 * re-decides all of it on every write (lib/write-scope.ts) — this only
 * governs which cells look typeable.
 */
const OVERRIDE_EDITABLE = ["da", "ipm"];
const DATASET_EDITABLE = ["bipm", "vp", "np"];
/** localStorage key for the build-up group's collapse state (per browser). */
const BUILDUP_KEY = "kestrel:buildup-open";
/**
 * A facet filters only when a real subset is ticked. An EMPTY selection
 * means "no filter", not "match nothing": the picker's button reads
 * "All {label}" for both the full and the empty set, and unticking its
 * Select all used to blank the whole table underneath a button still
 * claiming "All Roles". This also keeps a one-option facet usable (a
 * lead whose team is all one category would otherwise only ever have
 * "everything" or "nothing"). Shared with the Filters button's badge so
 * the count can never disagree with what actually narrows the table.
 */
const filterApplies = (sel: string[], all: readonly string[]) =>
  sel.length > 0 && sel.length !== all.length;

/**
 * What a set of display rows allocates under a document, in one pass, without
 * waiting for the preview round trip.
 *
 * This is only possible because a discretionary amount no longer moves the
 * scale: `calc` is therefore INVARIANT under a DA edit, so
 * Σ(locked ? final : calc + da) is exact for the case that matters (a DA
 * change or a tick). It goes stale for one pass after an IPM or lock edit,
 * which does move `calc`, and that self-corrects on the next preview.
 *
 * `canMeasure` is false for a scoped view that is not sent Calc bonus at all,
 * since then there is nothing local to add up — callers fall back to the
 * server's figure.
 *
 * ONE definition, shared by the two things that need it: the ceiling a lead's
 * Discretionary field is held to (leadDaBounds) and the budget a redistribution
 * spends (withRedistribution). Expressing it twice would let a lead be clamped
 * against one figure and redistributed against another.
 */
function measureAllocation(
  sourceRows: readonly DisplayRow[],
  next: Overrides
): { allocated: number; canMeasure: boolean; rows: Redistributable[] } {
  const rows: Redistributable[] = [];
  let allocated = 0;
  let canMeasure = true;
  for (const r of sourceRows) {
    const da = next[r.id]?.daEdit ?? r.da ?? 0;
    const locked = next[r.id]?.locked ?? r.locked;
    if (locked) {
      allocated += r.final ?? 0;
    } else if (r.calc === undefined) {
      canMeasure = false;
    } else {
      allocated += r.calc + da;
    }
    rows.push({
      id: r.id,
      daEdit: da,
      locked,
      calcBonus: r.calc ?? 0,
      sm: r.sm,
      st: r.st,
      inPool: r.inPool,
    });
  }
  return { allocated, canMeasure, rows };
}

export default function DashboardClient({
  payload,
  viewAs,
}: {
  payload: DashboardPayload;
  viewAs?: ViewAsState;
}) {
  const isEditor = payload.mode === "editor";
  const viewingAs = viewAs?.viewingAs ?? null;
  /**
   * The "can act for" delegation: this view belongs to someone else, but the
   * actor may save changes on it (through /api/state only), recorded against
   * the actor. Constant per mount — the page remounts on any view change via
   * its key — so no ref is needed for the timers below.
   */
  const canAct = viewAs?.canAct ?? false;
  /** A view WITHOUT the delegation: every commit path below refuses. */
  const viewReadOnly = viewingAs !== null && !canAct;
  /**
   * Which table columns this person may type into. An admin gets the full set;
   * a state lead gets IPM and Discretionary for their own rows, decided
   * server-side and handed over on the payload. The server checks again on
   * every write — this only governs which cells look typeable.
   *
   * This is NOT blanked while viewing as. The point of a view is to show what
   * that person can actually do, and a screen with their cells hidden answers
   * the wrong question. Nothing can be written either way: requireWriter
   * (lib/api-guard.ts) refuses every persisting route while a view is active,
   * and that guard, not a hidden control, is the boundary.
   */
  const canEditFields = useMemo(
    () => (isEditor ? OVERRIDE_EDITABLE : payload.canEditFields),
    [isEditor, payload]
  );
  const canEditAnything = canEditFields.length > 0;
  /**
   * Whether this person may lock/unlock a row at all — its own grant,
   * independent of `canEditFields`. An admin always has it; a lead's comes
   * straight off the payload (lib/write-scope.ts decides again on every
   * write).
   */
  const canLockAnything = isEditor || payload.canLock;

  /**
   * Whether the Letter column appears at all.
   *
   * Straight off the payload for BOTH kinds of user, with no `isEditor ||`
   * shortcut — that is the deliberate difference from the lock above. A
   * remuneration letter leaves the building over a director's signature, so
   * full access is not by itself an answer to whether someone may produce one;
   * /api/letter refuses on the same grant.
   */
  const canDownloadLetter = payload.canDownloadLetter;

  // ── editor state: the SOURCE dataset, persisted per-change to /api/dataset ─
  // Held in state (not read straight off the payload) so an inline edit
  // recalculates instantly, the way the prototype did.
  const [employees, setEmployees] = useState<Employee[]>(
    isEditor ? payload.employees : []
  );
  // the roster only changes via import now, which reloads the page, so these
  // are fixed for the life of the view. Roles (positions) are derived here
  // rather than carried on the payload: both modes already ship `pos` on
  // every row they are entitled to, so this can never widen what they see.
  const facets = useMemo(
    () => ({
      roles: [
        ...new Set(
          (payload.mode === "editor" ? payload.employees : payload.rows).map(
            (e) => e.pos
          )
        ),
      ].sort(),
      cats: payload.cats,
      depts: payload.depts,
      mgrs: payload.mgrs,
    }),
    [payload]
  );
  const datasetVersionRef = useRef(isEditor ? payload.datasetVersion : 0);
  const [dsBusy, setDsBusy] = useState(false);
  const [dsError, setDsError] = useState<string | null>(null);
  /** id of the person whose edit modal is open (pool change, remove) */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** the "+ Add person" modal (admins only, like the row pencil) */
  const [adding, setAdding] = useState(false);

  /**
   * There is no edit mode any more — every cell is directly editable in
   * place, gated only by permission (`c.editable`/`c.dsEditable`), lock
   * state, and the privacy mask (reveal a row, then its permitted cells are
   * inputs). `configuring` is what's left of the old mode boolean: it now
   * just means "a full-access admin, not viewing as someone", and gates the
   * site-configuration affordances (column rename, pool titles, banner,
   * scheme name) that only ever made sense for that role — these fire their
   * write on blur, so they're switched off entirely while viewing as, rather
   * than left to fail against the server's 403.
   */
  const configuring = isEditor && !viewingAs;
  const [columnConfig, setColumnConfig] = useState<ColumnConfig>(
    isEditor ? payload.columnConfig : []
  );
  // Read-only payloads carry no poolTitles (their card titles arrive already
  // resolved), so the defaults stand in for a map this view never renders.
  const [copy, setCopy] = useState<Copy>(
    isEditor
      ? payload.copy
      : { ...payload.copy, poolTitles: DEFAULT_COPY.poolTitles }
  );
  // A read-only viewer gets no caps — deliberately, they are not theirs to see
  // — but they DO get the funding model, which the strip below reports to
  // everyone. Everything else in the stub is a placeholder this view never
  // renders.
  const [params, setParams] = useState<Params>(
    isEditor
      ? payload.params
      : { vCap: 0, nCap: 0, gCap: 0, companyModifier: 1 }
  );
  /**
   * Pool caps are their own grant now (`canEditCaps` on a full-access rule),
   * separate from `isEditor`/`configuring` — a full admin doesn't get this
   * unless it was explicitly ticked for them on the access screen. The
   * server (`app/api/params/route.ts`) enforces the real boundary; this only
   * decides whether the cap on each pool card renders as an input.
   */
  const canEditCapsNow =
    isEditor && payload.canEditCaps && !viewingAs;

  // ── drop a spreadsheet anywhere to replace the roster ─────────────────────
  // An import replaces the dataset wholesale and re-versions the overrides, so
  // once it has applied this page is reloaded rather than patched: caps,
  // versions, facets and figures then all come from one consistent payload.
  const [importOpen, setImportOpen] = useState(false);
  const importFlow = useImportFlow();

  function closeImport() {
    if (importFlow.stage.step === "done") {
      window.location.reload();
      return;
    }
    setImportOpen(false);
    importFlow.reset();
  }

  // ── the overrides doc: scratch until Save ────────────────────────────────
  // Both payload shapes carry a baseline now. A lead's is scoped to their own
  // window (lib/write-scope.ts scopeOverridesView); starting them from {}
  // used to make their first save read as "cleared everything in my scope".
  const [overrides, setOverrides] = useState<Overrides>(payload.overrides);
  /**
   * A lead's figures are computed server-side and arrive already scoped, so
   * a what-if means asking the server again rather than recalculating here —
   * their browser is never given the pool it would need to do the maths.
   */
  const [scopedRows, setScopedRows] = useState<DisplayRow[]>(
    isEditor ? [] : payload.rows
  );
  /**
   * This manager's own pool header, refreshed by the same what-if round trip
   * as their rows. It is also the early warning for the save gate: the server
   * refuses a save that pushes them further above `pool`, so a negative
   * `remaining` here is what greys the Save button out before they try.
   */
  const [mgrPool, setMgrPool] = useState<ManagerPool | null>(
    isEditor ? null : payload.managerPool
  );
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  // optimistic-concurrency token; a stale save gets a 409 instead of
  // silently overwriting a colleague's changes. On the payload in BOTH modes
  // now — a lead used to start at 0, which made their every save a
  // guaranteed 409 and cost people real work.
  const versionRef = useRef(payload.overridesVersion);

  /**
   * The last committed state. Everything typed since is scratch: local to this
   * browser, invisible to everyone else, and gone if the tab closes.
   *
   * That is the point of the tool — "if I move this person to $15k, what
   * happens to everyone else?" — and those experiments must not leak into
   * anyone else's view, or into the record, until Save says so.
   */
  const [savedOverrides, setSavedOverrides] = useState<Overrides>(
    payload.overrides
  );
  const dirty = useMemo(
    () => JSON.stringify(overrides) !== JSON.stringify(savedOverrides),
    [overrides, savedOverrides]
  );

  /**
   * A save that came back 409 with changes both sides made to the SAME
   * figure. Everything non-overlapping has already been combined into
   * `merged` (holding OUR values for the contested slots); the banner asks
   * the user to settle the rest. Autosave pauses while this is open.
   */
  const [conflict, setConflict] = useState<{
    items: OverrideConflict[];
    merged: Overrides;
    theirs: Overrides;
  } | null>(null);
  /** A dismissible one-liner ("a colleague saved, changes combined"). */
  const [notice, setNotice] = useState<string | null>(null);
  /** id of the row whose PDF is being rendered, so its control can say so. */
  const [letterPending, setLetterPending] = useState<string | null>(null);
  /** A discretionary amount was held to the headroom ceiling. */
  const [daNotice, setDaNotice] = useState<string | null>(null);
  /**
   * Bumped per row when an entry is held at a figure the cell is already
   * showing, purely to force the uncontrolled input to remount and drop the
   * typed text. Keyed by employee id; the count itself means nothing.
   */
  const [daNonce, setDaNonce] = useState<Record<string, number>>({});
  /**
   * The pending discretionary confirmation (/api/state gate 5). The impact
   * figures come from the server, which refused to save until they are
   * acknowledged; `doc` is what it judged, so confirming re-sends exactly that.
   * `open` is false when an autosave triggered it — a modal appearing on its
   * own mid-typing helps nobody, so that surfaces as a banner instead and the
   * person opens it when they're ready.
   */
  /**
   * The server's refusal when a save would put this manager further above
   * their pool (/api/state gate 3). Held rather than thrown: the work stays on
   * screen and stays dirty, and the message names the amount that has to come
   * back out.
   *
   * Stored WITH the document it was about, so it expires on its own: any edit
   * replaces `overrides` with a new object, the reference check below stops
   * matching, and Save comes back. Deriving it beats clearing it in an effect
   * — a refusal that outlived the fix would grey out the button that applies
   * it.
   */
  const [blocked, setBlocked] = useState<{ doc: Overrides; msg: string } | null>(
    null
  );
  const blockedMsg = blocked && blocked.doc === overrides ? blocked.msg : null;

  // Refs kept current so the long-lived timers and unload handlers below
  // always see fresh state without re-registering. conflictRef and
  // savedOverridesRef are also written at their mutation sites, because
  // save() may need the new value before the next render commits.
  const overridesRef = useRef(overrides);
  const savedOverridesRef = useRef(savedOverrides);
  const dirtyRef = useRef(dirty);
  const viewingAsRef = useRef(viewingAs);
  const conflictRef = useRef(conflict);
  const blockedRef = useRef<string | null>(blockedMsg);
  /**
   * Set when the pending document holds amounts the Redistribute button wrote.
   * Purely a label: it tells /api/state to record the run as ONE history entry
   * rather than one per person. It does NOT stand in for consent — the button's
   * save goes through the confirmation modal like any other grant.
   *
   * A ref rather than a save argument because the real save happens after the
   * modal is confirmed, and can also be an autosave or a tab-close flush that
   * knows nothing about what put the figures there. Cleared once taken.
   */
  const redistributedRef = useRef(false);
  useEffect(() => {
    overridesRef.current = overrides;
    savedOverridesRef.current = savedOverrides;
    dirtyRef.current = dirty;
    viewingAsRef.current = viewingAs;
    conflictRef.current = conflict;
    blockedRef.current = blockedMsg;
  });
  /** True while a request is in flight — a plain ref, so timers can check it. */
  const savingRef = useRef(false);
  /** Consecutive silent 409 retries within one save attempt, capped at 2. */
  const retriesRef = useRef(0);

  // A lead's what-if: send the scratch overrides, get their own rows back
  // recalculated. Debounced, because it runs while they type.
  useEffect(() => {
    if (isEditor || !canEditAnything || !dirty) return;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ overrides }),
        });
        if (!res.ok) return;
        const body = await res.json();
        setScopedRows(body.rows ?? []);
        if (body.managerPool) setMgrPool(body.managerPool as ManagerPool);
      } catch {
        // a failed preview just leaves the last figures on screen; the Save
        // button is what actually matters and it reports its own errors
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [overrides, isEditor, canEditAnything, dirty]);

  // Losing an afternoon of what-ifs to a stray tab close is worse than a prompt.
  // Not in a read-only view, though: those figures were never savable, so there
  // is nothing to lose and the prompt would just be in the way. An act-as view
  // IS savable, so it warns like any other editing session.
  useEffect(() => {
    if (!dirty || viewReadOnly) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, viewReadOnly]);

  /**
   * Commit the overrides doc, without ever throwing the user's work away.
   *
   * A 409 no longer reloads the page. The response carries what is actually
   * stored, so this three-way merges: base is our last committed state,
   * ours is what we tried to save, theirs is the colleague's document.
   * Non-overlapping changes combine and the save retries itself (twice at
   * most); only a figure both sides changed differently is put to the user
   * via the conflict banner.
   *
   * `docOverride` exists for the conflict banner's buttons: React state
   * hasn't committed yet when they call straight back in, so the resolved
   * document is passed explicitly rather than read from the ref.
   */
  async function save(
    source: "manual" | "auto" = "manual",
    docOverride?: Overrides,
    opts?: { redistributed?: boolean }
  ): Promise<boolean> {
    // Belt-and-braces: the Save button is not rendered in a read-only view,
    // and requireScopedWriter would refuse anyway. Neither is a reason to
    // let the request leave the browser. An act-as view saves normally —
    // the server confines it to the target's window and records the actor.
    if (viewReadOnly || savingRef.current) return false;
    if (conflictRef.current && !docOverride) return false;
    // Already refused for the same reason and nothing has changed since —
    // sending it again would only earn the same 422.
    if (blockedRef.current) return false;
    if (!docOverride) retriesRef.current = 0;
    const sent = docOverride ?? overridesRef.current;
    const base = savedOverridesRef.current;
    savingRef.current = true;
    setSaveStatus("saving");
    try {
      const res = await fetch("/api/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: versionRef.current,
          overrides: sent,
          source,
          // while acting for someone, name them: the server refuses the save
          // if the view has meanwhile ended, so a lapsed cookie can never
          // turn this document into a write against the actor's own scope
          ...(viewingAs ? { viewFor: viewingAs } : {}),
          // Off the ref rather than the call: the button sets it, and an
          // autosave that knows nothing about it must not claim it.
          ...(redistributedRef.current || opts?.redistributed
            ? { redistributed: true }
            : {}),
        }),
      });
      if (res.status === 409) {
        const body = await res.json().catch(() => ({}) as Record<string, unknown>);
        const theirs = (body.overrides ?? {}) as Overrides;
        if (typeof body.current === "number") versionRef.current = body.current;
        const ours = overridesRef.current;
        const result = mergeOverrides(base, ours, theirs);
        savedOverridesRef.current = theirs;
        setSavedOverrides(theirs);
        overridesRef.current = result.merged;
        setOverrides(result.merged);
        if (result.conflicts.length === 0) {
          // Quiet when the merge changed nothing we can see — that is our own
          // pagehide flush having landed, not a colleague's work.
          if (JSON.stringify(result.merged) !== JSON.stringify(ours)) {
            setNotice(
              "A colleague saved changes while you were editing. Their changes have been combined with yours."
            );
          }
          if (retriesRef.current < 2) {
            retriesRef.current += 1;
            savingRef.current = false;
            return await save(source, result.merged);
          }
          setSaveStatus("error");
        } else {
          conflictRef.current = { items: result.conflicts, merged: result.merged, theirs };
          setConflict(conflictRef.current);
          setSaveStatus("idle");
        }
        return false;
      }
      if (res.status === 422) {
        // Over pool. Deliberately NOT the "error" status: that renders a
        // "retry" link, and retrying an unchanged document is guaranteed to
        // be refused again. The work stays dirty and stays on screen; the
        // message says what has to come back out.
        const body = await res.json().catch(() => ({}) as Record<string, unknown>);
        setBlocked({
          doc: sent,
          msg:
            typeof body.error === "string"
              ? body.error
              : "Not saved: this allocation is above your pool.",
        });
        setSaveStatus("idle");
        return false;
      }
      if (!res.ok) {
        setSaveStatus("error");
        return false;
      }
      const body = await res.json();
      if (typeof body.version === "number") versionRef.current = body.version;
      const stored = (body.overrides ?? sent) as Overrides;
      retriesRef.current = 0;
      // The server has taken whatever a redistribution wrote, so the next save
      // starts clean and a later hand-typed grant confirms normally.
      redistributedRef.current = false;
      savedOverridesRef.current = stored;
      setSavedOverrides(stored);
      // adopt what the server actually stored (it re-clamps discretionary
      // adjustments and refuses anything out of scope) — but never clobber
      // keystrokes committed while the request was in flight: those land in
      // `overrides` after `sent` was captured, so merge them over the result
      setOverrides((prev) =>
        prev === sent ? stored : mergeOverrides(sent, prev, stored).merged
      );
      setSaveStatus("saved");
      return true;
    } catch {
      setSaveStatus("error");
      return false;
    } finally {
      savingRef.current = false;
    }
  }

  // The timers and document-level handlers below live for the whole session;
  // they reach the current closure through this ref.
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  /**
   * Export used to be a bare link to /api/export, which reads the database —
   * so clicking it with unsaved changes (or after a failed save) produced a
   * file of stale figures stamped with a fresh timestamp. Now it flushes the
   * unsaved work first, waiting out any in-flight save rather than racing
   * it, and only falls back to asking when the save genuinely won't go
   * through (offline, or an unresolved conflict banner).
   */
  const [exporting, setExporting] = useState(false);
  async function exportNow() {
    setExporting(true);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        while (savingRef.current) await new Promise((r) => setTimeout(r, 150));
        if (!dirtyRef.current) break;
        await save("manual");
      }
      if (
        dirtyRef.current &&
        !confirm(
          "Your latest changes could not be saved, so the export will not include them. Export anyway?"
        )
      ) {
        return;
      }
      // a download, not a navigation — the route answers with an attachment,
      // so the page stays put and the router has no business here
      const a = document.createElement("a");
      a.href = "/api/export";
      a.click();
    } finally {
      setExporting(false);
    }
  }

  /** The conflict banner's buttons: settle every contested figure one way. */
  function settleConflicts(take: "ours" | "theirs") {
    const c = conflictRef.current;
    if (!c) return;
    const resolved = resolveConflicts(c.merged, c.theirs, c.items, take);
    conflictRef.current = null;
    setConflict(null);
    overridesRef.current = resolved;
    setOverrides(resolved);
    void save("manual", resolved);
  }

  /**
   * The autosave: every 3 minutes, commit whatever is unsaved. This replaced
   * a 900 ms debounce that hammered the snapshot ring and, for leads, force-
   * reloaded the page on its guaranteed conflicts. A manual Save (button or
   * Ctrl/Cmd+S) is always available in between; the pagehide flush below
   * covers the tab that closes inside the window.
   *
   * On a tick with nothing to save, it instead asks the server for the doc
   * version — one integer — so "a colleague has saved" surfaces without
   * anyone attempting a write.
   */
  useEffect(() => {
    if (viewReadOnly || !canEditAnything) return;
    const tick = () => {
      if (savingRef.current || conflictRef.current || blockedRef.current) return;
      if (dirtyRef.current) {
        void saveRef.current("auto");
        return;
      }
      void (async () => {
        try {
          const res = await fetch("/api/state/version");
          if (!res.ok) return;
          const body = await res.json();
          if (typeof body.version === "number" && body.version > versionRef.current) {
            setNotice(
              "A colleague has saved changes since this page loaded. Refresh when convenient to see their figures."
            );
          }
        } catch {
          // a failed probe is nothing; the next save merges regardless
        }
      })();
    };
    const timer = setInterval(tick, 180_000);
    return () => clearInterval(timer);
  }, [viewReadOnly, canEditAnything]);

  // Ctrl/Cmd+S saves, because that is what hands will do anyway.
  useEffect(() => {
    if (!canEditAnything) return;
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "s") return;
      e.preventDefault(); // the browser's own save-page dialog helps nobody here
      if (dirtyRef.current) void saveRef.current("manual");
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [canEditAnything]);

  /**
   * Last-ditch flush when the page is going away or being hidden, so a tab
   * closed inside the autosave window doesn't cost the last few edits.
   * `keepalive` lets the request outlive the page; the response is
   * unreadable by then, which is fine — if it conflicts, the server refuses
   * and nothing is lost that wasn't already. A value still sitting in a
   * focused cell has not reached React state yet and cannot be captured
   * here; cells commit on blur.
   */
  useEffect(() => {
    if (!canEditAnything) return;
    let flushedThisHide = false;
    const flush = () => {
      if (flushedThisHide) return;
      if (!dirtyRef.current || viewReadOnly || conflictRef.current) return;
      // a refused document must not be flushed on the way out either — it
      // would 422 unread and look, from here, exactly like a successful save
      if (blockedRef.current) return;
      flushedThisHide = true;
      try {
        void fetch("/api/state", {
          method: "POST",
          keepalive: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            version: versionRef.current,
            overrides: overridesRef.current,
            source: "auto",
            // the same lapsed-view refusal as save(); especially important
            // here, where the response can never be read
            ...(viewingAsRef.current ? { viewFor: viewingAsRef.current } : {}),
          }),
        });
      } catch {
        // nothing sensible left to do while the page is being torn down
      }
    };
    const onPageHide = () => flush();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
      else flushedThisHide = false; // back again: re-arm for the next hide
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [canEditAnything, viewReadOnly]);

  // ── calc (editor mode runs the prototype's engine client-side) ──
  const { emps, pool } = useMemo<{
    emps: CalcEmployee[];
    pool: PoolState | null;
  }>(() => {
    if (!isEditor) return { emps: [], pool: null };
    const e = applyOverrides(employees, overrides);
    // caps come from live params state, so typing a new cap moves the pool
    // cards as you type — the impact preview /admin/params used to show
    const p = computeScalesAndBonuses(e, params);
    return { emps: e, pool: p };
  }, [isEditor, employees, overrides, params]);

  // ── shared UI state ──
  const [activeTab, setActiveTab] = useState<Tab>("ALL");
  const [search, setSearch] = useState("");
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState(1);
  const [selRoles, setSelRoles] = useState<string[]>(facets.roles);
  const [selCats, setSelCats] = useState<string[]>(payload.cats);
  const [selDepts, setSelDepts] = useState<string[]>(payload.depts);
  const [selMgrs, setSelMgrs] = useState<string[]>(payload.mgrs);

  /**
   * Send one After-IPM change to the source dataset. Unlike the overrides
   * doc this commits immediately: it is a deliberate, infrequent correction to
   * the source figures rather than part of the what-if loop.
   */
  async function patchDataset(patch: DatasetPatch): Promise<boolean> {
    if (viewingAs) return false;
    setDsBusy(true);
    setDsError(null);
    try {
      const res = await fetch("/api/dataset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: datasetVersionRef.current, patch }),
      });
      if (res.status === 409) {
        // Adopt the latest roster in place instead of force-reloading, which
        // used to throw away the user's unsaved override scratch as
        // collateral. Their one unapplied dataset figure is re-entered.
        const conflictBody = await res.json().catch(() => ({}) as Record<string, unknown>);
        if (typeof conflictBody.current === "number") {
          datasetVersionRef.current = conflictBody.current;
        }
        if (Array.isArray(conflictBody.employees)) {
          setEmployees(conflictBody.employees);
        }
        setDsError(
          "Someone else changed the employee data while you were editing. The latest figures have been loaded. Your last change was not applied, so please re-enter it if it still applies."
        );
        return false;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDsError(body.error ?? "That change could not be saved.");
        return false;
      }
      // The facet memo and the pickers are fixed for the life of the view.
      // Inline figure and state edits can't invent a new filter value; an
      // added person CAN bring a new department or manager, which joins the
      // filter lists on the next reload — until then the row is still shown,
      // because an all-selected facet applies no filter at all.
      datasetVersionRef.current = body.version;
      setEmployees(body.employees);
      return true;
    } catch {
      setDsError("That change could not be saved — check your connection.");
      return false;
    } finally {
      setDsBusy(false);
    }
  }

  /**
   * The presentation and parameter documents. Unlike the dataset these are
   * last-write-wins: they're tiny, rarely edited by two people at once, and
   * every write snapshots first.
   */
  async function saveConfig(
    path: "columns" | "copy" | "params",
    body: unknown
  ): Promise<boolean> {
    if (viewingAs) return false;
    setDsBusy(true);
    setDsError(null);
    try {
      const res = await fetch(`/api/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setDsError(data.error ?? "That change could not be saved.");
        return false;
      }
      // deliberately does not touch saveStatus: that now belongs to the Save
      // button, which is about the overrides doc alone
      return true;
    } catch {
      setDsError("That change could not be saved — check your connection.");
      return false;
    } finally {
      setDsBusy(false);
    }
  }

  function applyColumnConfig(next: ColumnConfig) {
    setColumnConfig(next); // optimistic: the menu should feel instant
    void saveConfig("columns", next);
  }

  function renameColumn(key: string, label: string) {
    applyColumnConfig(
      columnConfig.map((c) => (c.field === key ? { ...c, label } : c))
    );
  }

  function updateCopy(patch: Partial<Copy>) {
    const next = { ...copy, ...patch };
    setCopy(next);
    void saveConfig("copy", next);
  }

  function updateParams(patch: Partial<Params>) {
    const next = { ...params, ...patch };
    setParams(next);
    void saveConfig("params", next);
  }

  /**
   * The bonus build-up group (Eligibility % → Package → Bonus % → Potential
   * Bonus → After IPM), collapsed by default and remembered per browser.
   *
   * Starting `false` on every render, including the first one on a returning
   * visitor's browser, is deliberate: this is a client component, so it is
   * still server-rendered before it hydrates, and the server has no
   * localStorage to read. Reading it in a useEffect after mount is the
   * standard way to avoid a hydration mismatch — it costs one extra render
   * when the stored preference differs from the default, never a warning.
   *
   * There is no server-side, per-user preference store anywhere in this app
   * (column visibility is one shared document for everyone); building one for
   * a single collapse toggle would be disproportionate. The trade-off is
   * real and worth stating: this does not follow someone to a second device.
   */
  const [buildupOpen, setBuildupOpen] = useState(false);
  /**
   * The table's scroll box, held as state via a callback ref (it unmounts on
   * the History tab), so the pool cards can collapse to a strip while the
   * list is scrolled and give the rows the room back.
   */
  const [tableScrollEl, setTableScrollEl] = useState<HTMLDivElement | null>(null);
  const poolCollapsed = useScrollCollapse(tableScrollEl);
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Syncing React state from an external store (localStorage) on mount is
    // exactly what this effect is for, per the lint rule's own guidance —
    // there is no prop or state this could be derived from instead.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBuildupOpen(window.localStorage.getItem(BUILDUP_KEY) === "true");
  }, []);
  function toggleBuildup() {
    setBuildupOpen((open) => {
      const next = !open;
      try {
        window.localStorage.setItem(BUILDUP_KEY, String(next));
      } catch {
        // Private browsing or a full quota — the toggle still works for the
        // rest of this session, it just won't be remembered next time.
      }
      return next;
    });
  }

  // ── privacy: figures are masked by default; reveal per row, or all at once
  //    via the header button / Space ──
  const [showAll, setShowAll] = useState(false);
  /**
   * Who is ticked for the next "Redistribute the pool".
   *
   * Transient by design: it lives here, is never written to an override, never
   * reaches the server and clears on reload. It is a selection for an action,
   * not a property of a person — an earlier design persisted it and paid for
   * that with a schema field, a merge-conflict slot and a history line, for no
   * gain. Modelled on revealedIds below, which is the same shape.
   */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());
  const isRevealed = (id: string) => showAll || revealedIds.has(id);

  function toggleShowAll() {
    setShowAll((prev) => {
      if (prev) setRevealedIds(new Set()); // hiding again clears row reveals
      return !prev;
    });
  }

  function toggleRow(id: string) {
    setRevealedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== " " || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.tagName === "BUTTON" ||
          t.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      toggleShowAll();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // ── history tab (editors only, fetched lazily) ──
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  async function fetchHistory() {
    setHistoryLoading(true);
    try {
      const res = await fetch("/api/history");
      if (res.ok) setHistory((await res.json()).entries);
      else setHistory([]);
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }

  function openTab(t: Tab) {
    setActiveTab(t);
    // Selection is tab-scoped for redistribution. Clear it when changing tabs
    // so a hidden carry-over selection can never drive the next run.
    setSelected(new Set());
    // Back to the top of the new tab's list, which also re-expands the pool
    // cards — a tab change is a fresh look, not a continuation of a scroll.
    tableScrollEl?.scrollTo({ top: 0 });
    if (t === "HISTORY" && history === null) fetchHistory();
  }

  // ── rows in display shape ──
  const allRows: DisplayRow[] = useMemo(() => {
    if (!isEditor) return scopedRows;
    return emps.map((e) => ({
      id: e.id,
      name: `${e.gn} ${e.sn}`,
      gn: e.gn,
      sn: e.sn,
      st: e.st,
      pos: e.pos,
      dept: e.dept,
      mgr: e.mgr,
      cat: e.cat,
      sm: e.sm,
      locked: e.locked,
      inPool: e.vp > 0 || e.np > 0,
      vp: e.vp,
      np: e.np,
      elig: e.elig,
      totalPkg: e.totalPkg,
      pkg: e.pkg,
      bp: e.bpEdit,
      potential: e.preIpm,
      ipm: e.ipmEdit,
      bipm: e.bipmCalc,
      calc: e.calcBonus,
      f25: e.f25,
      da: e.daEdit,
      yoy: e.finalBonus - e.f25,
      final: e.finalBonus,
    }));
  }, [isEditor, scopedRows, emps]);

  // ── columns ──
  // Every column now comes from the server payload: presentation-config
  // visible, and for the figure columns also scope-visible, in configured
  // order. Identity columns carry `identity: true` and are never scope-gated.
  const columns: TableColumn[] = useMemo(() => {
    // Editors resolve their own columns from local config so the column menu
    // applies instantly; the server recomputes the identical list on reload.
    // Read-only users get the already-scoped list and nothing else.
    const source = isEditor
      ? effectiveColumns(columnConfig, NUMERIC_FIELDS)
      : payload.columns;
    const configured: TableColumn[] = source.map((c) => ({
      key: c.key,
      label: c.label,
      num: !c.identity,
      editable: canEditFields.includes(c.key),
      // After IPM writes straight to the dataset on blur, so unlike the
      // override cells it cannot stay live while viewing as.
      dsEditable: isEditor && !viewingAs && DATASET_EDITABLE.includes(c.key),
      format: c.format,
      decimals: c.decimals,
    }));
    // NOT blanked while viewing as, same as canEditFields above and for the
    // same reason: the point of a view is to show what that person can
    // actually do, and hiding their tools answers the wrong question.
    // Nothing can actually be written during a view either way — save()
    // refuses outright while viewingAs is set, and the beforeunload warning
    // already skips it too — so showing the control is free.
    //
    // The lock is its own grant (canLockAnything, from the access screen's
    // "Can lock" checkbox), independent of whether this lead may edit any
    // figure at all (lib/write-scope.ts enforces the boundary server-side).
    // The exclude (pencil) column stays admin-only: removing someone from
    // the model entirely is a different, heavier action than freezing their
    // bonus.
    // The letter sits beside the lock because that is what it depends on — a
    // letter states a final bonus, so the row has to be frozen first. Its own
    // grant again (the access screen's "Can download letters"), and unlike the
    // lock an admin does NOT get it for being an admin.
    const tools: TableColumn[] = [
      ...(canLockAnything
        ? [{ key: "lock", label: "Lock", noSort: true }]
        : []),
      ...(canDownloadLetter
        ? [{ key: "letter", label: "Letter", noSort: true }]
        : []),
      ...(isEditor ? [{ key: "edit", label: "", noSort: true }] : []),
    ];
    return [...configured, ...tools];
  }, [isEditor, viewingAs, columnConfig, payload, canEditFields, canLockAnything, canDownloadLetter]);

  /** Which of the build-up figures this person is entitled to at all. */
  const buildupColumnCount = useMemo(
    () => columns.filter((c) => (BUILDUP_FIELDS as readonly string[]).includes(c.key)).length,
    [columns]
  );
  /**
   * The build-up group collapses out of the table entirely rather than being
   * greyed out — this is a reconciliation aid someone reaches for on demand,
   * not a permanent fixture competing for space with the figures used daily.
   */
  const visibleColumns = useMemo(
    () =>
      buildupOpen
        ? columns
        : columns.filter((c) => !(BUILDUP_FIELDS as readonly string[]).includes(c.key)),
    [columns, buildupOpen]
  );

  // ── filtering + sorting (prototype getVisibleEmployees) ──
  const visibleRows = useMemo(() => {
    let list = allRows;
    if (isEditor && activeTab !== "ALL" && activeTab !== "HISTORY")
      list = list.filter((r) => r.st === activeTab);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.pos.toLowerCase().includes(q) ||
          r.dept.toLowerCase().includes(q) ||
          r.mgr.toLowerCase().includes(q) ||
          r.st.toLowerCase().includes(q)
      );
    }
    if (filterApplies(selRoles, facets.roles))
      list = list.filter((r) => selRoles.includes(r.pos));
    if (filterApplies(selCats, facets.cats))
      list = list.filter((r) => selCats.includes(r.cat));
    if (filterApplies(selDepts, facets.depts))
      list = list.filter((r) => selDepts.includes(r.dept));
    if (filterApplies(selMgrs, facets.mgrs))
      list = list.filter((r) => selMgrs.includes(r.mgr));

    if (sortCol !== null) {
      const val = (r: DisplayRow): string | number => {
        switch (sortCol) {
          case "name": return r.name;
          case "state": return r.st;
          case "pos": return r.pos;
          case "dept": return r.dept;
          case "mgr": return r.mgr;
          case "cat": return r.cat;
          default:
            return (r[sortCol as NumericField] as number | undefined) ?? 0;
        }
      };
      list = [...list].sort((a, b) => {
        const va = val(a);
        const vb = val(b);
        if (typeof va === "string" && typeof vb === "string") {
          const la = va.toLowerCase();
          const lb = vb.toLowerCase();
          return la < lb ? -sortDir : la > lb ? sortDir : 0;
        }
        return ((va as number) - (vb as number)) * sortDir;
      });
    }
    return list;
  }, [allRows, isEditor, activeTab, search, selRoles, selCats, selDepts, selMgrs, sortCol, sortDir, facets]);

  // ── edit handlers (prototype updateBP/updateIPM/updateDA/toggleLock) ──
  const empById = useMemo(
    () => new Map(emps.map((e) => [e.id, e])),
    [emps]
  );

  /**
   * The same lookup for read-only viewers, who have no `emps` at all.
   *
   * A lead is deliberately never sent the dataset or the caps — that is the
   * whole point of the read-only payload — so `emps` is empty for them and
   * `empById` can never resolve a row. Their edits used to be dropped on that
   * miss, silently: the cells rendered, accepted typing, and threw it away.
   * Everything the guards below actually need (locked, site manager, in-pool)
   * is already on the row they were sent.
   */
  const rowById = useMemo(
    () => new Map(allRows.map((r) => [r.id, r])),
    [allRows]
  );

  function setOverride(id: string, patch: Overrides[string]) {
    setOverrides((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  /**
   * A LEAD's ceiling for one row: the most its Discretionary field may hold.
   *
   * A lead has no engine here — they are never sent the dataset or the caps —
   * so this is measured off their own header instead: their pool, less what
   * every OTHER row in scope allocates. Backing the row's own amount out is
   * what makes it "the most this field may hold" rather than "the most it may
   * go up by", and also what makes it stable while they type into this row:
   * only a change to some other row moves it.
   *
   * It agrees with what /api/state's gate 4 will decide. For a whole-state
   * lead the two are identical arithmetic — their pool IS the state cap and
   * their rows ARE that state's rows, so `pool - others` is exactly the
   * home-state bound the server applies (lib/calc.ts's capRoom under
   * CapBound "state"). For a narrower scope this is the tighter of the two,
   * which is the honest answer: their budget is their own pool, and gate 3
   * would refuse anything above it regardless of what a state cap allowed.
   *
   * Infinity when there is no header to measure against (an admin, who has the
   * engine and takes the branch above instead).
   */
  const leadDaBounds = useCallback(
    (row: DisplayRow, next: Overrides): { current: number; ceiling: number } => {
      const current = next[row.id]?.daEdit ?? row.da ?? 0;
      if (!mgrPool) return { current, ceiling: Infinity };
      const { allocated, canMeasure } = measureAllocation(scopedRows, next);
      // Fall back to the server's Remaining when Calc bonus isn't in the
      // payload and there is nothing local to add up.
      const others = canMeasure ? mgrPool.pool - allocated : mgrPool.remaining;
      return { current, ceiling: others + current };
    },
    [mgrPool, scopedRows]
  );

  function updateDA(id: string, val: string) {
    // The hard limit (owner decision, 25 Aug 2026: the field refuses the grant
    // automatically). A discretionary amount adds to its pool's total instead
    // of being funded from inside it, so what bounds it IS the cap. Anything
    // above that ceiling is held to it and said out loud. A reduction is never
    // held back.
    //
    // The two kinds of user reach the same ceiling by different routes, because
    // they hold different figures. An admin has the engine and every cap, so
    // theirs is daHeadroom over the whole population: the row's home-state cap
    // AND the group cap. A lead has neither, so theirs is measured off their
    // own header (leadDaBounds) — which is the same number gate 4 will apply to
    // them, since a lead is bounded by their home state alone (lib/calc.ts's
    // CapBound). Leads used to get no ceiling at all here and only learned on
    // save, from a figure the refusal withheld.
    //
    // Gate 5 still makes both kinds of user confirm before anything is
    // recorded, and gate 4 remains the guarantee behind both clamps.
    let num = parseDaInput(val);
    let heldName = "";
    if (isEditor) {
      const emp = empById.get(id);
      if (!emp || emp.locked) return;
      // VIC site managers are deliberately not adjustable; NSW ones are.
      if (!isDaEditable(rowRule(emp))) return;
      const ceiling = pool ? daHeadroom(emp, emps, params) : Infinity;
      const held = clampDa(num, emp.daEdit, ceiling);
      num = held.value;
      if (held.clamped) heldName = `${emp.gn} ${emp.sn}`;
    } else {
      const row = rowById.get(id);
      if (!row || row.locked || !isDaEditable(row)) return;
      const { current, ceiling } = leadDaBounds(row, overridesRef.current);
      const held = clampDa(num, current, ceiling);
      num = held.value;
      if (held.clamped) heldName = row.name;
    }
    if (heldName) {
      setDaNotice(
        `${heldName} was held to ${fmt(num)}. That is the most that can be granted before the pool reaches its cap.`
      );
      // The cell is uncontrolled and keyed on the stored figure, so a value
      // held at what is already there wouldn't re-render on its own — the
      // typed text would sit there looking accepted. Force the remount.
      setDaNonce((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
    } else if (daNotice) {
      setDaNotice(null);
    }
    setOverride(id, { daEdit: num });
  }

  /**
   * The ceiling for one row, for the hint the table shows on a focused cell —
   * so the limit is visible before anyone types into it rather than only after
   * they have been held to it. Null when there is nothing to show (a row with
   * no cap bound, or one that isn't adjustable in the first place).
   *
   * `overrides`, not `overridesRef`: this runs during render, where the state
   * is current and the ref is a beat behind.
   */
  const daHeadroomFor = useCallback(
    (id: string): number | null => {
      const show = (ceiling: number) =>
        Number.isFinite(ceiling) ? Math.max(0, Math.floor(ceiling)) : null;
      if (isEditor) {
        if (!pool) return null;
        const emp = empById.get(id);
        if (!emp || emp.locked) return null;
        // no ceiling badge on a cell that isn't adjustable in the first place
        if (!isDaEditable(rowRule(emp))) return null;
        return show(daHeadroom(emp, emps, params));
      }
      const row = rowById.get(id);
      if (!row || row.locked || !isDaEditable(row)) return null;
      return show(leadDaBounds(row, overrides).ceiling);
    },
    [isEditor, pool, empById, emps, params, rowById, leadDaBounds, overrides]
  );

  /**
   * Why this row's letter is unavailable — the rule itself is in
   * lib/letter-blocks.ts; what this adds is the one fact only the dashboard
   * holds, whether the lock has actually been SAVED. Everything typed since
   * the last Save is scratch, invisible to the server, so a row that reads as
   * locked on screen is not one /api/letter can see.
   */
  const letterBlocked = useCallback(
    (row: DisplayRow): string | null =>
      letterUnavailableReason(row, savedOverrides[row.id]?.locked === true),
    [savedOverrides]
  );

  /**
   * Fetch the letter and hand it to the browser as a file.
   *
   * Deliberately NOT a plain link, which is how this started: a link navigates,
   * so any refusal replaced the whole dashboard with the raw JSON error at
   * /api/letter?id=… and the only way back was the back button. A refusal has
   * to leave the person where they were, with the reason in the notice bar they
   * already read everything else in.
   */
  async function downloadLetter(id: string, format: LetterFormat = "docx") {
    const row = rowById.get(id);
    if (!row) return;
    const blocked = letterBlocked(row);
    if (blocked) {
      setNotice(blocked);
      return;
    }
    // A PDF is rendered by LibreOffice on the server: about a second warm, and
    // closer to ten on a cold function while it unpacks itself. Long enough
    // that silence reads as a broken button, so say what is happening.
    setNotice(
      format === "pdf" ? `Producing ${row.name}'s letter as PDF…` : null
    );
    setLetterPending(format === "pdf" ? id : null);
    let url: string | null = null;
    try {
      const res = await fetch(
        `/api/letter?id=${encodeURIComponent(id)}&format=${format}`
      );
      if (!res.ok) {
        // The server is the boundary, so it still gets the last word — a lock
        // someone else released, or a grant withdrawn since the page loaded.
        const body = await res.json().catch(() => null);
        setNotice(body?.error ?? `The letter for ${row.name} couldn't be produced.`);
        return;
      }
      const name =
        /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ??
        `${row.name}.${format}`;
      url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (format === "pdf") setNotice(null);
    } catch {
      setNotice(`The letter for ${row.name} couldn't be downloaded. Check your connection and try again.`);
    } finally {
      // Revoked either way: on the error path there is nothing to keep, and on
      // the success path the click has already handed the blob to the browser.
      if (url) URL.revokeObjectURL(url);
      setLetterPending(null);
    }
  }

  /**
   * IPM is the one figure a site manager's own bonus does still move with
   * (`lib/calc.ts`: their finalBonus is pkg × bpEdit × cpm × ipmEdit, just
   * never pro-rated against the pool) — so unlike Discretionary, this is not
   * blocked for `sm` rows. Locked rows are blocked: their bonus is already
   * frozen, so editing IPM would only move the unseen "Calc bonus" figure,
   * not anything actually paid.
   */
  function updateIPM(id: string, current: number, raw: string) {
    const next = parsePercentInput(raw);
    if (next === null || Math.round(next * 100) === Math.round(current * 100)) return;
    if (isEditor) {
      const emp = empById.get(id);
      if (!emp || emp.locked) return;
    } else {
      const row = rowById.get(id);
      if (!row || row.locked) return;
    }
    setOverride(id, { ipmEdit: next });
  }

  /**
   * The one remaining dataset edit: After IPM. No-ops if unchanged.
   * Package, FY25 and bonus % are read-only for everyone now — they come from
   * the spreadsheet, because a typo in one cascades through every figure.
   */
  function updateDatasetFigure(id: string, current: number, raw: string) {
    const next = parseDaInput(raw); // same lenient "$1,234" parsing
    if (Math.round(next) === Math.round(current)) return;
    void patchDataset({ op: "field", id, field: "bipm", value: next });
  }

  /**
   * Set one side of a Shared Services split. The server derives the other
   * side (lib/dataset-edit.ts) so a save can never leave the two sides
   * disagreeing — this only has to send the one figure that was typed.
   */
  function updateSplit(id: string, field: "vp" | "np", current: number, raw: string) {
    const next = parsePercentInput(raw);
    if (next === null || Math.round(next * 100) === Math.round(current * 100)) return;
    void patchDataset({ op: "field", id, field, value: next });
  }

  /**
   * Locking used to be admin-only. A lead now gets the same ability, within
   * their own scope, gated on the access screen's own "Can lock" grant
   * (`canLockAnything`) — independent of whether they may edit any figure at
   * all. The server enforces the identical boundary
   * (`writableFields`/`sanitiseOverrideWrite`, lib/write-scope.ts), this only
   * decides whether the control does anything client-side.
   */
  function toggleLock(id: string) {
    if (isEditor) {
      const emp = empById.get(id);
      if (!emp || !isLockable(rowRule(emp))) return;
      // One boolean, and nothing else. A payout is a stored figure that this
      // flag does not feed (lib/calc.ts), so there is no amount to capture on
      // the way in or restore on the way out — which is what makes locking and
      // unlocking leave every figure on screen exactly where it was.
      setOverride(id, { locked: !emp.locked });
      return;
    }

    // A lead needs no engine and no figure for this any more: the flag carries
    // no amount, so a scope that cannot even see Final can still lock a row.
    // (It used to need the figure to freeze, and silently did nothing when the
    // column was outside the scope.)
    if (!canLockAnything) return;
    const row = rowById.get(id);
    if (!row || !isLockable(row)) return;
    setOverride(id, { locked: !row.locked });
  }

  /**
   * Permanently remove someone from the model — not just this dataset, every
   * import after this one too (lib/import-parse.ts's candidateDataset keeps
   * honouring lib/schema.ts's excludedIds even if a future spreadsheet still
   * lists them). Reversible from /admin/import, but the row itself isn't
   * restored by un-excluding — only a later import that still has them
   * brings them back.
   */
  async function excludeEmployee(id: string, name: string) {
    if (
      !confirm(
        `Remove ${name} from the model?\n\nThey won't reappear even if a future import still lists them. This can be undone from Admin → Import.`
      )
    )
      return;
    if (await patchDataset({ op: "exclude", id })) setEditingId(null);
  }

  /**
   * Move someone between the pools, from the edit modal. `vicShare` carries a
   * funding split for any state, not just Shared Services — omitted, VIC and
   * NSW take the whole of their own pool. Undefined serialises away, so the
   * server sees no vp at all and applies that default itself.
   */
  async function changeState(
    id: string,
    st: Employee["st"],
    vicShare?: number
  ) {
    if (await patchDataset({ op: "state", id, st, vp: vicShare }))
      setEditingId(null);
  }

  /** "+ Add person": one op through the same funnel; closes on success. */
  async function addEmployee(employee: Employee) {
    if (await patchDataset({ op: "add", employee })) setAdding(false);
  }

  // ── totals row ──
  // Identity columns are in the payload too now; they hold strings and are
  // skipped by the `typeof v === "number"` guard.
  const totals = useMemo(() => {
    const t: Partial<Record<NumericField, number>> = {};
    for (const col of payload.columns) {
      if (col.identity) continue;
      const key = col.key as NumericField;
      let any = false;
      let sum = 0;
      for (const r of visibleRows) {
        const v = r[key];
        if (typeof v === "number") {
          any = true;
          sum += v;
        }
      }
      if (any) t[key] = sum;
    }
    return t;
  }, [visibleRows, payload.columns]);

  /** How many facets are actually narrowing the table — the Filters badge. */
  const activeFilterCount =
    (filterApplies(selRoles, facets.roles) ? 1 : 0) +
    (filterApplies(selCats, facets.cats) ? 1 : 0) +
    (filterApplies(selDepts, facets.depts) ? 1 : 0) +
    (filterApplies(selMgrs, facets.mgrs) ? 1 : 0);

  // ── pool summary ──
  // The figures as data first, then two renderings of the same object: the
  // full cards below, and the thin strip they collapse into once the table
  // is scrolled (PoolStrip). Neither computes anything of its own, so the
  // two can never disagree.
  const poolSummary = useMemo<PoolSummary | null>(() => {
    if (!isEditor) {
      // A manager sees their OWN pool and nothing wider: no group total, no
      // other state, no whole-of-VIC figure. What replaced the old "VIC pool"
      // card is four numbers about the people they are actually accountable
      // for — the pool their scope draws, what they have committed of it, what
      // is left, and how many people that covers. Allocated comes from the
      // same sumAllocated the table footer uses (lib/manager-pool.ts), so the
      // header and the footer cannot disagree.
      if (!mgrPool) return null;
      const short = mgrPool.remaining <= 0;
      return {
        kind: "manager",
        items: [
          { key: "pool", title: "Your pool CAP", value: fmt(mgrPool.pool) },
          { key: "alloc", title: "Allocated", value: fmt(mgrPool.allocated) },
          { key: "remaining", title: "Remaining", value: fmt(mgrPool.remaining), alert: short },
          { key: "people", title: "People in scope", value: String(mgrPool.people) },
        ],
      };
    }
    if (!pool) return null;

    // The actual paid-out total for that state/group, not the pool cap —
    // this is deliberately the same figure "Total bonuses" sums for the
    // matching tab (ALL for group, VIC/NSW for each state card), so the two
    // agree whenever no search/filter narrows the footer's count. Computed
    // the same way lib/scope-core.ts computes a lead's own stateBonuses:
    // finalBonus summed per state. Shared Services gets its own card (nobody
    // there appears on either state's tab) so VIC + NSW + Shared Services
    // sums to Group exactly, instead of the state cards silently falling
    // short of it.
    //
    // These are whole finals grouped by HOME STATE, not each pool's draw on
    // its cap. Someone whose cost splits — a VIC employee doing a portion of
    // NSW work, or anyone in Shared Services — has their whole bonus counted
    // under the state they belong to, while the engine funds the fractions
    // from each cap (lib/calc.ts's getVicAlloc/getNswAlloc are the per-pool
    // figures). So the cap footers read as a guide, not a reconciliation.
    // One definition, in lib/calc.ts, so these six figures are testable rather
    // than four filters buried in a memo. The state headlines are shown NET of
    // the shared-services money their own cap carries (owner decision, 26 Aug
    // 2026) — see poolCardTotals for why that money was invisible before.
    const cards = poolCardTotals(emps, pool, params);
    // The cap footers below stay on the UNREDUCED home-state totals, which is
    // what capRoom and /api/state's gate 4 actually enforce. A "remaining"
    // derived from the net figure would advertise room the save then refuses.
    const vicHome = cards.vic + cards.vicOther;
    const nswHome = cards.nsw + cards.nswOther;
    const groupTotal = cards.group;

    // A figure goes red when it exceeds its cap. An ADMIN's own edit cannot
    // cause that: theirs is clamped at type time to the room left under both
    // caps (getMaxDA, measured off exactly these figures), so at most it takes
    // a card to exactly its cap.
    //
    // The GROUP card can now go red from someone else's work, and that is
    // expected rather than a fault. A lead is bounded by their home state
    // alone (lib/calc.ts's CapBound), so a lead spending their state's room can
    // carry the group total past gCap — which, since gCap defaults to
    // vCap + nCap and Shared Services draws against it with no state cap of its
    // own, it was already close to. This card is where that surfaces, for the
    // one person who can act on it. Also still surfaces a stored figure
    // inherited from a lowered cap or an earlier funding model.
    // Half-a-cent slack so float noise never paints a card red.
    const over = (value: number, cap: number) => value > cap + 0.005;
    const { vCap, nCap, gCap } = params;
    const t = copy.poolTitles;
    return {
      kind: "editor",
      items: [
        {
          key: "vic",
          title: t.vic,
          // PINNED_CARD_HEADLINES — display only; cards.vicPool is the derived figure
          value: PINNED_CARD_HEADLINES.vic,
          cap: vCap,
          remaining: vCap - vicHome,
          over: over(vicHome, vCap),
        },
        {
          key: "nsw",
          title: t.nsw,
          // PINNED_CARD_HEADLINES — display only; cards.nswPool is the derived figure
          value: PINNED_CARD_HEADLINES.nsw,
          cap: nCap,
          remaining: nCap - nswHome,
          over: over(nswHome, nCap),
        },
        {
          key: "shared",
          title: "Shared Services (corporate split)",
          // PINNED_CARD_HEADLINES — display only; cards.shared is the derived figure
          value: PINNED_CARD_HEADLINES.shared,
          // The two lines are NOT a breakdown of the headline — they cover a
          // different population. The headline is everyone on Shared Services;
          // the lines are the PART-SPLIT staff, the few on their own ratio
          // rather than the corporate one, attributed per cap. They deliberately
          // do not sum to it.
          //
          // No ratio in the label: no such constant exists in the code, the
          // corporate ratio is inferred from the data (see poolCardTotals), and
          // a hardcoded "61/39" would go stale the moment one changed.
          lines: [
            { label: "Part-split staff, VIC", value: cards.vicPartSplit },
            { label: "Part-split staff, NSW", value: cards.nswPartSplit },
          ],
          over: false,
        },
        {
          key: "group",
          title: t.group,
          value: groupTotal,
          cap: gCap,
          remaining: gCap - groupTotal,
          over: over(groupTotal, gCap),
        },
      ],
    };
  }, [isEditor, mgrPool, pool, emps, copy, params]);

  const poolCardEls = useMemo(() => {
    if (!poolSummary) return null;
    if (poolSummary.kind === "manager") {
      // The action itself lives in the toolbar beside the selection it acts on,
      // not here — see the "N selected" bar. These cards stay pure figures.
      return poolSummary.items.map((it) => (
        <PoolCard
          key={it.key}
          title={it.title}
          value={it.value}
          tone={it.alert ? "alert" : "normal"}
        />
      ));
    }

    // The cap itself, underneath the total — visible to every admin, but
    // only ever an input for the ones holding canEditCapsNow (its own grant,
    // separate from isEditor). The server decides again on every write
    // (lib/params-apply.ts's canChangeCaps), this only renders the affordance.
    const capFooter = (
      label: string,
      cap: number,
      remaining: number | undefined,
      onCommit: (next: string) => void
    ) => (
      <div className="mt-1.5 space-y-0.5 text-[11px] text-brand-70">
        <div className="flex items-center gap-1">
          Cap:
          <EditableText
            value={fmt(cap)}
            editing={canEditCapsNow}
            disabled={dsBusy}
            label={label}
            onCommit={onCommit}
            inputClassName="w-[110px] font-bold"
          />
        </div>
        {typeof remaining === "number" && (
          <div className="flex items-center gap-1">
            Remaining:
            <span className={remaining < 0 ? "font-bold text-red-600" : "font-semibold text-brand-95"}>
              {fmt(remaining)}
            </span>
          </div>
        )}
      </div>
    );
    const capCommits: Record<string, { label: string; commit: (next: string) => void }> = {
      vic: { label: "VIC pool cap", commit: (next) => updateParams({ vCap: parseDaInput(next) }) },
      nsw: { label: "NSW pool cap", commit: (next) => updateParams({ nCap: parseDaInput(next) }) },
      group: { label: "Group pool cap", commit: (next) => updateParams({ gCap: parseDaInput(next) }) },
    };

    return poolSummary.items.map((it) => (
      <PoolCard
        key={it.key}
        title={it.title}
        value={fmt(it.value)}
        lines={it.lines?.map((l) => ({ label: l.label, value: fmt(l.value) }))}
        footer={
          it.cap !== undefined && capCommits[it.key]
            ? capFooter(
              capCommits[it.key].label,
              it.cap,
              "remaining" in it && typeof it.remaining === "number" ? it.remaining : undefined,
              capCommits[it.key].commit
            )
            : undefined
        }
        tone={it.over ? "alert" : "normal"}
      />
    ));
    // updateParams is recreated every render and would defeat the memo; it
    // only ever reads the same `params` poolSummary already derives from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poolSummary, canEditCapsNow, dsBusy]);

  /**
   * Spend what is left of the pool across the ticked people.
   *
   * `next` is the override document AFTER whatever change triggered this, so
   * the split is measured on the figures the user is about to have rather than
   * the ones they had. Returns a document with the redistribution applied, or
   * null when there was nothing to do — the caller then writes only its own
   * change, so an edit that moves nothing does not look like a redistribution.
   *
   * Only a lead has a pool to spend. `mgrPool` is null for an admin, who sees
   * cap cards rather than a Remaining figure, so this is a no-op for them.
   */
  function withRedistribution(next: Overrides): Overrides | null {
    if (!canEditFields.includes("da")) return null;
    if (isEditor && activeTab !== "VIC" && activeTab !== "NSW") return null;

    // Remaining, recomputed locally rather than waiting for the preview round
    // trip — through the same measureAllocation a lead's field ceiling uses, so
    // the figure they are clamped against and the figure this spends can never
    // drift apart. See that function for why a local sum is exact here, and for
    // what `canMeasure` falls back to.
    const sourceRows = isEditor
      ? allRows.filter((r) => r.st === activeTab)
      : scopedRows;
    const { allocated, canMeasure, rows } = measureAllocation(sourceRows, next);
    let remaining: number;
    if (isEditor) {
      // Admin redistribution is state-tab scoped and spends that state's room
      // under its cap.
      remaining = activeTab === "VIC" ? params.vCap - allocated : params.nCap - allocated;
    } else {
      if (!mgrPool) return null;
      remaining = canMeasure ? mgrPool.pool - allocated : mgrPool.remaining;
    }

    const shares = redistribute(rows, remaining, selected);
    if (shares.size === 0) return null;
    const out: Overrides = { ...next };
    for (const [id, daEdit] of shares) {
      out[id] = { ...out[id], daEdit };
    }
    return out;
  }

  /**
   * The Redistribute button — the ONLY thing that writes amounts. There used to
   * be an "automatic pass" riding along with whatever edit caused it; that went
   * in 5d8b6dd, and nothing has moved an amount behind the user's back since.
   */
  function redistributeNow() {
    if (viewReadOnly || !canEditFields.includes("da")) return;
    if (isEditor && activeTab !== "VIC" && activeTab !== "NSW") return;
    // overridesRef, not `overrides`: this runs from a button inside the
    // memoised pool cards, whose dep list deliberately omits the document (see
    // the eslint-disable below it), so a captured `overrides` could be a render
    // behind. The ref is the same guard the save path uses.
    const next = withRedistribution(overridesRef.current);
    if (!next) {
      setNotice("Nothing to redistribute — either the pool is fully allocated or nobody is ticked.");
      return;
    }
    // Marks the document so the history records one line for the run. Gate 5
    // still fires — pressing the button is a request to be shown what it does.
    redistributedRef.current = true;
    setOverrides(next);
    void save("manual", next);
  }

  /**
   * Which rows may be ticked at all: the ones a redistribution would actually
   * act on. Read off lib/redistribute.ts's own rule rather than restated, so a
   * checkbox can never be offered where the action would skip the row.
   */
  const selectableIds = useMemo(() => {
    if (viewReadOnly || !canEditFields.includes("da")) {
      return new Set<string>();
    }
    if (isEditor && activeTab !== "VIC" && activeTab !== "NSW") {
      return new Set<string>();
    }
    const candidates = isEditor ? allRows.filter((r) => r.st === activeTab) : allRows;
    const rows: Redistributable[] = candidates.map((r) => ({
      id: r.id,
      daEdit: r.da ?? 0,
      locked: r.locked,
      calcBonus: r.calc ?? 0,
      sm: r.sm,
      st: r.st,
      inPool: r.inPool,
    }));
    // every row is a candidate here; the filter is what we are after
    return new Set(
      eligible(rows, new Set(rows.map((r) => r.id))).map((r) => r.id)
    );
  }, [allRows, viewReadOnly, canEditFields, isEditor, activeTab]);

  const canShowSelection =
    !viewReadOnly &&
    canEditFields.includes("da") &&
    (!isEditor || activeTab === "VIC" || activeTab === "NSW");

  const isSelected = (id: string) => selected.has(id);

  function toggleSelected(id: string) {
    if (!selectableIds.has(id)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /**
   * Select-all over the rows currently VISIBLE, so a search or a facet narrows
   * what it means — ticking everything after filtering to one department is the
   * point of having it. Rows selected outside the current filter are left
   * alone rather than silently dropped.
   */
  const visibleSelectable = useMemo(
    () => visibleRows.filter((r) => selectableIds.has(r.id)).map((r) => r.id),
    [visibleRows, selectableIds]
  );
  const allVisibleSelected =
    visibleSelectable.length > 0 &&
    visibleSelectable.every((id) => selected.has(id));

  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visibleSelectable.forEach((id) => next.delete(id));
      else visibleSelectable.forEach((id) => next.add(id));
      return next;
    });
  }

  /**
   * Bulk lock/unlock over the rows currently visible in the table.
   *
   * Uses the same eligibility rule as single-row toggleLock, so NSW site
   * managers are included while VIC site managers stay excluded.
   */
  const visibleLockable = useMemo(
    () => visibleRows.filter((r) => isLockable(r)),
    [visibleRows]
  );
  const allVisibleLocked =
    visibleLockable.length > 0 && visibleLockable.every((r) => r.locked);

  function toggleLockAllVisible() {
    if (!canLockAnything || viewReadOnly) return;
    if (visibleLockable.length === 0) {
      setNotice("No lockable rows in the current view.");
      return;
    }

    const lock = !allVisibleLocked;
    setOverrides((prev) => {
      const next: Overrides = { ...prev };
      // Same one-boolean write as toggleLock, in bulk. Nothing can be skipped
      // for want of a figure now, so the "couldn't be locked" notice is gone.
      for (const row of visibleLockable) {
        next[row.id] = { ...next[row.id], locked: lock };
      }
      return next;
    });
  }

  /** One human-readable line per contested figure in the conflict banner. */

  function conflictLine(c: OverrideConflict): string {
    const name = isEditor
      ? (() => {
        const e = empById.get(c.empId);
        return e ? `${e.gn} ${e.sn}` : c.empId;
      })()
      : (rowById.get(c.empId)?.name ?? c.empId);
    const label =
      c.field === "lock"
        ? "Lock"
        : (columns.find((col) => col.key === (c.field === "daEdit" ? "da" : "ipm"))
          ?.label ?? (c.field === "daEdit" ? "Discretionary" : "IPM"));
    const show = (v: number | boolean | undefined): string => {
      if (v === undefined) return "cleared";
      if (typeof v === "boolean") return v ? "locked" : "unlocked";
      return c.field === "ipmEdit" ? `${Math.round(v * 100)}%` : fmt(v);
    };
    return `${name}: ${label} yours ${show(c.ours)}, theirs ${show(c.theirs)}`;
  }

  function doSort(key: string) {
    if (sortCol === key) setSortDir((d) => -d);
    else {
      setSortCol(key);
      setSortDir(1);
    }
  }

  // The footer's figure, through the SAME function the header's Allocated
  // comes from (lib/calc.ts's sumAllocated, via lib/manager-pool.ts) — so with
  // nothing filtered the two are equal by construction rather than by two
  // implementations happening to agree. The generic totals memo still decides
  // whether this column exists for this user at all.
  const totFinal =
    totals.final === undefined
      ? undefined
      : sumAllocated(visibleRows, (r) => r.final ?? 0);

  /**
   * The over-pool line. The server's own refusal wins when there is one — it
   * judged the merged document and is authoritative. Otherwise the what-if
   * header's own arithmetic, so a manager sees the problem while typing rather
   * than only when Save bounces. Editors have no manager pool to exceed.
   */
  const overPool =
    blockedMsg ??
    (!isEditor && mgrPool && mgrPool.remaining < 0
      ? `${fmt(-mgrPool.remaining)} of this allocation can't be absorbed by your pool. Reduce discretionary amounts by ${fmt(-mgrPool.remaining)} before saving.`
      : null);

  return (
    // The shell is exactly one viewport tall and never scrolls itself — the
    // employee table is the page's single vertical scroller, so its heading
    // row can't leave the screen and there's only ever one scrollbar.
    <div className="flex h-dvh flex-col overflow-hidden">
      {/* Top bar */}
      <div className="relative z-40 flex items-center justify-between bg-brand-95 px-6 py-2">
        <div className="flex items-center">
          <TexcoX className="mr-2.5 h-[22px] w-[22px] shrink-0 text-brand-orange" />
          <TexcoWordmark className="mr-4 h-[18px] w-auto shrink-0 text-white" />
          <EditableText
            value={copy.schemeName}
            editing={configuring}
            disabled={dsBusy}
            label="Scheme name"
            onCommit={(schemeName) => updateCopy({ schemeName })}
            className="hidden text-xs font-medium text-brand-orange sm:inline"
            inputClassName="w-[280px]"
          />
        </div>
        <div className="flex items-center gap-3">
          {canEditAnything && !viewReadOnly && (
            <span className="text-[11px] text-brand-orange-soft">
              {saveStatus === "saving"
                ? ""
                : saveStatus === "error"
                  ? "⚠ Couldn't save, "
                  : dirty
                    ? "Unsaved, visible only to you"
                    : saveStatus === "saved"
                      ? "Saved"
                      : ""}
              {saveStatus === "error" && (
                <button
                  type="button"
                  onClick={() => void save()}
                  className="font-bold underline underline-offset-2"
                >
                  retry
                </button>
              )}
            </span>
          )}
          {canEditAnything && !viewReadOnly && (
            <button
              type="button"
              onClick={() => void save()}
              disabled={
                saveStatus === "saving" ||
                overPool !== null ||
                (!dirty && saveStatus !== "error")
              }
              title={
                overPool
                  ? "Over pool — see the message above the table"
                  : "Or press Ctrl+S (Cmd+S on Mac). Unsaved work also saves itself every 3 minutes."
              }
              className="border border-brand-orange/50 px-3.5 py-1.5 text-[11px] font-semibold tracking-wide text-brand-orange-soft transition-colors hover:bg-brand-orange hover:text-white disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-brand-orange-soft"
            >
              {saveStatus === "saving"
                ? "Saving…"
                : overPool
                  ? "Over pool"
                  : dirty || saveStatus === "error"
                    ? "Save"
                    : "Saved"}
            </button>
          )}
          <button
            type="button"
            onClick={toggleShowAll}
            className="border border-brand-orange/50 px-3.5 py-1.5 text-[11px] font-semibold tracking-wide text-brand-orange-soft transition-colors hover:bg-brand-orange hover:text-white"
            title="Or press Space"
          >
            {showAll ? "Hide everything" : "Show everything"}
          </button>
          {/* An active view stays out in the bar — it's state to see and
              leave at a glance, not a command to bury in the menu. */}
          {viewingAs && <ViewAsExitButton viewingAs={viewingAs} canAct={canAct} />}
          <AccountMenu
            userName={payload.user.name}
            scopeLabel={payload.user.scopeLabel}
            viewAs={viewAs}
            viewingAs={viewingAs}
            isEditor={isEditor}
            exporting={exporting}
            onExport={() => void exportNow()}
          />
        </div>
      </div>

      {/* Status banner — editable in place, and switchable off once final */}
      {(copy.bannerVisible || configuring) && (
        <div
          className={`px-6 py-1.5 text-center text-xs font-bold text-white ${copy.bannerVisible ? "bg-brand-orange" : "bg-neutral-400"
            }`}
        >
          <EditableText
            value={copy.bannerText}
            editing={configuring}
            disabled={dsBusy}
            label="Status banner"
            onCommit={(bannerText) => updateCopy({ bannerText })}
            inputClassName="w-[320px] text-center"
          />
          {configuring && (
            <label className="ml-4 inline-flex items-center gap-1.5 text-[11px] normal-case">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-white"
                checked={copy.bannerVisible}
                disabled={dsBusy}
                onChange={(e) => updateCopy({ bannerVisible: e.target.checked })}
              />
              Show this banner
            </label>
          )}
        </div>
      )}

      {/* Widened from 1600px so the build-up columns have real room once
          expanded — the table's own horizontal scroll (EmployeeTable.tsx)
          remains the fallback on a narrower screen. */}
      <div className="mx-auto flex min-h-0 w-full max-w-[2400px] flex-1 flex-col px-5 pt-4">
        {/* Tabs (editors only, like the prototype master view), sharing one
            row with the search box, the Filters button and the counts —
            everything else the toolbar used to hold lives inside the
            Filters & options panel now. */}
        <div className="mb-3 flex shrink-0 flex-wrap items-center gap-3">
          {isEditor && (
            <div className="flex gap-1">
              {(["ALL", "VIC", "NSW", "SHARED", "HISTORY"] as Tab[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => openTab(t)}
                  className={`px-4 py-1.5 text-xs font-bold tracking-wide transition-colors ${activeTab === t
                    ? "bg-brand-orange text-white"
                    : "bg-neutral-200 text-brand-70 hover:bg-neutral-300"
                    }`}
                >
                  {t === "ALL" ? "All" : t === "SHARED" ? "Shared" : t === "HISTORY" ? "History" : t}
                </button>
              ))}
            </div>
          )}
          {activeTab !== "HISTORY" && (
            <>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search employees..."
                className="w-full border-2 border-neutral-200 px-3.5 py-1.5 text-[13px] outline-none focus:border-brand-orange sm:w-[220px]"
              />
              <FiltersMenu
                facets={facets}
                selRoles={selRoles}
                setSelRoles={setSelRoles}
                selCats={selCats}
                setSelCats={setSelCats}
                selDepts={selDepts}
                setSelDepts={setSelDepts}
                selMgrs={selMgrs}
                setSelMgrs={setSelMgrs}
                activeFilterCount={activeFilterCount}
                configuring={configuring}
                dsBusy={dsBusy}
                onAddPerson={() => {
                  setDsError(null);
                  setAdding(true);
                }}
                columnConfig={columnConfig}
                onColumnConfigChange={applyColumnConfig}
                companyModifier={params.companyModifier}
                buildupColumnCount={buildupColumnCount}
                buildupOpen={buildupOpen}
                onToggleBuildup={toggleBuildup}
              />
              {canLockAnything && (
                <button
                  type="button"
                  onClick={toggleLockAllVisible}
                  disabled={dsBusy || saveStatus === "saving" || visibleLockable.length === 0}
                  title={
                    allVisibleLocked
                      ? "Unlock every lockable row currently visible"
                      : "Lock every lockable row currently visible"
                  }
                  className="border border-brand-orange/50 px-3 py-1.5 text-[11px] font-semibold tracking-wide text-brand-orange-soft transition-colors hover:bg-brand-orange hover:text-white disabled:opacity-40"
                >
                  {allVisibleLocked ? "Unlock all" : "Lock all"}
                </button>
              )}
              {/* The only way anything is ever redistributed. Appears only with
                  a selection, so the action and what it will act on are never
                  more than a glance apart. */}
              {canShowSelection && selected.size > 0 && (
                <div className="flex items-center gap-2 border-2 border-brand-orange/40 bg-brand-orange-tint/40 px-2.5 py-1">
                  <span className="text-[12px] font-bold text-brand-95">
                    {selected.size} selected
                  </span>
                  <button
                    type="button"
                    onClick={redistributeNow}
                    disabled={dsBusy || saveStatus === "saving"}
                    title="Split what is left of the pool across the selected people, in proportion to their calculated bonus"
                    className="bg-brand-orange px-2.5 py-1 text-[11px] font-bold tracking-wide text-white transition-colors hover:bg-brand-orange-hover disabled:opacity-40"
                  >
                    Redistribute the pool
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelected(new Set())}
                    className="px-1 text-[11px] font-semibold text-brand-70 underline underline-offset-2"
                  >
                    clear
                  </button>
                </div>
              )}
              <div className="ml-auto flex items-center gap-3 text-xs text-brand-70">
                <span className="bg-neutral-100 px-2.5 py-1">
                  Showing: {visibleRows.length} / {allRows.length}
                </span>
                {/* {typeof totFinal === "number" && (
                  <span className="bg-neutral-100 px-2.5 py-1">
                    Total bonuses: {fmt(totFinal)}
                    {(activeTab === "VIC" ||
                      activeTab === "NSW" ||
                      (!isEditor && visibleRows.length < allRows.length)) && (
                        // Matches the card above exactly when nothing is
                        // filtered — this figure narrows with any search or
                        // category filter, the card doesn't.
                        <span className="font-normal text-neutral-400">
                          {" "}(filtered rows — see the card above for the true total)
                        </span>
                      )}
                  </span>
                )} */}
              </div>
            </>
          )}
        </div>

        {activeTab === "HISTORY" ? (
          <div className="flex min-h-0 flex-1 flex-col bg-white shadow-sm">
            <div className="flex shrink-0 items-center justify-between border-b border-neutral-100 px-4 py-3">
              <h2 className="text-[13px] font-bold">
                Change history
              </h2>
              <button
                type="button"
                disabled={historyLoading}
                onClick={fetchHistory}
                className="border border-neutral-300 px-3 py-1 text-[11px] font-semibold text-brand-70 transition-colors hover:border-brand-orange hover:text-brand-orange disabled:opacity-40"
              >
                {historyLoading ? "Loading…" : "Refresh"}
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {history === null || historyLoading ? (
                <div className="px-4 py-8 text-center text-[13px] text-brand-70">
                  Loading…
                </div>
              ) : history.length === 0 ? (
                <div className="px-4 py-8 text-center text-[13px] text-brand-70">
                  No changes recorded yet.
                </div>
              ) : (
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr>
                      {["When", "Who", "What"].map((h) => (
                        <th
                          key={h}
                          className="sticky top-0 whitespace-nowrap bg-brand-95 px-3 py-2.5 text-left text-[11px] tracking-wide text-white"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h, i) => (
                      <tr key={i} className="border-b border-neutral-100 hover:bg-neutral-50">
                        <td className="whitespace-nowrap px-3 py-2 tabular-nums text-brand-70">
                          {new Date(h.ts).toLocaleString("en-AU", {
                            day: "2-digit",
                            month: "short",
                            year: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">
                          {h.actor}
                          {h.viewingAs ? ` (as ${h.viewingAs})` : ""}
                        </td>
                        <td className={`px-3 py-2 ${showAll ? "" : "blur-[6px] select-none"}`}>
                          {h.kind === "access" && (
                            <span className="mr-2 inline-block bg-neutral-200 px-1.5 py-px text-[10px] font-bold text-neutral-600">
                              access
                            </span>
                          )}
                          {h.summary}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        ) : (
          <>
            {/* A rejected inline edit explains itself here; the cell has already
            snapped back to the stored figure. */}
            {isEditor && dsError && (
              <div className="mb-4 flex items-start justify-between gap-4 border-2 border-error bg-error-tint px-4 py-2 text-[13px] font-semibold">
                <span>{dsError}</span>
                <button
                  type="button"
                  onClick={() => setDsError(null)}
                  className="shrink-0 text-[11px] tracking-wide underline"
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* A colleague saved and everything combined cleanly — worth a
                line, not an interruption. */}
            {/* Over pool. The server's refusal if a save has already been
                tried, otherwise the early warning derived from the what-if
                header — either way it names the amount that has to come back
                out, and nothing has moved silently to make room. */}
            {overPool && (
              <div className="mb-4 border-2 border-error bg-error-tint px-4 py-2 text-[13px] font-semibold">
                {overPool}
              </div>
            )}

            {notice && !conflict && (
              <div className="mb-4 flex items-start justify-between gap-4 border-2 border-brand-orange/60 bg-white px-4 py-2 text-[13px] font-semibold">
                <span>{notice}</span>
                <button
                  type="button"
                  onClick={() => setNotice(null)}
                  className="shrink-0 text-[11px] tracking-wide underline"
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* An entry was held to the headroom ceiling — informational, not
                an error: the held figure has been kept, and it is the most the
                unlocked bonuses can fund. */}
            {isEditor && daNotice && (
              <div className="mb-4 flex items-start justify-between gap-4 border-2 border-brand-orange/60 bg-white px-4 py-2 text-[13px] font-semibold">
                <span>{daNotice}</span>
                <button
                  type="button"
                  onClick={() => setDaNotice(null)}
                  className="shrink-0 text-[11px] tracking-wide underline"
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* The same figure changed by two people: the one situation the
                merge cannot settle on its own. The page stays usable; only
                saving waits on the choice. */}
            {conflict && (
              <div className="mb-4 border-2 border-error bg-error-tint px-4 py-3 text-[13px]">
                <p className="font-semibold">
                  You and a colleague have both changed the same figures since
                  this page loaded. Everything changed by only one of you has
                  already been combined; choose which values to keep for the
                  figures below.
                </p>
                <ul className="mt-2 list-disc pl-5">
                  {conflict.items.map((c) => (
                    <li key={`${c.empId}:${c.field}`}>{conflictLine(c)}</li>
                  ))}
                </ul>
                <div className="mt-3 flex gap-3">
                  <button
                    type="button"
                    onClick={() => settleConflicts("ours")}
                    className="border border-neutral-400 bg-white px-3.5 py-1.5 text-[11px] font-bold transition-colors hover:border-brand-orange hover:text-brand-orange"
                  >
                    Keep my values
                  </button>
                  <button
                    type="button"
                    onClick={() => settleConflicts("theirs")}
                    className="border border-neutral-400 bg-white px-3.5 py-1.5 text-[11px] font-bold transition-colors hover:border-brand-orange hover:text-brand-orange"
                  >
                    Use their values
                  </button>
                </div>
              </div>
            )}

            {/* Pool summary — full cards while the list sits at the top,
                collapsing into a thin strip of the same figures once it's
                scrolled, so "remaining to allocate" stays on screen while
                the rows get the room back. Both regions animate their grid
                track between 0fr and 1fr: real content height, no measured
                magic numbers, wrapping cards included. */}
            {poolSummary && (
              <>
                <div
                  inert={poolCollapsed}
                  className={`grid shrink-0 transition-[grid-template-rows] duration-300 ease-out ${poolCollapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]"
                    }`}
                >
                  <div className="min-h-0 overflow-hidden">
                    <div className="mb-4 flex flex-wrap gap-4">{poolCardEls}</div>
                  </div>
                </div>
                <div
                  aria-hidden={!poolCollapsed}
                  className={`grid shrink-0 transition-[grid-template-rows] duration-300 ease-out ${poolCollapsed ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                    }`}
                >
                  <div className="min-h-0 overflow-hidden">
                    <div className="mb-2">
                      <PoolStrip summary={poolSummary} />
                    </div>
                  </div>
                </div>
              </>
            )}

            <EmployeeTable
              columns={visibleColumns}
              rows={visibleRows}
              totals={totals}
              canRenameColumns={configuring}
              busy={dsBusy}
              showAll={showAll}
              isRevealed={isRevealed}
              toggleRow={toggleRow}
              sortCol={sortCol}
              sortDir={sortDir}
              onSort={doSort}
              daNonce={daNonce}
              daHeadroomFor={daHeadroomFor}
              canSelect={canShowSelection}
              isSelected={isSelected}
              canSelectRow={(id) => selectableIds.has(id)}
              onToggleSelected={toggleSelected}
              onToggleSelectAll={toggleSelectAll}
              allVisibleSelected={allVisibleSelected}
              handlers={{
                updateDA,
                updateIPM,
                updateDatasetFigure,
                updateSplit,
                toggleLock,
                renameColumn,
                editEmployee: setEditingId,
                downloadLetter,
                letterBlocked,
                letterPending,
              }}
              scrollRef={setTableScrollEl}
            />
          </>
        )}
      </div>

      <footer className="shrink-0 border-t-2 border-brand-orange bg-white px-6 py-2 text-center text-[11px] tracking-wide text-brand-70">
        <EditableText
          value={copy.footerText}
          editing={configuring}
          disabled={dsBusy}
          label="Footer"
          maxLength={160}
          onCommit={(footerText) => updateCopy({ footerText })}
          inputClassName="w-[520px] max-w-full text-center"
        />
      </footer>

      {/* Editors can drop a spreadsheet anywhere on the dashboard. The preview
          still stands between the file and the data. */}
      {isEditor && (
        <Dropzone
          onFile={(file) => {
            setImportOpen(true);
            void importFlow.check(file);
          }}
          disabled={importOpen || dsBusy || viewingAs !== null}
          label="Drop the spreadsheet to update the figures"
        />
      )}

      {isEditor && importOpen && (
        <ImportModal
          closable={!importFlow.busy}
          onClose={closeImport}
        >
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[13px] font-bold text-white">
              Import employee data
            </h2>
            <button
              type="button"
              disabled={importFlow.busy}
              onClick={closeImport}
              className="border border-white/40 px-3 py-1 text-[11px] font-semibold text-white hover:bg-white/10 disabled:opacity-40"
            >
              Close
            </button>
          </div>

          {importFlow.fatal && (
            <div className="mb-3 border-2 border-error bg-error-tint px-4 py-2 text-[13px] font-semibold">
              {importFlow.fatal}
            </div>
          )}

          {importFlow.stage.step === "checking" && (
            <div className="bg-white px-5 py-8 text-center text-[13px] text-brand-70 shadow-sm">
              Checking the file…
            </div>
          )}
          {importFlow.stage.step === "errors" && (
            <ImportErrors errors={importFlow.stage.errors} />
          )}
          {importFlow.stage.step === "preview" && (
            <ImportPreview
              preview={importFlow.stage.preview}
              confirm={importFlow.stage.confirm}
              setConfirm={importFlow.setConfirm}
              busy={importFlow.busy}
              onApply={importFlow.apply}
              onCancel={closeImport}
            />
          )}
          {importFlow.stage.step === "done" && (
            <div className="border-t-4 border-brand-orange bg-white p-5 shadow-sm">
              <h3 className="mb-2 text-[13px] font-bold">
                Import applied
              </h3>
              <p className="mb-4 text-[13px]">
                {importFlow.stage.preview.rowCount} employees imported (
                {importFlow.stage.preview.added.length} added,{""}
                {importFlow.stage.preview.removed.length} removed). Total pool:{""}
                {fmt(importFlow.stage.preview.totalAfter)}. It can be undone from{""}
                <Link href="/admin/snapshots" className="font-semibold text-brand-orange underline">
                  Snapshots
                </Link>
                .
              </p>
              <button
                type="button"
                onClick={closeImport}
                className="bg-brand-orange px-6 py-2.5 text-[12px] font-bold text-white hover:bg-brand-orange-hover"
              >
                Show updated figures
              </button>
            </div>
          )}
        </ImportModal>
      )}

      {editingId &&
        (() => {
          const e = employees.find((x) => x.id === editingId);
          if (!e) return null;
          return (
            <EmployeeEditModal
              key={e.id}
              employee={{
                id: e.id,
                name: `${e.gn} ${e.sn}`,
                pos: e.pos,
                st: e.st,
                vp: e.vp,
              }}
              busy={dsBusy}
              error={dsError}
              onApplyState={(st, vicShare) => void changeState(e.id, st, vicShare)}
              onRemove={() => void excludeEmployee(e.id, `${e.gn} ${e.sn}`)}
              onClose={() => {
                setEditingId(null);
                setDsError(null);
              }}
            />
          );
        })()}

      {adding && (
        <EmployeeAddModal
          roles={facets.roles}
          cats={facets.cats}
          depts={facets.depts}
          mgrs={facets.mgrs}
          existingIds={new Set(employees.map((e) => e.id))}
          busy={dsBusy}
          error={dsError}
          onAdd={(employee) => void addEmployee(employee)}
          onClose={() => {
            setAdding(false);
            setDsError(null);
          }}
        />
      )}

    </div>
  );
}
