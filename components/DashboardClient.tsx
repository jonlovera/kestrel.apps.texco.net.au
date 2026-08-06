"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import type { DashboardPayload, ScopedRow } from "@/lib/payload-types";
import { NUMERIC_FIELDS, type NumericField } from "@/lib/access-types";
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
import { fmt, fmtValue } from "@/lib/fmt";
import type { ColumnFormat } from "@/lib/columns";
import { TexcoX, TexcoWordmark } from "./TexcoBrand";
import { PoolCard, type PoolMetric } from "./PoolCard";
import { MultiSelect } from "./MultiSelect";
import EmployeeEditor from "./EmployeeEditor";
import Dropzone from "./Dropzone";
import {
  useImportFlow,
  ImportErrors,
  ImportPreview,
  ImportModal,
} from "./ImportFlow";

type Tab = "ALL" | "VIC" | "NSW" | "SHARED" | "HISTORY";
type SaveStatus = "idle" | "saving" | "saved" | "error";

/** Which columns an editor can type into, and down which write path. */
const OVERRIDE_EDITABLE = ["bp", "ipm", "da"];
const DATASET_EDITABLE = ["pkg", "bipm", "f25"];

interface Column {
  key: string;
  label: string;
  num?: boolean;
  /** editable via the overrides doc (manager judgement, survives imports) */
  editable?: boolean;
  /** editable via the dataset doc (payroll fact, replaced by an import) */
  dsEditable?: boolean;
  noSort?: boolean;
  format?: ColumnFormat;
  decimals?: number;
}

