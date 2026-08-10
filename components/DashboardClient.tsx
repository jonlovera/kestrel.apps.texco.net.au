"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import type { DashboardPayload, DisplayRow } from "@/lib/payload-types";
import { NUMERIC_FIELDS, type NumericField } from "@/lib/access-types";
import { effectiveColumns, type ColumnConfig } from "@/lib/columns";
import { DEFAULT_COPY, type Copy } from "@/lib/copy";
import type { Params } from "@/lib/params-apply";
import type { Employee, Overrides, HistoryEntry } from "@/lib/schema";
import type { DatasetPatch } from "@/lib/dataset-edit";
import {
  applyOverrides,
  computeScalesAndBonuses,
  getMaxDA,
  getVicAlloc,
  getNswAlloc,
  parsePercentInput,
  parseDaInput,
  type CalcEmployee,
  type PoolState,
} from "@/lib/calc";
import { fmt } from "@/lib/fmt";
import { TexcoX, TexcoWordmark } from "./TexcoBrand";
import { PoolCard, type PoolMetric } from "./PoolCard";
import { MultiSelect } from "./MultiSelect";
import EmployeeTable, { type TableColumn } from "./EmployeeTable";
import ColumnMenu from "./ColumnMenu";
import EditableText from "./EditableText";
import Dropzone from "./Dropzone";
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
 * FY25 and every identity field. What remains is the allocation: IPM and
 * Discretionary through the overrides doc, After IPM through the dataset.
 * The server re-decides all of it on every write (lib/write-scope.ts) — this
 * only governs which cells look typeable.
 */
const OVERRIDE_EDITABLE = ["ipm", "da"];
const DATASET_EDITABLE = ["bipm"];

