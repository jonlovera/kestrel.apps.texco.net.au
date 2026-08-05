"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import type { DashboardPayload, ScopedRow } from "@/lib/payload-types";
import { NUMERIC_FIELDS, type NumericField } from "@/lib/access-types";
import type { Overrides, HistoryEntry } from "@/lib/schema";
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

type Tab = "ALL" | "VIC" | "NSW" | "SHARED" | "HISTORY";
type SaveStatus = "idle" | "saving" | "saved" | "error";

interface Column {
  key: string;
  label: string;
  num?: boolean;
  editable?: boolean;
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

  // ── editor state: the overrides doc, persisted (debounced) to /api/state ──
  const [overrides, setOverrides] = useState<Overrides>(
    isEditor ? payload.overrides : {}
  );
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstRender = useRef(true);
  // optimistic-concurrency token; a stale save gets a 409 instead of
  // silently overwriting a colleague's changes
  const versionRef = useRef(isEditor ? payload.overridesVersion : 0);

  useEffect(() => {
    if (!isEditor) return;
    if (firstRender.current) {
      firstRender.current = false;
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
    const e = applyOverrides(payload.employees, overrides);
    const p = computeScalesAndBonuses(e, payload.caps);
    return { emps: e, pool: p };
  }, [isEditor, payload, overrides]);

  // ── shared UI state ──
  const [activeTab, setActiveTab] = useState<Tab>("ALL");
  const [search, setSearch] = useState("");
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState(1);
  const [selCats, setSelCats] = useState<string[]>(payload.cats);
  const [selDepts, setSelDepts] = useState<string[]>(payload.depts);
  const [selMgrs, setSelMgrs] = useState<string[]>(payload.mgrs);

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
      editable: isEditor && ["bp", "ipm", "da"].includes(c.key),
      format: c.format,
      decimals: c.decimals,
    }));
    const lock: Column[] = isEditor
      ? [{ key: "lock", label: "Lock", noSort: true }]
      : [];
    return [...identity, ...numeric, ...lock];
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
    const catAll = selCats.length === payload.cats.length;
    if (!catAll) list = list.filter((r) => selCats.includes(r.cat));
    const deptAll = selDepts.length === payload.depts.length;
    if (!deptAll) list = list.filter((r) => selDepts.includes(r.dept));
    const mgrAll = selMgrs.length === payload.mgrs.length;
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
  }, [allRows, isEditor, activeTab, search, selCats, selDepts, selMgrs, sortCol, sortDir, payload]);

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

    return [
      // scale figure is gated by the 'scale' pseudo-column config
      card("VIC pool", vCap, vicTotal, sharedVic, payload.showScale ? pool.vicScale : null, "VIC scale factor"),
      card("NSW pool", nCap, nswTotal, sharedNsw, payload.showScale ? pool.nswScale : null, "NSW scale factor"),
      card("Group total", gCap, groupTotal, null, null, null),
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
        return show(c, r.pkg!);
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
        return show(c, r.bipm!);
      case "calc":
        return show(c, r.calc!);
      case "f25":
        return <span className="text-neutral-400">{show(c, r.f25!)}</span>;
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
      default:
        return null;
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
          <span className="hidden text-xs font-medium uppercase tracking-[2px] text-[#FC4D0F] sm:inline">
            FY26 Employee Bonus Scheme
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

      {/* Draft banner */}
      <div className="bg-[#FC4D0F] px-6 py-1.5 text-center text-xs font-bold uppercase tracking-[2px] text-white">
        Draft — not final
      </div>

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
          <MultiSelect label="Roles" items={payload.cats} selected={selCats} onChange={setSelCats} />
          <MultiSelect label="Departments" items={payload.depts} selected={selDepts} onChange={setSelDepts} />
          <MultiSelect label="Managers" items={payload.mgrs} selected={selMgrs} onChange={setSelMgrs} />
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
        texco &ensp;|&ensp; FY26 Employee Bonus Scheme &ensp;|&ensp; Confidential
        &ensp;|&ensp; Innovate. Design. Deliver.
      </footer>
    </div>
  );
}
