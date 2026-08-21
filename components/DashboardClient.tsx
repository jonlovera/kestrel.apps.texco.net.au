"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  isLockable,
  parsePercentInput,
  parseDaInput,
  sumAllocated,
  type CalcEmployee,
  type PoolState,
} from "@/lib/calc";
import { fmt } from "@/lib/fmt";
import { TexcoX, TexcoWordmark } from "./TexcoBrand";
import { PoolCard } from "./PoolCard";
import { MultiSelect } from "./MultiSelect";
import EmployeeTable, { type TableColumn } from "./EmployeeTable";
import EmployeeEditModal from "./EmployeeEditModal";
import EmployeeAddModal from "./EmployeeAddModal";
import ColumnMenu from "./ColumnMenu";
import EditableText from "./EditableText";
import Dropzone from "./Dropzone";
import { ViewAsPicker, type ViewAsState } from "./ViewAsBar";
import {
  useImportFlow,
  ImportErrors,
  ImportPreview,
  ImportModal,
} from "./ImportFlow";

type Tab = "ALL" | "VIC" | "NSW" | "SHARED" | "HISTORY";
type SaveStatus = "idle" | "saving" | "saved" | "error";

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
  const [params, setParams] = useState<Params>(
    isEditor ? payload.params : { vCap: 0, nCap: 0, gCap: 0, companyModifier: 1 }
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
    docOverride?: Overrides
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
    const tools: TableColumn[] = [
      ...(canLockAnything
        ? [{ key: "lock", label: "Lock", noSort: true }]
        : []),
      ...(isEditor ? [{ key: "edit", label: "", noSort: true }] : []),
    ];
    return [...configured, ...tools];
  }, [isEditor, viewingAs, columnConfig, payload, canEditFields, canLockAnything]);

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
    // A facet filters only when a real subset is ticked. An EMPTY selection
    // means "no filter", not "match nothing": the picker's button reads
    // "All {label}" for both the full and the empty set, and unticking its
    // Select all used to blank the whole table underneath a button still
    // claiming "All Roles". This also keeps a one-option facet usable (a
    // lead whose team is all one category would otherwise only ever have
    // "everything" or "nothing").
    const applies = (sel: string[], all: readonly string[]) =>
      sel.length > 0 && sel.length !== all.length;
    if (applies(selRoles, facets.roles))
      list = list.filter((r) => selRoles.includes(r.pos));
    if (applies(selCats, facets.cats))
      list = list.filter((r) => selCats.includes(r.cat));
    if (applies(selDepts, facets.depts))
      list = list.filter((r) => selDepts.includes(r.dept));
    if (applies(selMgrs, facets.mgrs))
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

  function updateDA(id: string, val: string) {
    // No pool cap here any more: a discretionary adjustment is a manual
    // +/- amount on top of the pool calculation (owner decision), so it has
    // no pool-derived maximum and may be negative.
    const num = parseDaInput(val);
    if (isEditor) {
      const emp = empById.get(id);
      if (!emp || emp.locked || emp.sm) return;
    } else {
      const row = rowById.get(id);
      if (!row || row.locked || row.sm || !row.inPool) return;
    }
    setOverride(id, { daEdit: num });
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
      if (!emp || !isLockable(emp)) return;
      if (emp.locked) {
        const hasChanges =
          emp.bpEdit !== emp.bp || emp.ipmEdit !== emp.ipm || emp.daEdit !== emp.da;
        if (hasChanges) {
          const msg = `Unlock ${emp.gn} ${emp.sn}?\n\nTheir bonus of ${fmt(
            emp.finalBonus
          )} will be released back into the pool and all unlocked bonuses will be redistributed.\n\nChanges made while locked will be kept.`;
          if (!confirm(msg)) return;
        }
        setOverride(id, { locked: false, lockedFinal: undefined });
      } else {
        // finalBonus is the actual payout to freeze — identical to calcBonus
        // for an unlocked row, but it's the one that means "what gets paid".
        setOverride(id, { locked: true, lockedFinal: emp.finalBonus });
      }
      return;
    }

    // A lead has no local recompute engine — scopedRows/rowById is already
    // the server's latest figures for their own rows.
    if (!canLockAnything) return;
    const row = rowById.get(id);
    if (!row || row.sm || !row.inPool || row.final === undefined) return;
    if (row.locked) {
      const hasPendingChanges =
        overrides[id]?.daEdit !== undefined || overrides[id]?.ipmEdit !== undefined;
      if (hasPendingChanges) {
        const msg = `Unlock ${row.name}?\n\nTheir bonus of ${fmt(
          row.final
        )} will be released back into the pool and all unlocked bonuses will be redistributed.\n\nChanges made while locked will be kept.`;
        if (!confirm(msg)) return;
      }
      setOverride(id, { locked: false, lockedFinal: undefined });
    } else {
      setOverride(id, { locked: true, lockedFinal: row.final });
    }
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

  /** Move someone between the pools, from the edit modal. */
  async function changeState(
    id: string,
    st: Employee["st"],
    vicShare?: number
  ) {
    const patch: DatasetPatch =
      st === "SHARED"
        ? { op: "state", id, st, vp: vicShare }
        : { op: "state", id, st };
    if (await patchDataset(patch)) setEditingId(null);
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

  // ── pool cards ──
  const poolCardEls = useMemo(() => {
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
      return [
        <PoolCard key="pool" title="Your pool" value={fmt(mgrPool.pool)} />,
        <PoolCard key="alloc" title="Allocated" value={fmt(mgrPool.allocated)} />,
        <PoolCard
          key="remaining"
          title="Remaining"
          value={fmt(mgrPool.remaining)}
          tone={short ? "alert" : "normal"}
        />,
        <PoolCard
          key="people"
          title="People in scope"
          value={String(mgrPool.people)}
        />,
      ];
    }
    if (!pool) return null;

    // The actual paid-out total for that state/group, not the pool cap —
    // this is deliberately the same figure "Total bonuses" sums for the
    // matching tab (ALL for group, VIC/NSW for each state card), so the two
    // agree whenever no search/filter narrows the footer's count. Computed
    // the same way lib/scope-core.ts computes a lead's own stateBonuses:
    // finalBonus summed per state. Shared Services gets its own card (it
    // draws from both pools without appearing on either state's tab) so
    // VIC + NSW + Shared Services sums to Group exactly, instead of the two
    // state cards silently falling short of it.
    const vicTotal = emps.filter((e) => e.st === "VIC").reduce((s, e) => s + e.finalBonus, 0);
    const nswTotal = emps.filter((e) => e.st === "NSW").reduce((s, e) => s + e.finalBonus, 0);
    const sharedTotal = emps.filter((e) => e.st === "SHARED").reduce((s, e) => s + e.finalBonus, 0);
    const groupTotal = emps.reduce((s, e) => s + e.finalBonus, 0);

    // The cap itself, underneath the total — visible to every admin, but
    // only ever an input for the ones holding canEditCapsNow (its own grant,
    // separate from isEditor). The server decides again on every write
    // (lib/params-apply.ts's canChangeCaps), this only renders the affordance.
    const { vCap, nCap, gCap } = params;
    const capFooter = (label: string, cap: number, onCommit: (next: string) => void) => (
      <div className="mt-1.5 flex items-center gap-1 text-[11px] text-brand-70">
        Cap:
        <EditableText
          value={fmt(cap)}
          editing={canEditCapsNow}
          disabled={dsBusy}
          label={label}
          onCommit={onCommit}
          inputClassName="w-[110px]"
        />
      </div>
    );
    const card = (which: string, title: string, value: number, footer?: React.ReactNode) => (
      <PoolCard key={which} title={title} value={fmt(value)} footer={footer} />
    );

    const t = copy.poolTitles;
    return [
      card(
        "vic",
        t.vic,
        vicTotal,
        capFooter("VIC pool cap", vCap, (next) => updateParams({ vCap: parseDaInput(next) }))
      ),
      card(
        "nsw",
        t.nsw,
        nswTotal,
        capFooter("NSW pool cap", nCap, (next) => updateParams({ nCap: parseDaInput(next) }))
      ),
      card("shared", "Shared Services", sharedTotal),
      card(
        "group",
        t.group,
        groupTotal,
        capFooter("Group pool cap", gCap, (next) => updateParams({ gCap: parseDaInput(next) }))
      ),
    ];
    // updateParams is recreated every render and would defeat the memo; it
    // only ever reads the same `params` already listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditor, mgrPool, pool, emps, copy, params, canEditCapsNow, dsBusy]);

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
    <div className="flex min-h-screen flex-col">
      {/* Top bar */}
      <div className="sticky top-0 z-40 flex items-center justify-between bg-brand-95 px-6 py-3">
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
          <span className="text-right text-xs leading-tight text-brand-orange-soft">
            {payload.user.name}
            <br />
            <span className="text-[10px] opacity-80">{payload.user.scopeLabel}</span>
          </span>
          <button
            type="button"
            onClick={toggleShowAll}
            className="border border-brand-orange/50 px-3.5 py-1.5 text-[11px] font-semibold tracking-wide text-brand-orange-soft transition-colors hover:bg-brand-orange hover:text-white"
            title="Or press Space"
          >
            {showAll ? "Hide everything" : "Show everything"}
          </button>
          {viewAs && (
            <ViewAsPicker
              candidates={viewAs.candidates}
              viewingAs={viewingAs}
              canAct={canAct}
            />
          )}
          {isEditor && !viewingAs && (
            <button
              type="button"
              onClick={() => void exportNow()}
              disabled={exporting}
              title="Download the current figures as an Excel workbook, for the HR folder. Unsaved changes are saved first."
              className="border border-brand-orange/50 px-3.5 py-1.5 text-[11px] font-semibold tracking-wide text-brand-orange-soft transition-colors hover:bg-brand-orange hover:text-white disabled:opacity-40"
            >
              {exporting ? "Exporting…" : "Export"}
            </button>
          )}
          {isEditor && !viewingAs && (
            <Link
              href="/admin"
              className="border border-brand-orange/50 px-3.5 py-1.5 text-[11px] font-semibold tracking-wide text-brand-orange-soft transition-colors hover:bg-brand-orange hover:text-white"
            >
              Admin
            </Link>
          )}
          <a
            href="/logout"
            className="border border-brand-orange/50 px-3.5 py-1.5 text-[11px] font-semibold tracking-wide text-brand-orange-soft transition-colors hover:bg-brand-orange hover:text-white"
          >
            Logout
          </a>
        </div>
      </div>

      {/* Status banner — editable in place, and switchable off once final */}
      {(copy.bannerVisible || configuring) && (
        <div
          className={`px-6 py-1.5 text-center text-xs font-bold text-white ${
            copy.bannerVisible ? "bg-brand-orange" : "bg-neutral-400"
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
      <div className="mx-auto w-full max-w-[2400px] flex-1 px-5 py-4">
        {/* Tabs (editors only, like the prototype master view) */}
        {isEditor && (
          <div className="mb-4 flex gap-1">
            {(["ALL", "VIC", "NSW", "SHARED", "HISTORY"] as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => openTab(t)}
                className={`px-5 py-2 text-xs font-bold tracking-wide transition-colors ${activeTab === t
                    ? "bg-brand-orange text-white"
                    : "bg-neutral-200 text-brand-70 hover:bg-neutral-300"
                  }`}
              >
                {t === "ALL" ? "All" : t === "SHARED" ? "Shared" : t === "HISTORY" ? "History" : t}
              </button>
            ))}
          </div>
        )}

        {activeTab === "HISTORY" ? (
          <div className="mb-5 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-3">
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
            <div className="max-h-[calc(100vh-240px)] overflow-auto">
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
            {isEditor && dsError  && (
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

            {/* Pool summary — frozen, so "remaining to allocate" stays on
                screen while the employee list scrolls underneath it. The
                offset clears the sticky top bar, plus the banner when shown. */}
            <div
              className="sticky z-30 -mx-5 mb-4 flex flex-wrap gap-4 bg-surface-sunken px-5 pb-4 pt-1"
              style={{ top: copy.bannerVisible ? 78 : 52 }}
            >
              {poolCardEls}
            </div>

            {/* Controls */}
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search employees..."
                className="w-full border-2 border-neutral-200 px-3.5 py-2 text-[13px] outline-none focus:border-brand-orange sm:w-[220px]"
              />
              {/* "Roles" = positions, matching what the word means on the
                  access screen. The cat facet ("Employee" / "Texco
                  Management") keeps its own picker under the name the rest
                  of the app uses for that field: Category. */}
              <MultiSelect label="Roles" items={facets.roles} selected={selRoles} onChange={setSelRoles} />
              <MultiSelect label="Categories" items={facets.cats} selected={selCats} onChange={setSelCats} />
              <MultiSelect label="Departments" items={facets.depts} selected={selDepts} onChange={setSelDepts} />
              <MultiSelect label="Managers" items={facets.mgrs} selected={selMgrs} onChange={setSelMgrs} />
              {configuring && (
                <>
                  {/* Restored: new starters shouldn't wait for the next
                      workbook. Admin-only by the same gate as every other
                      roster control (requireWriter server-side). */}
                  <button
                    type="button"
                    disabled={dsBusy}
                    onClick={() => {
                      setDsError(null);
                      setAdding(true);
                    }}
                    className="border-2 border-brand-orange px-3.5 py-1.5 text-[11px] font-bold tracking-wide text-brand-orange transition-colors hover:bg-brand-orange hover:text-white disabled:opacity-40"
                  >
                    + Add person
                  </button>
                  <ColumnMenu
                    config={columnConfig}
                    onChange={applyColumnConfig}
                    busy={dsBusy}
                  />
                  {/* Informational only, per the walkthrough: it scales every
                      After-IPM figure, so it is not something to nudge from
                      here. It changes with the scheme, not with an allocation. */}
                  <span
                    className="flex items-center gap-1.5 border-2 border-neutral-200 px-2.5 py-1 text-[11px] font-semibold text-brand-70"
                    title="Scales every After-IPM figure. 1 = no change."
                  >
                    Company modifier
                    <span className="tabular-nums text-brand-95">
                      {params.companyModifier}
                    </span>
                  </span>
                </>
              )}
              <div className="ml-auto flex items-center gap-3 text-xs text-brand-70">
                <span className="bg-neutral-100 px-2.5 py-1">
                  Showing: {visibleRows.length} / {allRows.length}
                </span>
                {typeof totFinal === "number" && (
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
                )}
              </div>
            </div>

            {/* Sits right above its own columns rather than up in the top
                toolbar — easier to find exactly where it takes effect, and
                just as easy to collapse again once you're done. */}
            {buildupColumnCount > 0 && (
              <button
                type="button"
                onClick={toggleBuildup}
                className="mb-2 flex items-center gap-1.5 border border-brand-orange/50 px-3 py-1 text-[11px] font-semibold tracking-wide text-brand-orange-soft transition-colors hover:bg-brand-orange hover:text-white"
                title="Eligibility %, Package, Bonus %, Potential Bonus and After IPM, side by side"
              >
                <span className="text-[9px]">{buildupOpen ? "▾" : "▸"}</span>
                {buildupOpen ? "Hide build-up" : `Show build-up (${buildupColumnCount})`}
              </button>
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
              handlers={{
                updateDA,
                updateIPM,
                updateDatasetFigure,
                updateSplit,
                toggleLock,
                renameColumn,
                editEmployee: setEditingId,
              }}
            />
          </>
        )}
      </div>

      <footer className="border-t-2 border-brand-orange bg-white px-6 py-3.5 text-center text-[11px] tracking-wide text-brand-70">
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
