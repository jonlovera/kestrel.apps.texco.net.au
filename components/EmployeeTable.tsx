"use client";

import { useState } from "react";
import { NUMERIC_FIELDS, type NumericField } from "@/lib/access-types";
import { isDaEditable, isLockable } from "@/lib/calc";
import type { DisplayRow } from "@/lib/payload-types";
import type { ColumnFormat } from "@/lib/columns";
import { fmtValue } from "@/lib/fmt";

/**
 * The dashboard table: headers, cells, totals.
 *
 * Presentational — it owns no data. Every edit is handed straight back through
 * `handlers`, and which cells are editable is decided by the column flags the
 * orchestrator passes in — there is no separate edit mode any more: a cell
 * renders as an input whenever it's permitted (`editable`/`dsEditable`), not
 * locked, and its row is revealed. Masked (unrevealed) figures still render
 * as plain "••••" with no input at all, which is what keeps the dashboard
 * presentable on a shared screen until a row is clicked open.
 */

export interface TableColumn {
  key: string;
  label: string;
  num?: boolean;
  /** overrides doc: Bonus %, IPM %, Disc adj */
  editable?: boolean;
  /** dataset doc: After IPM only — everything else comes from the spreadsheet */
  dsEditable?: boolean;
  noSort?: boolean;
  format?: ColumnFormat;
  decimals?: number;
}

export interface TableHandlers {
  updateDA: (id: string, val: string) => void;
  updateIPM: (id: string, current: number, raw: string) => void;
  updateDatasetFigure: (id: string, current: number, raw: string) => void;
  updateSplit: (id: string, field: "vp" | "np", current: number, raw: string) => void;
  toggleLock: (id: string) => void;
  renameColumn: (key: string, label: string) => void;
  /** opens the per-person edit modal (state change, remove from model) */
  editEmployee: (id: string) => void;
}

interface Props {
  columns: TableColumn[];
  rows: DisplayRow[];
  totals: Partial<Record<NumericField, number>>;
  /** admin, not viewing as someone — governs the header double-click-to-rename affordance only */
  canRenameColumns: boolean;
  busy: boolean;
  showAll: boolean;
  isRevealed: (id: string) => boolean;
  toggleRow: (id: string) => void;
  sortCol: string | null;
  sortDir: number;
  onSort: (key: string) => void;
  handlers: TableHandlers;
  /**
   * Per-row counter bumped when a discretionary entry was held at the figure
   * the cell already showed. Folded into the input's key so the uncontrolled
   * cell remounts and drops the typed text — without it, a value held at the
   * stored figure would sit on screen looking accepted.
   */
  daNonce?: Record<string, number>;
  /**
   * The most this row may be granted, for the ceiling shown on a focused cell.
   * Null when there is nothing to show (a read-only lead, who has no engine
   * locally, or a row with no pool bound).
   */
  daHeadroomFor?: (id: string) => number | null;
  /** The scroll box, exposed so the shell can watch scrollTop (pool collapse). */
  scrollRef?: React.Ref<HTMLDivElement>;
}

const cellInput =
  "border border-neutral-300 px-1.5 py-1 text-xs outline-none focus:border-brand-orange disabled:opacity-50";

/**
 * A right-edge shadow that appears only when there is more to scroll to,
 * and disappears on its own once you've scrolled all the way — the classic
 * CSS-only "scroll shadow" (two background layers pinned to the content via
 * `background-attachment: local`, two more pinned to the viewport). No JS
 * scroll listener, so it costs nothing and can't drift out of sync. With the
 * build-up group collapsed by default this rarely fires on a laptop screen;
 * it earns its keep once someone expands it or the window narrows.
 */
const SCROLL_SHADOW: React.CSSProperties = {
  backgroundColor: "white",
  backgroundImage: [
    "linear-gradient(to right, white 30%, rgba(255,255,255,0))",
    "linear-gradient(to right, rgba(255,255,255,0), white 70%) right",
    "linear-gradient(to right, rgba(0,0,0,0.12), rgba(255,255,255,0))",
    "linear-gradient(to left, rgba(0,0,0,0.12), rgba(255,255,255,0)) right",
  ].join(", "),
  backgroundRepeat: "no-repeat",
  backgroundSize: "40px 100%, 40px 100%, 14px 100%, 14px 100%",
  backgroundAttachment: "local, local, scroll, scroll",
};

/**
 * Does this row's cost divide across both pools? Not the same question as
 * "is it Shared Services": a VIC employee who does a portion of NSW work is
 * flagged VIC and still carries a split. Read off the fractions, which is
 * also where the server-side rule in lib/dataset-edit.ts reads it.
 */