export default function DashboardClient({
  payload,
}: {
  payload: DashboardPayload;
}) {
  const isEditor = payload.mode === "editor";

  // ── editor state: the SOURCE dataset, persisted per-change to /api/dataset ─
  // Held in state (not read straight off the payload) so an inline edit
  // recalculates instantly, the way the prototype did.
  const [employees, setEmployees] = useState<Employee[]>(
    isEditor ? payload.employees : []
  );
  const [facets, setFacets] = useState({
    cats: payload.cats,
    depts: payload.depts,
    mgrs: payload.mgrs,
  });
  const datasetVersionRef = useRef(isEditor ? payload.datasetVersion : 0);
  const [dsBusy, setDsBusy] = useState(false);
  const [dsError, setDsError] = useState<string | null>(null);

  // ── edit mode ─────────────────────────────────────────────────────────────
  // One switch. Off, the dashboard is plain text and presentable; on, every
  // cell, heading, pool cap and column is typeable.
  const [editing, setEditing] = useState(false);
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

  // ── editor state: the overrides doc, persisted (debounced) to /api/state ──
  const [overrides, setOverrides] = useState<Overrides>(
    isEditor ? payload.overrides : {}
  );
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstRender = useRef(true);
  // set when the server hands us an overrides doc it has already persisted,
  // so the autosave effect doesn't POST it straight back
  const skipNextSave = useRef(false);
  // optimistic-concurrency token; a stale save gets a 409 instead of
  // silently overwriting a colleague's changes
  const versionRef = useRef(isEditor ? payload.overridesVersion : 0);

  useEffect(() => {
    if (!isEditor) return;
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (skipNextSave.current) {
      skipNextSave.current = false;
      return;
    }
    setSaveStatus("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: versionRef.current, overrides }),
        });
        if (res.status === 409) {
          alert(
            "Someone else saved changes since this page loaded. Reloading to pick up the latest figures — your last change was not saved."
          );
          window.location.reload();
          return;
        }
        if (res.ok) {
          const body = await res.json();
          if (typeof body.version === "number") versionRef.current = body.version;
          setSaveStatus("saved");
        } else {
          setSaveStatus("error");
        }
      } catch {
        setSaveStatus("error");
      }
    }, 500);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [overrides, isEditor, payload]);

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
  // 90% is the scheme default every row carries, so that's where this starts
  const [bulkIpm, setBulkIpm] = useState("90");

  /**
   * Send one change to the source dataset. Returns whether it stuck, so the
   * drawer knows whether to close. Errors surface next to the control that
   * caused them rather than in an alert.
   */
  async function patchDataset(patch: DatasetPatch): Promise<boolean> {
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
      datasetVersionRef.current = body.version;
      setEmployees(body.employees);
      setFacets({ cats: body.cats, depts: body.depts, mgrs: body.mgrs });
      // adding or removing someone reshuffles the filter lists; reset the
      // pickers to "everything" so nobody silently vanishes from the table
      setSelCats(body.cats);
      setSelDepts(body.depts);
      setSelMgrs(body.mgrs);
      if (body.overrides) {
        // the server pruned a removed person's entries and already saved
        // them — adopt its result without echoing it straight back
        skipNextSave.current = true;
        versionRef.current = body.overridesVersion ?? versionRef.current;
        setOverrides(body.overrides);
      }
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

  function updateCap(field: "vCap" | "nCap" | "gCap", raw: string) {
    const value = parseDaInput(raw);
    if (!value || value === params[field]) return;
    const next = { ...params, [field]: value };
    setParams(next);
    void saveConfig("params", next);
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

  /**
   * Edit mode forces the figures visible — you cannot type into `••••` — and
   * puts the mask back exactly as it was on the way out.
   */
  const maskBeforeEditing = useRef(false);
  function toggleEditing() {
    setEditing((wasEditing) => {
      if (!wasEditing) {
        maskBeforeEditing.current = showAll;
        setShowAll(true);
      } else {
        setShowAll(maskBeforeEditing.current);
        if (!maskBeforeEditing.current) setRevealedIds(new Set());
      }
      return !wasEditing;
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
      // edit mode keeps everything revealed; a stray Space must not re-mask
      if (editing) return;
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
  }, [editing]);

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
    if (!isEditor) return payload.rows;
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
      pkg: e.pkg,
      bp: e.bpEdit,
      ipm: e.ipmEdit,
      bipm: e.bipmCalc,
      calc: e.calcBonus,
      f25: e.f25,
      da: e.daEdit,
      yoy: e.finalBonus - e.f25,
      final: e.finalBonus,
    }));
  }, [isEditor, payload, emps]);

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
      editable: isEditor && OVERRIDE_EDITABLE.includes(c.key),
      dsEditable: isEditor && DATASET_EDITABLE.includes(c.key),
      format: c.format,
      decimals: c.decimals,
    }));
    const tools: TableColumn[] = isEditor
      ? [
        // the lock stays visible outside edit mode so you can still see who is
        // settled; only the pencil is an edit-mode affordance
        { key: "lock", label: "Lock", noSort: true },
        ...(editing ? [{ key: "edit", label: "", noSort: true }] : []),
      ]
      : [];
    return [...configured, ...tools];
  }, [isEditor, editing, columnConfig, payload]);

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

  function setOverride(id: string, patch: Overrides[string]) {
    setOverrides((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  function updatePercent(id: string, field: "bpEdit" | "ipmEdit", val: string) {
    const num = parsePercentInput(val);
    if (num === null) return;
    const emp = empById.get(id);
    if (!emp || emp.locked) return;
    setOverride(id, { [field]: num });
  }

  function updateDA(id: string, val: string) {
    let num = parseDaInput(val);
    const emp = empById.get(id);
    if (!emp || emp.locked || emp.sm || !pool) return;
    const maxDa = getMaxDA(emp, pool);
    if (num > maxDa) {
      num = maxDa;
      alert(
        `Discretionary Adjustment capped to ${fmt(maxDa)} — the maximum available within the pool cap.`
      );
    }
    setOverride(id, { daEdit: num });
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
   * Set one IPM across everyone currently shown — the walkthrough workflow is
   * "put the whole list on 100%, see what that does to the pool, then bring
   * individuals back down". Scoped to the visible rows, so the tab and filters
   * decide who it lands on; locked rows are left alone.
   *
   * One state update, so the existing debounce sends it as a single save.
   */
  function applyBulkIpm() {
    const pct = parsePercentInput(bulkIpm);
    if (pct === null) return;
    const targets = visibleRows.filter((r) => !r.locked);
    const skipped = visibleRows.length - targets.length;
    if (targets.length === 0) {
      setDsError("Nothing to apply to — every row shown is locked.");
      return;
    }
    const msg =
      `Set IPM to ${Math.round(pct * 100)}% for the ${targets.length} ` +
      `${targets.length === 1 ? "person" : "people"} currently shown?` +
      (skipped > 0 ? `\n\n${skipped} locked ${skipped === 1 ? "row is" : "rows are"} skipped.` : "") +
      `\n\nIndividuals can be adjusted afterwards, and a snapshot is taken first so this can be undone.`;
    if (!confirm(msg)) return;
    setOverrides((prev) => {
      const next = { ...prev };
      for (const r of targets) next[r.id] = { ...next[r.id], ipmEdit: pct };
      return next;
    });
  }

  function toggleLock(id: string) {
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
      setOverride(id, { locked: true, lockedFinal: emp.calcBonus });
    }
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
      // other state, no shared-services breakdown.
      return payload.poolCards.map((c) => {
        const remaining = c.available - c.stateBonuses;
        return (
          <PoolCard
            key={c.title}
            title={c.title}
            metrics={[
              { label: "Pool available", value: fmt(c.available) },
              { label: "Total allocated", value: fmt(c.stateBonuses), bold: true },
              {
                label: "Remaining to allocate",
                value: fmt(remaining),
                negative: remaining < 0,
              },
            ]}
            utilPct={c.utilPct}
          />
        );
      });
    }
    if (!pool) return null;
    const { vCap, nCap, gCap } = params;
    const vicTotal = emps.reduce((s, e) => s + getVicAlloc(e, pool.vicScale), 0);
    const nswTotal = emps.reduce((s, e) => s + getNswAlloc(e, pool.nswScale), 0);
    const groupTotal = emps.reduce((s, e) => s + e.finalBonus, 0);
    const sharedVic = emps
      .filter((e) => e.st === "SHARED")
      .reduce((s, e) => s + getVicAlloc(e, pool.vicScale), 0);
    const sharedNsw = emps
      .filter((e) => e.st === "SHARED")
      .reduce((s, e) => s + getNswAlloc(e, pool.nswScale), 0);

    const card = (
      which: "vic" | "nsw" | "group",
      capField: "vCap" | "nCap" | "gCap",
      title: string,
      cap: number,
      total: number,
      sharedDeduction: number | null
    ) => {
      const remain = cap - total;
      // The shared-services split only makes sense while looking at shared
      // services, so it is surfaced on that tab alone; every other tab shows
      // the plain cap / allocated / remaining the leads actually work against.
      const showShared = sharedDeduction !== null && activeTab === "SHARED";
      const metrics: PoolMetric[] = [
        // in edit mode the cap is typed here and everything above recalculates
        {
          label: "Pool cap",
          value: fmt(cap),
          ...(editing
            ? { onEdit: (raw: string) => updateCap(capField, raw), editValue: cap }
            : {}),
        },
        ...(showShared
          ? [
            { label: `${title.split(" ")[0]} bonuses`, value: fmt(total - sharedDeduction) },
            { label: "Shared services", value: fmt(sharedDeduction) },
          ]
          : []),
        { label: "Total allocated", value: fmt(total), bold: true },
        { label: "Remaining to allocate", value: fmt(remain), negative: remain < 0 },
      ];
      return (
        <PoolCard
          key={which}
          title={title}
          titleNode={
            <EditableText
              value={title}
              editing={editing}
              disabled={dsBusy}
              label={`${which} pool card title`}
              maxLength={40}
              onCommit={(next) =>
                updateCopy({ poolTitles: { ...copy.poolTitles, [which]: next } })
              }
              inputClassName="w-[190px]"
            />
          }
          metrics={metrics}
          utilPct={total / cap}
          busy={dsBusy}
        />
      );
    };

    const t = copy.poolTitles;
    return [
      card("vic", "vCap", t.vic, vCap, vicTotal, sharedVic),
      card("nsw", "nCap", t.nsw, nCap, nswTotal, sharedNsw),
      card("group", "gCap", t.group, gCap, groupTotal, null),
    ];
    // updateCap/updateCopy are recreated every render and would defeat the
    // memo; they only ever read the same `params`/`copy` already listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditor, payload, emps, pool, params, copy, editing, dsBusy, activeTab]);

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
      <div className="sticky top-0 z-40 flex items-center justify-between bg-[#191919] px-6 py-3">
        <div className="flex items-center">
          <TexcoX className="mr-2.5 h-[22px] w-[22px] shrink-0" />
          <TexcoWordmark className="mr-4 h-[18px] w-auto shrink-0" />
          <EditableText
            value={copy.schemeName}
            editing={editing}
            disabled={dsBusy}
            label="Scheme name"
            onCommit={(schemeName) => updateCopy({ schemeName })}
            className="hidden text-xs font-medium text-[#FC4D0F] sm:inline"
            inputClassName="w-[280px]"
          />
        </div>
        <div className="flex items-center gap-3">
          {isEditor && (
            <span className="text-[11px] text-[#F79470]">
              {saveStatus === "saving" && "Saving…"}
              {saveStatus === "saved" && "All changes saved"}
              {saveStatus === "error" && "⚠ Save failed — retrying on next change"}
            </span>
          )}
          <span className="text-right text-xs leading-tight text-[#F79470]">
            {payload.user.name}
            <br />
            <span className="text-[10px] opacity-80">{payload.user.scopeLabel}</span>
          </span>
          {!editing && (
            <button
              type="button"
              onClick={toggleShowAll}
              className="border border-[#FC4D0F]/50 px-3.5 py-1.5 text-[11px] font-semibold tracking-wide text-[#F79470] transition-colors hover:bg-[#FC4D0F] hover:text-white"
              title="Or press Space"
            >
              {showAll ? "Hide everything" : "Show everything"}
            </button>
          )}
          {isEditor && (
            <button
              type="button"
              onClick={toggleEditing}
              className={`px-3.5 py-1.5 text-[11px] font-bold tracking-wide transition-colors ${
                editing
                  ? "bg-[#FC4D0F] text-white hover:bg-[#e0440d]"
                  : "border border-[#FC4D0F]/50 text-[#F79470] hover:bg-[#FC4D0F] hover:text-white"
              }`}
              title={
                editing
                  ? "Finish editing and go back to the clean view"
                  : "Edit figures, names, columns and headings in place"
              }
            >
              {editing ? "Done editing" : "Edit mode"}
            </button>
          )}
          {isEditor && !editing && (
            <Link
              href="/admin"
              className="border border-[#FC4D0F]/50 px-3.5 py-1.5 text-[11px] font-semibold tracking-wide text-[#F79470] transition-colors hover:bg-[#FC4D0F] hover:text-white"
            >
              Admin
            </Link>
          )}
          <button
            type="button"
            onClick={() => signOut({ callbackUrl:"/login" })}
            className="border border-[#FC4D0F]/50 px-3.5 py-1.5 text-[11px] font-semibold tracking-wide text-[#F79470] transition-colors hover:bg-[#FC4D0F] hover:text-white"
          >
            Logout
          </button>
        </div>
      </div>

      {/* Status banner — editable in place, and switchable off once final */}
      {(copy.bannerVisible || editing) && (
        <div
          className={`px-6 py-1.5 text-center text-xs font-bold text-white ${
            copy.bannerVisible ? "bg-[#FC4D0F]" : "bg-neutral-400"
          }`}
        >
          <EditableText
            value={copy.bannerText}
            editing={editing}
            disabled={dsBusy}
            label="Status banner"
            onCommit={(bannerText) => updateCopy({ bannerText })}
            inputClassName="w-[320px] text-center"
          />
          {editing && (
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

      <div className="mx-auto w-full max-w-[1600px] flex-1 px-5 py-4">
        {/* Tabs (editors only, like the prototype master view) */}
        {isEditor && (
          <div className="mb-4 flex gap-1">
            {(["ALL", "VIC", "NSW", "SHARED", "HISTORY"] as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => openTab(t)}
                className={`-md px-5 py-2 text-xs font-bold tracking-wide transition-colors ${activeTab === t
                    ? "bg-[#FC4D0F] text-white"
                    : "bg-neutral-200 text-[#5C5C5C] hover:bg-neutral-300"
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
                className="border border-neutral-300 px-3 py-1 text-[11px] font-semibold text-[#5C5C5C] transition-colors hover:border-[#FC4D0F] hover:text-[#FC4D0F] disabled:opacity-40"
              >
                {historyLoading ? "Loading…" : "Refresh"}
              </button>
            </div>
            <div className="max-h-[calc(100vh-240px)] overflow-auto">
              {history === null || historyLoading ? (
                <div className="px-4 py-8 text-center text-[13px] text-[#5C5C5C]">
                  Loading…
                </div>
              ) : history.length === 0 ? (
                <div className="px-4 py-8 text-center text-[13px] text-[#5C5C5C]">
                  No changes recorded yet.
                </div>
              ) : (
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr>
                      {["When", "Who", "What"].map((h) => (
                        <th
                          key={h}
                          className="sticky top-0 whitespace-nowrap bg-[#191919] px-3 py-2.5 text-left text-[11px] tracking-wide text-white"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h, i) => (
                      <tr key={i} className="border-b border-neutral-100 hover:bg-neutral-50">
                        <td className="whitespace-nowrap px-3 py-2 tabular-nums text-[#5C5C5C]">
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
              <div className="mb-4 flex items-start justify-between gap-4 border-2 border-[#FC4D0F] bg-[#FED9CC] px-4 py-2 text-[13px] font-semibold">
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
              className="sticky z-30 -mx-5 mb-4 flex flex-wrap gap-4 bg-[#f5f5f5] px-5 pb-4 pt-1"
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
                className="w-full border-2 border-neutral-200 px-3.5 py-2 text-[13px] outline-none focus:border-[#FC4D0F] sm:w-[220px]"
              />
              <MultiSelect label="Roles" items={facets.cats} selected={selCats} onChange={setSelCats} />
              <MultiSelect label="Departments" items={facets.depts} selected={selDepts} onChange={setSelDepts} />
              <MultiSelect label="Managers" items={facets.mgrs} selected={selMgrs} onChange={setSelMgrs} />
              {editing && (
                <>
                  <ColumnMenu
                    config={columnConfig}
                    onChange={applyColumnConfig}
                    busy={dsBusy}
                  />
                  {/* Bulk IPM: set the whole visible list at once, then bring
                      individuals down. */}
                  <div className="flex items-center gap-1.5 border-2 border-neutral-200 px-2.5 py-1 text-[11px] font-semibold text-[#5C5C5C]">
                    Set IPM for the {visibleRows.length} shown
                    <input
                      type="text"
                      value={bulkIpm}
                      disabled={dsBusy}
                      aria-label="Bulk IPM percentage"
                      onChange={(e) => setBulkIpm(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && applyBulkIpm()}
                      className="w-[52px] border border-neutral-300 px-1.5 py-1 text-right tabular-nums outline-none focus:border-[#FC4D0F]"
                    />
                    %
                    <button
                      type="button"
                      disabled={dsBusy}
                      onClick={applyBulkIpm}
                      className="ml-1 bg-[#FC4D0F] px-2.5 py-1 font-bold text-white transition-colors hover:bg-[#e0440d] disabled:opacity-40"
                    >
                      Apply
                    </button>
                  </div>
                  {/* Informational only, per the walkthrough: it scales every
                      After-IPM figure, so it is not something to nudge from
                      here. It changes with the scheme, not with an allocation. */}
                  <span
                    className="flex items-center gap-1.5 border-2 border-neutral-200 px-2.5 py-1 text-[11px] font-semibold text-[#5C5C5C]"
                    title="Scales every After-IPM figure. 1 = no change."
                  >
                    Company modifier
                    <span className="tabular-nums text-[#191919]">
                      {params.companyModifier}
                    </span>
                  </span>
                </>
              )}
              <div className="ml-auto flex items-center gap-3 text-xs text-[#5C5C5C]">
                <span className="bg-neutral-100 px-2.5 py-1">
                  Showing: {visibleRows.length} / {allRows.length}
                </span>
                {typeof totFinal === "number" && (
                  <span className="bg-neutral-100 px-2.5 py-1">
                    Total bonuses: {fmt(totFinal)}
                  </span>
                )}
              </div>
            </div>

            <EmployeeTable
              columns={columns}
              rows={visibleRows}
              totals={totals}
              editing={editing}
              busy={dsBusy}
              showAll={showAll}
              isRevealed={isRevealed}
              toggleRow={toggleRow}
              sortCol={sortCol}
              sortDir={sortDir}
              onSort={doSort}
              handlers={{
                updatePercent,
                updateDA,
                updateDatasetFigure,
                toggleLock,
                renameColumn,
              }}
            />
          </>
        )}
      </div>

      <footer className="border-t-2 border-[#FC4D0F] bg-white px-6 py-3.5 text-center text-[11px] tracking-wide text-[#5C5C5C]">
        <EditableText
          value={copy.footerText}
          editing={editing}
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
          disabled={importOpen || dsBusy}
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
            <div className="mb-3 border-2 border-[#FC4D0F] bg-[#FED9CC] px-4 py-2 text-[13px] font-semibold">
              {importFlow.fatal}
            </div>
          )}

          {importFlow.stage.step === "checking" && (
            <div className="bg-white px-5 py-8 text-center text-[13px] text-[#5C5C5C] shadow-sm">
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
            <div className="border-t-4 border-[#FC4D0F] bg-white p-5 shadow-sm">
              <h3 className="mb-2 text-[13px] font-bold">
                Import applied
              </h3>
              <p className="mb-4 text-[13px]">
                {importFlow.stage.preview.rowCount} employees imported (
                {importFlow.stage.preview.added.length} added,{""}
                {importFlow.stage.preview.removed.length} removed). Total pool:{""}
                {fmt(importFlow.stage.preview.totalAfter)}. It can be undone from{""}
                <Link href="/admin/snapshots" className="font-semibold text-[#FC4D0F] underline">
                  Snapshots
                </Link>
                .
              </p>
              <button
                type="button"
                onClick={closeImport}
                className="bg-[#FC4D0F] px-6 py-2.5 text-[12px] font-bold text-white hover:bg-[#e0440d]"
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
