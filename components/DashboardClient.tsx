"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { DashboardPayload, DisplayRow } from "@/lib/payload-types";
import { NUMERIC_FIELDS, type NumericField } from "@/lib/access-types";
import { effectiveColumns, BUILDUP_FIELDS, type ColumnConfig } from "@/lib/columns";
import { DEFAULT_COPY, type Copy } from "@/lib/copy";
import type { Params } from "@/lib/params-apply";
import type { Employee, Overrides, HistoryEntry } from "@/lib/schema";
import type { DatasetPatch } from "@/lib/dataset-edit";
import {
  applyOverrides,
  computeScalesAndBonuses,
  getMaxDA,
  parsePercentInput,
  parseDaInput,
  type CalcEmployee,
  type PoolState,
} from "@/lib/calc";
import { fmt } from "@/lib/fmt";
import { TexcoX, TexcoWordmark } from "./TexcoBrand";
import { PoolCard } from "./PoolCard";
import { MultiSelect } from "./MultiSelect";
import EmployeeTable, { type TableColumn } from "./EmployeeTable";
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
  // are fixed for the life of the view
  const facets = useMemo(
    () => ({ cats: payload.cats, depts: payload.depts, mgrs: payload.mgrs }),
    [payload.cats, payload.depts, payload.mgrs]
  );
  const datasetVersionRef = useRef(isEditor ? payload.datasetVersion : 0);
  const [dsBusy, setDsBusy] = useState(false);
  const [dsError, setDsError] = useState<string | null>(null);

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
  const [overrides, setOverrides] = useState<Overrides>(
    isEditor ? payload.overrides : {}
  );
  /**
   * A lead's figures are computed server-side and arrive already scoped, so
   * a what-if means asking the server again rather than recalculating here —
   * their browser is never given the pool it would need to do the maths.
   */
  const [scopedRows, setScopedRows] = useState<DisplayRow[]>(
    isEditor ? [] : payload.rows
  );
  const [scopedCards, setScopedCards] = useState(
    isEditor ? [] : payload.poolCards
  );
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  // optimistic-concurrency token; a stale save gets a 409 instead of
  // silently overwriting a colleague's changes
  const versionRef = useRef(isEditor ? payload.overridesVersion : 0);

  /**
   * The last committed state. Everything typed since is scratch: local to this
   * browser, invisible to everyone else, and gone if the tab closes.
   *
   * That is the point of the tool — "if I move this person to $15k, what
   * happens to everyone else?" — and those experiments must not leak into
   * anyone else's view, or into the record, until Save says so.
   */
  const [savedOverrides, setSavedOverrides] = useState<Overrides>(
    isEditor ? payload.overrides : {}
  );
  const dirty = useMemo(
    () => JSON.stringify(overrides) !== JSON.stringify(savedOverrides),
    [overrides, savedOverrides]
  );

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
        setScopedCards(body.poolCards ?? []);
      } catch {
        // a failed preview just leaves the last figures on screen; the Save
        // button is what actually matters and it reports its own errors
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [overrides, isEditor, canEditAnything, dirty]);

  // Losing an afternoon of what-ifs to a stray tab close is worse than a prompt.
  // Not while viewing as, though: those figures were never savable, so there is
  // nothing to lose and the prompt would just be in the way.
  useEffect(() => {
    if (!dirty || viewingAs) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, viewingAs]);

  async function save() {
    // Belt-and-braces: the Save button is not rendered while viewing as, and
    // requireWriter would 403 anyway. Neither is a reason to let the request
    // leave the browser.
    if (viewingAs) return;
    setSaveStatus("saving");
    try {
      const res = await fetch("/api/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: versionRef.current, overrides }),
      });
      if (res.status === 409) {
        alert(
          "Someone else saved changes since this page loaded. Reloading to pick up the latest figures — your changes were not saved."
        );
        window.location.reload();
        return;
      }
      if (!res.ok) {
        setSaveStatus("error");
        return;
      }
      const body = await res.json();
      if (typeof body.version === "number") versionRef.current = body.version;
      // adopt what the server actually stored, not what we sent: it re-clamps
      // discretionary adjustments and refuses anything out of scope
      setOverrides(body.overrides ?? overrides);
      setSavedOverrides(body.overrides ?? overrides);
      setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    }
  }

  /**
   * Replaces the old explicit Save button: whenever the overrides doc has
   * unsaved changes, commit them in the background a moment after typing
   * settles — the same request `save()` always made, just no longer waiting
   * for a click. Debounced so tabbing through several cells in a burst
   * becomes one write, not one per field's blur. There's no "Discard" any
   * more either: with nothing staged, undoing a change just means typing the
   * old value back.
   */
  useEffect(() => {
    if (viewingAs || !canEditAnything || !dirty || saveStatus === "saving") return;
    const timer = setTimeout(() => void save(), 900);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrides, dirty, viewingAs, canEditAnything, saveStatus]);

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
        alert(
          "Someone else changed the employee data since this page loaded. Reloading to pick up the latest — your last change was not saved."
        );
        window.location.reload();
        return false;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDsError(body.error ?? "That change could not be saved.");
        return false;
      }
      // an After-IPM change can't move anyone between filter groups, so the
      // facets and the pickers stay exactly as they are
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
      setSaveStatus("saved");
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
    const catAll = selCats.length === facets.cats.length;
    if (!catAll) list = list.filter((r) => selCats.includes(r.cat));
    const deptAll = selDepts.length === facets.depts.length;
    if (!deptAll) list = list.filter((r) => selDepts.includes(r.dept));
    const mgrAll = selMgrs.length === facets.mgrs.length;
    if (!mgrAll) list = list.filter((r) => selMgrs.includes(r.mgr));

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
  }, [allRows, isEditor, activeTab, search, selCats, selDepts, selMgrs, sortCol, sortDir, facets]);

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
    let num = parseDaInput(val);
    if (isEditor) {
      const emp = empById.get(id);
      if (!emp || emp.locked || emp.sm || !pool) return;
      // Only an editor holds the pool, so only an editor can cap on the spot.
      // A lead's figure is clamped by the server instead, identically, on both
      // the preview and the save (clampDaToPool in lib/calc.ts).
      const maxDa = getMaxDA(emp, pool);
      if (num > maxDa) {
        num = maxDa;
        alert(
          `Discretionary Adjustment capped to ${fmt(maxDa)} — the maximum available within the pool cap.`
        );
      }
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
      if (!emp || emp.sm) return;
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
    if (!row || row.sm || row.final === undefined) return;
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
  function excludeEmployee(id: string, name: string) {
    if (
      !confirm(
        `Remove ${name} from the model?\n\nThey won't reappear even if a future import still lists them. This can be undone from Admin → Import.`
      )
    )
      return;
    void patchDataset({ op: "exclude", id });
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
      // A state lead sees their own pool and nothing wider: no group total, no
      // other state, no shared-services breakdown. stateBonuses, not
      // available: the card should read the same as "Total bonuses" on this
      // person's own tab, not the theoretical cap.
      return scopedCards.map((c) => (
        <PoolCard key={c.title} title={c.title} value={fmt(c.stateBonuses)} />
      ));
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
  }, [isEditor, scopedCards, pool, emps, copy, params, canEditCapsNow, dsBusy]);

  function doSort(key: string) {
    if (sortCol === key) setSortDir((d) => -d);
    else {
      setSortCol(key);
      setSortDir(1);
    }
  }

  const totFinal = totals.final;

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
          {canEditAnything && !viewingAs && (
            <span className="text-[11px] text-brand-orange-soft">
              {saveStatus === "saving"
                ? "Saving…"
                : saveStatus === "error"
                  ? "⚠ Couldn't save — "
                  : dirty
                    ? "Unsaved — visible only to you"
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
            <ViewAsPicker candidates={viewAs.candidates} viewingAs={viewingAs} />
          )}
          {isEditor && !viewingAs && (
            <a
              href="/api/export"
              title="Download the current figures as an Excel workbook, for the HR folder"
              className="border border-brand-orange/50 px-3.5 py-1.5 text-[11px] font-semibold tracking-wide text-brand-orange-soft transition-colors hover:bg-brand-orange hover:text-white"
            >
              Export
            </a>
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
                        <td className="whitespace-nowrap px-3 py-2">{h.actor}</td>
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
              <MultiSelect label="Roles" items={facets.cats} selected={selCats} onChange={setSelCats} />
              <MultiSelect label="Departments" items={facets.depts} selected={selDepts} onChange={setSelDepts} />
              <MultiSelect label="Managers" items={facets.mgrs} selected={selMgrs} onChange={setSelMgrs} />
              {configuring && (
                <>
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
                    {(activeTab === "VIC" || activeTab === "NSW") && (
                      // Matches the pool card above exactly when nothing is
                      // filtered — this figure narrows with any search or
                      // category filter, the pool card doesn't.
                      <span className="font-normal text-neutral-400">
                        {" "}(this tab&apos;s filtered rows — see the pool card above for the true total)
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
                excludeEmployee,
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

    </div>
  );
}