function hasSplit(r: DisplayRow): boolean {
  return r.vp !== undefined && r.vp > 0 && r.vp < 1;
}

/**
 * Enter moves down a column, Shift+Enter up, Escape abandons the edit. Tab is
 * left to the browser — the inputs are already in reading order. Arrow keys
 * are deliberately untouched: inside a text box they belong to the caret.
 */
function gridKeys(e: React.KeyboardEvent<HTMLElement>, rowIdx: number, colKey: string) {
  const el = e.target as HTMLInputElement;
  if (e.key === "Escape") {
    e.preventDefault();
    el.value = el.defaultValue; // discard, so blur writes nothing
    el.blur();
    return;
  }
  if (e.key !== "Enter") return;
  e.preventDefault();
  const next = rowIdx + (e.shiftKey ? -1 : 1);
  const target = document.querySelector<HTMLElement>(
    `[data-row="${next}"][data-col="${colKey}"]`
  );
  el.blur(); // commits via onBlur
  if (target) {
    target.focus();
    if (target instanceof HTMLInputElement) target.select();
  }
}

export default function EmployeeTable({
  columns,
  rows,
  totals,
  canRenameColumns,
  busy,
  showAll,
  isRevealed,
  toggleRow,
  sortCol,
  sortDir,
  onSort,
  handlers,
  daNonce,
  daHeadroomFor,
  scrollRef,
}: Props) {
  // Which discretionary cell has focus, so its ceiling can be shown. Local
  // because it is presentation only — nothing outside the table cares.
  const [daFocus, setDaFocus] = useState<string | null>(null);
  const show = (c: TableColumn, v: number) =>
    fmtValue(c.format ?? "currency", c.decimals ?? 0, v);

  function moneyCell(r: DisplayRow, rowIdx: number, c: TableColumn, value: number, width: number) {
    return (
      <input
        key={`${r.id}-bipm-${value}`}
        type="text"
        data-row={rowIdx}
        data-col={c.key}
        defaultValue={Math.round(value)}
        disabled={busy}
        onFocus={(e) => e.target.select()}
        onBlur={(e) => handlers.updateDatasetFigure(r.id, value, e.target.value)}
        onKeyDown={(e) => gridKeys(e, rowIdx, c.key)}
        style={{ width }}
        className={`${cellInput} text-right tabular-nums`}
      />
    );
  }

  function cell(r: DisplayRow, c: TableColumn, rowIdx: number) {
    // privacy mask: figures — editable or not — hidden until the row (or
    // everything) is revealed. This is the only thing standing between an
    // editable cell and a click: reveal the row, then its permitted cells
    // are directly editable, with no separate mode to turn on first.
    if ((NUMERIC_FIELDS as readonly string[]).includes(c.key) && !isRevealed(r.id)) {
      // Nothing to hide where there is no adjustable figure in the first
      // place — a VIC site manager or a row drawing from no pool.
      if (c.key === "da" && !isDaEditable(r))
        return <span className="text-neutral-300">—</span>;
      // Nothing to hide on a whole-pool row — there is no split to reveal.
      if ((c.key === "vp" || c.key === "np") && !hasSplit(r))
        return <span className="text-neutral-300">—</span>;
      return <span className="select-none text-neutral-300">••••</span>;
    }

    switch (c.key) {
      case "name":
        return r.name;
      case "state": {
        const cls =
          r.st === "VIC"
            ? "bg-brand-orange-tint text-brand-orange"
            : r.st === "NSW"
              ? "bg-brand-90 text-white"
              : "bg-brand-orange-mid text-white";
        return (
          <span className={`inline-block px-2 py-0.5 text-[11px] font-bold ${cls}`}>
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
      case "cat":
        return r.cat;

      case "elig":
        // Informational only — never used in the calc, never editable.
        return r.elig === undefined ? (
          <span className="text-neutral-300">—</span>
        ) : (
          show(c, r.elig)
        );
      case "totalPkg":
        // The whole-of-package figure "Package" used to mean. Informational
        // only — "pkg" (Eligible Salary) is what the calc actually runs on.
        return r.totalPkg === undefined ? (
          <span className="text-neutral-300">—</span>
        ) : (
          show(c, r.totalPkg)
        );
      case "pkg":
        return show(c, r.pkg!);
      case "bp":
        // Comes from the spreadsheet and is read-only for everyone, admin
        // included — hardcoded rather than left to fall out of `c.editable`
        // alone, belt-and-braces against that flag ever being set for this
        // column by mistake.
        return show(c, r.bp!);
      case "ipm": {
        if (!c.editable || r.locked) return show(c, r.ipm!);
        return (
          <input
            key={`${r.id}-ipm-${r.ipm}`}
            type="text"
            data-row={rowIdx}
            data-col={c.key}
            defaultValue={`${Math.round(r.ipm! * 100)}%`}
            disabled={busy}
            onFocus={(e) => e.target.select()}
            onBlur={(e) => handlers.updateIPM(r.id, r.ipm!, e.target.value)}
            onKeyDown={(e) => gridKeys(e, rowIdx, c.key)}
            className={`${cellInput} w-[58px] text-right tabular-nums`}
          />
        );
      }
      case "potential":
        // pkg × bp × cpm — before IPM, with the company-modifier correction
        // already folded in, so it reconciles with "After IPM" once IPM is
        // applied. Never editable: it's the engine's own intermediate figure.
        return show(c, r.potential!);
      case "bipm":
        if (!c.dsEditable || r.locked) return show(c, r.bipm!);
        return moneyCell(r, rowIdx, c, r.bipm!, 85);
      case "vp":
      case "np": {
        // Only meaningful where the cost actually divides across the pools,
        // which is not the same thing as being flagged Shared Services: VIC
        // staff doing a portion of NSW work carry a split too. Adding a split
        // to a whole-pool row is an edit-modal action, not an inline one.
        if (!hasSplit(r)) return <span className="text-neutral-300">—</span>;
        const field: "vp" | "np" = c.key === "vp" ? "vp" : "np";
        const v = field === "vp" ? r.vp! : r.np!;
        if (!c.dsEditable || r.locked) return show(c, v);
        return (
          <input
            key={`${r.id}-${c.key}-${v}`}
            type="text"
            data-row={rowIdx}
            data-col={c.key}
            defaultValue={`${Math.round(v * 100)}%`}
            disabled={busy}
            onFocus={(e) => e.target.select()}
            onBlur={(e) => handlers.updateSplit(r.id, field, v, e.target.value)}
            onKeyDown={(e) => gridKeys(e, rowIdx, c.key)}
            className={`${cellInput} w-[58px] text-right tabular-nums`}
          />
        );
      }
      case "calc":
        return show(c, r.calc!);
      case "f25":
        return <span className="text-neutral-400">{show(c, r.f25!)}</span>;
      case "da": {
        // A VIC site manager's fixed bonus is deliberately not adjustable, an
        // NSW one's is (isDaEditable) — so this dash is the rule showing, not
        // a missing figure.
        if (!isDaEditable(r))
          return (
            <span
              title={
                r.sm
                  ? "Site Manager on the VIC pool — fixed bonus, not adjustable"
                  : "Not in a bonus pool, so there is nothing to adjust"
              }
              className="cursor-help text-neutral-300"
            >
              —
            </span>
          );
        if (!c.editable || r.locked) return show(c, r.da!);
        // The ceiling, shown while the cell has focus: a discretionary amount
        // adds to the pool total, and this is the room left under the cap.
        // Absolutely positioned so revealing it can't nudge the row heights.
        const ceiling = daHeadroomFor?.(r.id) ?? null;
        const hint =
          ceiling === null
            ? undefined
            : `Most that can be granted before the pool reaches its cap: ${fmtValue("currency", 0, ceiling)}`;
        return (
          <span className="relative inline-block">
            <input
              key={`${r.id}-da-${r.da}-${daNonce?.[r.id] ?? 0}`}
              type="text"
              data-row={rowIdx}
              data-col={c.key}
              defaultValue={Math.round(r.da!)}
              disabled={busy}
              title={hint}
              onFocus={(e) => {
                e.target.select();
                setDaFocus(r.id);
              }}
              onBlur={(e) => {
                setDaFocus((cur) => (cur === r.id ? null : cur));
                handlers.updateDA(r.id, e.target.value);
              }}
              onKeyDown={(e) => gridKeys(e, rowIdx, c.key)}
              className={`${cellInput} w-[80px] text-right tabular-nums`}
            />
            {daFocus === r.id && ceiling !== null && (
              <span className="pointer-events-none absolute right-0 top-full z-20 mt-0.5 whitespace-nowrap bg-brand-95 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                max {fmtValue("currency", 0, ceiling)}
              </span>
            )}
          </span>
        );
      }
      case "yoy": {
        const v = r.yoy!;
        const color = v > 0 ? "text-brand-95" : v < 0 ? "text-brand-orange" : "";
        return <span className={color}>{show(c, v)}</span>;
      }
      case "final":
        return <span className="font-bold">{show(c, r.final!)}</span>;

      case "lock": {
        // NSW site managers became lockable on 24 Aug 2026; VIC ones stay out,
        // along with anyone drawing from no pool (isLockable holds both rules).
        if (!isLockable(r))
          return (
            <span
              title={
                r.sm
                  ? "Site Manager on the VIC pool — fixed bonus, not subject to redistribution"
                  : "Not in a bonus pool, so there is nothing to lock"
              }
              className="cursor-help text-sm"
            >
              —
            </span>
          );
        return (
          <button
            type="button"
            onClick={() => handlers.toggleLock(r.id)}
            className={`h-7 w-7 border-[1.5px] text-sm transition-colors ${
              r.locked
                ? "border-brand-orange bg-brand-orange"
                : "border-neutral-300 bg-transparent hover:border-brand-orange"
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
            title={`Edit ${r.name}`}
            onClick={() => handlers.editEmployee(r.id)}
            className="h-7 w-7 border-[1.5px] border-neutral-300 bg-transparent text-sm text-neutral-400 transition-colors hover:border-brand-orange hover:text-brand-orange"
          >
            ✎
          </button>
        );
      default:
        return null;
    }
  }

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-auto shadow-sm"
      style={SCROLL_SHADOW}
    >
      <table className="w-full border-collapse bg-white text-xs">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                onClick={c.noSort ? undefined : () => onSort(c.key)}
                onDoubleClick={
                  canRenameColumns && c.key !== "lock" && c.key !== "edit"
                    ? () => {
                        const next = prompt(`Rename the "${c.label}" column to:`, c.label);
                        if (next && next.trim() && next.trim() !== c.label)
                          handlers.renameColumn(c.key, next.trim());
                      }
                    : undefined
                }
                title={canRenameColumns && !c.noSort ? "Double-click to rename" : undefined}
                className={`sticky top-0 whitespace-nowrap bg-brand-95 px-2 py-2.5 text-left text-[11px] tracking-wide text-white select-none ${
                  // Pinned corner cell: stuck to both edges, above every other
                  // sticky cell (the header row at z-10, the name column's own
                  // body cells at z-[1]) so it is never scrolled under.
                  c.key === "name" ? "left-0 z-20" : "z-10"
                } ${c.noSort ? "" : "cursor-pointer hover:bg-[#333]"} ${c.num ? "text-right" : ""}`}
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
          {rows.map((r, rowIdx) => (
            <tr
              key={r.id}
              className="group cursor-pointer"
              title="Click to show/hide this row's figures"
              onClick={(e) => {
                // clicking an already-rendered input/button focuses it rather
                // than masking the row back — this is the only guard needed
                // now that there's no separate edit mode forcing reveal on.
                if ((e.target as HTMLElement).closest("input,button,a,select,label")) return;
                toggleRow(r.id);
              }}
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`whitespace-nowrap border-b border-neutral-100 px-2 py-2 group-hover:bg-neutral-50 ${
                    // Sticky needs its own opaque background — otherwise the
                    // columns scrolling underneath show straight through it.
                    c.key === "name" ? "sticky left-0 z-[1] bg-white" : ""
                  } ${c.num ? "text-right tabular-nums" : ""} ${c.key === "final" ? "bg-brand-lavender" : c.key === "f25" ? "bg-surface-sunken" : ""}`}
                >
                  {cell(r, c, rowIdx)}
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
                  ? `Totals (${rows.length})`
                  : c.format === "percent"
                    ? ""
                    : typeof totals[c.key as NumericField] === "number"
                      ? showAll
                        ? show(c, totals[c.key as NumericField]!)
                        : "••••••"
                      : "";
              return (
                <td
                  key={c.key}
                  // Pinned to the bottom the same way the heading row is pinned
                  // to the top, and for the same reason: this table is the
                  // page's single vertical scroller, so `bottom-0` here holds
                  // against the viewport. The sticky lives on the CELLS, never
                  // on <tfoot> itself — sticky on a table section is patchy
                  // across browsers, whereas per-cell is the trick the heading
                  // row already relies on. Every footer cell carries an opaque
                  // background (orange, or lavender on Final), which is what
                  // stops the rows scrolling underneath showing through.
                  className={`sticky bottom-0 whitespace-nowrap px-2 py-2 text-[13px] font-bold text-white ${
                    // Pinned corner: stuck to both edges, so it outranks the
                    // rest of the footer row (z-10) and the name column's body
                    // cells (z-[1]) — mirrors the heading row's own z-order.
                    c.key === "name" ? "left-0 z-20" : "z-10"
                  } ${c.num ? "text-right tabular-nums" : ""} ${c.key === "final" ? "bg-brand-lavender" : "bg-brand-orange"}`}
                >
                  {v}
                </td>
              );
            })}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