/** Unified row shape the table renders, for both modes. */
interface DisplayRow extends ScopedRow {
  vp?: number;
  np?: number;
}

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
  const [drawer, setDrawer] = useState<
    { kind: "add" } | { kind: "edit"; id: string } | null
  >(null);

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
    const p = computeScalesAndBonuses(e, payload.caps);
    return { emps: e, pool: p };
  }, [isEditor, payload, employees, overrides]);

  // ── shared UI state ──
  const [activeTab, setActiveTab] = useState<Tab>("ALL");
  const [search, setSearch] = useState("");
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState(1);
  const [selCats, setSelCats] = useState<string[]>(payload.cats);
  const [selDepts, setSelDepts] = useState<string[]>(payload.depts);
  const [selMgrs, setSelMgrs] = useState<string[]>(payload.mgrs);

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
    if (!isEditor) return payload.rows;
    return emps.map((e) => ({
      id: e.id,
      name: `${e.gn} ${e.sn}`,
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
  const columns: Column[] = useMemo(() => {
    const identity: Column[] = [{ key: "name", label: "Name" }];
    if (isEditor || payload.showStateColumn)
      identity.push({ key: "state", label: "State" });
    identity.push(
      { key: "pos", label: "Position" },
      { key: "dept", label: "Department" },
      { key: "mgr", label: "Manager" }
    );
    // Display columns come from the server payload: presentation-config
    // visible AND scope-visible, in the configured order.
    const numeric: Column[] = payload.columns.map((c) => ({
      key: c.key,
      label: c.label,
      num: true,
      editable: isEditor && OVERRIDE_EDITABLE.includes(c.key),
      dsEditable: isEditor && DATASET_EDITABLE.includes(c.key),
      format: c.format,
      decimals: c.decimals,
    }));
    const tools: Column[] = isEditor
      ? [
          { key: "lock", label: "Lock", noSort: true },
          { key: "edit", label: "", noSort: true },
        ]
      : [];
    return [...identity, ...numeric, ...tools];
  }, [isEditor, payload]);

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

  /** One source-dataset figure, edited in the table. No-ops if unchanged. */
  function updateDatasetFigure(
    id: string,
    field: "pkg" | "bipm" | "f25",
    current: number,
    raw: string
  ) {
    const next = parseDaInput(raw); // same lenient "$1,234" parsing
    if (Math.round(next) === Math.round(current)) return;
    void patchDataset({ op: "field", id, field, value: next });
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
  const totals = useMemo(() => {
    const t: Partial<Record<NumericField, number>> = {};
    for (const { key } of payload.columns) {
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
      return payload.poolCards.map((c) => (
        <PoolCard
          key={c.title}
          title={c.title}
          metrics={[
            { label: "State bonuses", value: fmt(c.stateBonuses), bold: true },
          ]}
          utilPct={c.utilPct}
          scaleFactor={c.scale ?? null}
          scaleLabel={c.scaleLabel}
        />
      ));
    }
    if (!pool) return null;
    const { vCap, nCap, gCap } = payload.caps;
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
      title: string,
      cap: number,
      total: number,
      sharedDeduction: number | null,
      scale: number | null,
      scaleLabel: string | null
    ) => {
      const remain = cap - total;
      const metrics: PoolMetric[] = [
        { label: "Pool cap", value: fmt(cap) },
        ...(sharedDeduction !== null
          ? [
              { label: `${title.split(" ")[0]} bonuses`, value: fmt(total - sharedDeduction) },
              { label: "Shared svc deduction", value: fmt(sharedDeduction) },
            ]
          : [{ label: "Total bonuses", value: fmt(total), bold: true }]),
        ...(sharedDeduction !== null
          ? [{ label: "Total allocated", value: fmt(total), bold: true }]
          : []),
        { label: "Remaining", value: fmt(remain), negative: remain < 0 },
      ];
      return (
        <PoolCard
          key={title}
          title={title}
          metrics={metrics}
          utilPct={total / cap}
          scaleFactor={scale}
          scaleLabel={scaleLabel ?? undefined}
        />
      );
    };

    const t = payload.copy.poolTitles;
    return [
      // scale figure is gated by the 'scale' pseudo-column config
      card(t.vic, vCap, vicTotal, sharedVic, payload.showScale ? pool.vicScale : null, "VIC scale factor"),
      card(t.nsw, nCap, nswTotal, sharedNsw, payload.showScale ? pool.nswScale : null, "NSW scale factor"),
      card(t.group, gCap, groupTotal, null, null, null),
    ];
  }, [isEditor, payload, emps, pool]);

  function doSort(key: string) {
    if (sortCol === key) setSortDir((d) => -d);
    else {
      setSortCol(key);
      setSortDir(1);
    }
  }

  // ── cell rendering ──
  /** display a value using the column's configured format */
  function show(c: Column, v: number) {
    return fmtValue(c.format ?? "currency", c.decimals ?? 0, v);
  }

  function cell(r: DisplayRow, c: Column) {
    // privacy mask: numeric figures hidden until the row (or everything) is
    // revealed; the "—" placeholders reveal nothing and stay as-is
    if (
      (NUMERIC_FIELDS as readonly string[]).includes(c.key) &&
      !isRevealed(r.id)
    ) {
      if (c.key === "da" && (r.sm || !r.inPool))
        return <span className="text-neutral-300">—</span>;
      return <span className="select-none text-neutral-300">••••</span>;
    }
    switch (c.key) {
      case "name":
        return r.name;
      case "state": {
        const cls =
          r.st === "VIC"
            ? "bg-[#FED9CC] text-[#FC4D0F]"
            : r.st === "NSW"
              ? "bg-[#3D3D3D] text-white"
              : "bg-[#FDA478] text-white";
        return (
          <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-bold ${cls}`}>
            {r.st}
          </span>
        );
      }
      case "pos":
        return r.pos;
      case "dept":
        return r.dept;
      case "mgr":
        return r.mgr;
      case "pkg":
        // a package edit carries After IPM with it, pro rata — see
        // scaledBipm() in lib/dataset-edit.ts for why
        if (!c.dsEditable || r.locked) return show(c, r.pkg!);
        return moneyInput(r, "pkg", r.pkg!, 90);
      case "bp":
      case "ipm": {
        const v = c.key === "bp" ? r.bp! : r.ipm!;
        if (!c.editable || r.locked) return show(c, v);
        // Input parsing stays semantic (percent-style, "90" means 90%)
        // regardless of the configured display format.
        return (
          <input
            key={`${r.id}-${c.key}-${v}`}
            type="text"
            defaultValue={`${Math.round(v * 100)}%`}
            onFocus={(e) => e.target.select()}
            onBlur={(e) =>
              updatePercent(r.id, c.key === "bp" ? "bpEdit" : "ipmEdit", e.target.value)
            }
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            className="w-[55px] rounded border border-neutral-300 px-1.5 py-1 text-right text-xs tabular-nums outline-none focus:border-[#FC4D0F]"
          />
        );
      }
      case "bipm":
        if (!c.dsEditable || r.locked) return show(c, r.bipm!);
        return moneyInput(r, "bipm", r.bipm!, 85);
      case "calc":
        return show(c, r.calc!);
      case "f25":
        // last year's figure: a fact, unaffected by this year's lock
        if (!c.dsEditable) return <span className="text-neutral-400">{show(c, r.f25!)}</span>;
        return moneyInput(r, "f25", r.f25!, 85);
      case "da": {
        if (r.sm || !r.inPool) return <span className="text-neutral-300">—</span>;
        if (!c.editable || r.locked) return show(c, r.da!);
        return (
          <input
            key={`${r.id}-da-${r.da}`}
            type="text"
            defaultValue={Math.round(r.da!)}
            onFocus={(e) => e.target.select()}
            onBlur={(e) => updateDA(r.id, e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            className="w-[80px] rounded border border-neutral-300 px-1.5 py-1 text-right text-xs tabular-nums outline-none focus:border-[#FC4D0F]"
          />
        );
      }
      case "yoy": {
        const v = r.yoy!;
        const color = v > 0 ? "text-[#191919]" : v < 0 ? "text-[#FC4D0F]" : "";
        return <span className={color}>{show(c, v)}</span>;
      }
      case "final":
        return <span className="font-bold">{show(c, r.final!)}</span>;
      case "lock": {
        if (r.sm)
          return (
            <span
              title="Site Manager — fixed bonus, not subject to redistribution"
              className="cursor-help text-sm"
            >
              —
            </span>
          );
        return (
          <button
            type="button"
            onClick={() => toggleLock(r.id)}
            className={`h-7 w-7 rounded border-[1.5px] text-sm transition-colors ${
              r.locked
                ? "border-[#FC4D0F] bg-[#FC4D0F]"
                : "border-neutral-300 bg-transparent hover:border-[#FC4D0F]"
            }`}
          >
            {r.locked ? "🔒" : "🔓"}
          </button>
        );
      }
      case "edit":
        return (
          <button
            type="button"
            title={`Edit ${r.name}'s pool split, site-manager flag, or remove them`}
            disabled={dsBusy}
            onClick={() => {
              setDsError(null);
              setDrawer({ kind: "edit", id: r.id });
            }}
            className="h-7 w-7 rounded border-[1.5px] border-neutral-300 text-sm transition-colors hover:border-[#FC4D0F] disabled:opacity-40"
          >
            ✎
          </button>
        );
      default:
        return null;
    }
  }

  /**
   * A dollar figure that writes straight to the source dataset on blur. Keyed
   * on the value so a server-side correction (or a rejected edit) snaps the
   * box back to the truth.
   */
  function moneyInput(
    r: DisplayRow,
    field: "pkg" | "bipm" | "f25",
    value: number,
    width: number
  ) {
    return (
      <input
        key={`${r.id}-${field}-${value}`}
        type="text"
        defaultValue={Math.round(value)}
        disabled={dsBusy}
        onFocus={(e) => e.target.select()}
        onBlur={(e) => updateDatasetFigure(r.id, field, value, e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        style={{ width }}
        className="rounded border border-neutral-300 px-1.5 py-1 text-right text-xs tabular-nums outline-none focus:border-[#FC4D0F] disabled:opacity-50"
      />
    );
  }

  const totFinal = totals.final;

  return (
    <div className="flex min-h-screen flex-col">
      {/* Top bar */}
      <div className="sticky top-0 z-40 flex items-center justify-between bg-[#191919] px-6 py-3">
        <div className="flex items-center">
          <TexcoX className="mr-2.5 h-[22px] w-[22px] shrink-0" />
          <TexcoWordmark className="mr-4 h-[18px] w-auto shrink-0" />
          <span className="hidden text-xs font-medium uppercase tracking-[2px] text-[#FC4D0F] sm:inline">
            {payload.copy.schemeName}
          </span>
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
          <button
            type="button"
            onClick={toggleShowAll}
            className="rounded border border-[#FC4D0F]/50 px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#F79470] transition-colors hover:bg-[#FC4D0F] hover:text-white"
            title="Or press Space"
          >
            {showAll ? "Hide everything" : "Show everything"}
          </button>
          {isEditor && (
            <Link
              href="/admin"
              className="rounded border border-[#FC4D0F]/50 px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#F79470] transition-colors hover:bg-[#FC4D0F] hover:text-white"
            >
              Manage access
            </Link>
          )}
          <button
            type="button"
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="rounded border border-[#FC4D0F]/50 px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#F79470] transition-colors hover:bg-[#FC4D0F] hover:text-white"
          >
            Logout
          </button>
        </div>
      </div>

      {/* Status banner */}
      {payload.copy.bannerVisible && (
        <div className="bg-[#FC4D0F] px-6 py-1.5 text-center text-xs font-bold uppercase tracking-[2px] text-white">
          {payload.copy.bannerText}
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
                className={`rounded-t-md px-5 py-2 text-xs font-bold uppercase tracking-wide transition-colors ${
                  activeTab === t
                    ? "bg-[#FC4D0F] text-white"
                    : "bg-neutral-200 text-[#5C5C5C] hover:bg-neutral-300"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        )}

        {activeTab === "HISTORY" ? (
          <div className="mb-5 rounded-lg bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-3">
              <h2 className="text-[13px] font-bold uppercase tracking-[1.5px]">
                Change history
              </h2>
              <button
                type="button"
                disabled={historyLoading}
                onClick={fetchHistory}
                className="rounded border border-neutral-300 px-3 py-1 text-[11px] font-semibold uppercase text-[#5C5C5C] transition-colors hover:border-[#FC4D0F] hover:text-[#FC4D0F] disabled:opacity-40"
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
                          className="sticky top-0 whitespace-nowrap bg-[#191919] px-3 py-2.5 text-left text-[11px] uppercase tracking-wide text-white"
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
                            <span className="mr-2 inline-block rounded bg-neutral-200 px-1.5 py-px text-[10px] font-bold uppercase text-neutral-600">
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
        {isEditor && dsError && !drawer && (
          <div className="mb-4 flex items-start justify-between gap-4 rounded-md border-2 border-[#FC4D0F] bg-[#FED9CC] px-4 py-2 text-[13px] font-semibold">
            <span>{dsError}</span>
            <button
              type="button"
              onClick={() => setDsError(null)}
              className="shrink-0 text-[11px] uppercase tracking-wide underline"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Pool cards */}
        <div className="mb-4 flex flex-wrap gap-4">{poolCardEls}</div>

        {/* Controls */}
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search employees..."
            className="w-full rounded-md border-2 border-neutral-200 px-3.5 py-2 text-[13px] outline-none focus:border-[#FC4D0F] sm:w-[220px]"
          />
          <MultiSelect label="Roles" items={facets.cats} selected={selCats} onChange={setSelCats} />
          <MultiSelect label="Departments" items={facets.depts} selected={selDepts} onChange={setSelDepts} />
          <MultiSelect label="Managers" items={facets.mgrs} selected={selMgrs} onChange={setSelMgrs} />
          {isEditor && (
            <button
              type="button"
              disabled={dsBusy}
              onClick={() => {
                setDsError(null);
                setDrawer({ kind: "add" });
              }}
              className="rounded-md border-2 border-[#FC4D0F] px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-wide text-[#FC4D0F] transition-colors hover:bg-[#FC4D0F] hover:text-white disabled:opacity-40"
            >
              + Add person
            </button>
          )}
          <div className="ml-auto flex items-center gap-3 text-xs text-[#5C5C5C]">
            <span className="rounded bg-neutral-100 px-2.5 py-1">
              Showing: {visibleRows.length} / {allRows.length}
            </span>
            {typeof totFinal === "number" && (
              <span className="rounded bg-neutral-100 px-2.5 py-1">
                Total bonuses: {fmt(totFinal)}
              </span>
            )}
          </div>
        </div>

        {/* Table */}
        <div className="mb-5 max-h-[calc(100vh-260px)] overflow-auto rounded-lg shadow-sm">
          <table className="w-full border-collapse bg-white text-xs">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th
                    key={c.key}
                    onClick={c.noSort ? undefined : () => doSort(c.key)}
                    className={`sticky top-0 z-10 whitespace-nowrap bg-[#191919] px-2 py-2.5 text-left text-[11px] uppercase tracking-wide text-white select-none ${
                      c.noSort ? "" : "cursor-pointer hover:bg-[#333]"
                    } ${c.num ? "text-right" : ""}`}
                  >
                    {c.label}
                    {sortCol === c.key && (
                      <span className="ml-1 text-[10px]">{sortDir === 1 ? "▲" : "▼"}</span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r) => (
                <tr
                  key={r.id}
                  className="group cursor-pointer"
                  title="Click to show/hide this row's figures"
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("input,button,a,select,label"))
                      return;
                    toggleRow(r.id);
                  }}
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={`whitespace-nowrap border-b border-neutral-100 px-2 py-2 group-hover:bg-neutral-50 ${
                        c.num ? "text-right tabular-nums" : ""
                      } ${c.key === "final" ? "bg-[#E7D8FC]" : c.key === "f25" ? "bg-[#f7f7f7]" : ""}`}
                    >
                      {cell(r, c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                {columns.map((c) => {
                  // percentages don't sum meaningfully — no total for them
                  const v =
                    c.key === "name"
                      ? `TOTALS (${visibleRows.length})`
                      : c.format === "percent"
                        ? ""
                        : (typeof totals[c.key as NumericField] === "number"
                            ? showAll
                              ? show(c, totals[c.key as NumericField]!)
                              : "••••••"
                            : "");
                  return (
                    <td
                      key={c.key}
                      className={`whitespace-nowrap px-2 py-2 text-[13px] font-bold text-white ${
                        c.num ? "text-right tabular-nums" : ""
                      } ${c.key === "final" ? "bg-[#7c3aed]" : "bg-[#FC4D0F]"}`}
                    >
                      {v}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          </table>
        </div>
          </>
        )}
      </div>

      <footer className="border-t-2 border-[#FC4D0F] bg-white px-6 py-3.5 text-center text-[11px] tracking-wide text-[#5C5C5C]">
        {payload.copy.footerText}
      </footer>

      {/* Editors can drop a spreadsheet anywhere on the dashboard. The preview
          still stands between the file and the data. */}
      {isEditor && (
        <Dropzone
          onFile={(file) => {
            setImportOpen(true);
            void importFlow.check(file);
          }}
          disabled={importOpen || dsBusy || drawer !== null}
          label="Drop the spreadsheet to update the figures"
        />
      )}

      {isEditor && importOpen && (
        <ImportModal
          closable={!importFlow.busy}
          onClose={closeImport}
        >
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[13px] font-bold uppercase tracking-[1.5px] text-white">
              Import employee data
            </h2>
            <button
              type="button"
              disabled={importFlow.busy}
              onClick={closeImport}
              className="rounded border border-white/40 px-3 py-1 text-[11px] font-semibold uppercase text-white hover:bg-white/10 disabled:opacity-40"
            >
              Close
            </button>
          </div>

          {importFlow.fatal && (
            <div className="mb-3 rounded-md border-2 border-[#FC4D0F] bg-[#FED9CC] px-4 py-2 text-[13px] font-semibold">
              {importFlow.fatal}
            </div>
          )}

          {importFlow.stage.step === "checking" && (
            <div className="rounded-lg bg-white px-5 py-8 text-center text-[13px] text-[#5C5C5C] shadow-sm">
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
            <div className="rounded-lg border-t-4 border-[#FC4D0F] bg-white p-5 shadow-sm">
              <h3 className="mb-2 text-[13px] font-bold uppercase tracking-[1.5px]">
                Import applied
              </h3>
              <p className="mb-4 text-[13px]">
                {importFlow.stage.preview.rowCount} employees imported (
                {importFlow.stage.preview.added.length} added,{" "}
                {importFlow.stage.preview.removed.length} removed). Total pool:{" "}
                {fmt(importFlow.stage.preview.totalAfter)}. It can be undone from{" "}
                <Link href="/admin/snapshots" className="font-semibold text-[#FC4D0F] underline">
                  Snapshots
                </Link>
                .
              </p>
              <button
                type="button"
                onClick={closeImport}
                className="rounded-md bg-[#FC4D0F] px-6 py-2.5 text-[12px] font-bold uppercase tracking-[2px] text-white hover:bg-[#e0440d]"
              >
                Show updated figures
              </button>
            </div>
          )}
        </ImportModal>
      )}

      {isEditor && drawer && (
        <EmployeeEditor
          mode={
            drawer.kind === "add"
              ? { kind: "add" }
              : { kind: "edit", employee: empById.get(drawer.id)! }
          }
          cats={facets.cats}
          depts={facets.depts}
          mgrs={facets.mgrs}
          busy={dsBusy}
          error={dsError}
          onSubmit={patchDataset}
          onClose={() => {
            setDrawer(null);
            setDsError(null);
          }}
        />
      )}
    </div>
  );
}
