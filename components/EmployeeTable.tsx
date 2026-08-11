"use client";

import { NUMERIC_FIELDS, type NumericField } from "@/lib/access-types";
import type { DisplayRow } from "@/lib/payload-types";
import type { ColumnFormat } from "@/lib/columns";
import { fmtValue } from "@/lib/fmt";

/**
 * The dashboard table: headers, cells, totals.
 *
 * Presentational — it owns no data. Every edit is handed straight back through
 * `handlers`, and which cells are editable is decided by the column flags the
 * orchestrator passes in. Outside edit mode it renders plain text with no
 * inputs at all, which is what makes the dashboard presentable on a shared
 * screen.
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
  updateDatasetFigure: (id: string, current: number, raw: string) => void;
  updateSplit: (id: string, field: "vp" | "np", current: number, raw: string) => void;
  toggleLock: (id: string) => void;
  renameColumn: (key: string, label: string) => void;
}

interface Props {
  columns: TableColumn[];
  rows: DisplayRow[];
  totals: Partial<Record<NumericField, number>>;
  editing: boolean;
  busy: boolean;
  showAll: boolean;
  isRevealed: (id: string) => boolean;
  toggleRow: (id: string) => void;
  sortCol: string | null;
  sortDir: number;
  onSort: (key: string) => void;
    handlers: TableHandlers;
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
  editing,
  busy,
  showAll,
  isRevealed,
  toggleRow,
  sortCol,
  sortDir,
  onSort,
  handlers,
}: Props) {
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
    // privacy mask: figures hidden until the row (or everything) is revealed.
    // Edit mode forces reveal on, so this never hides a cell being typed into.
    if ((NUMERIC_FIELDS as readonly string[]).includes(c.key) && !isRevealed(r.id)) {
      if (c.key === "da" && (r.sm || !r.inPool))
        return <span className="text-neutral-300">—</span>;
      // Nothing to hide on a VIC/NSW row — there is no split to reveal.
      if ((c.key === "vp" || c.key === "np") && r.st !== "SHARED")
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
      case "pkg":
        return show(c, r.pkg!);
      case "bp":
      case "ipm": {
        const v = c.key === "bp" ? r.bp! : r.ipm!;
        // Both come from the spreadsheet and are read-only for everyone. IPM
        // is a formula-derived figure; a manual override on it corrupts the
        // calculation, so this is hardcoded rather than left to fall out of
        // `c.editable` alone — belt-and-braces against that flag ever being
        // set for this column by mistake.
        return show(c, v);
      }
      case "potential":
        // pkg × bp × cpm — before IPM, with the company-modifier correction
        // already folded in, so it reconciles with "After IPM" once IPM is
        // applied. Never editable: it's the engine's own intermediate figure.
        return show(c, r.potential!);
      case "bipm":
        if (!editing || !c.dsEditable || r.locked) return show(c, r.bipm!);
        return moneyCell(r, rowIdx, c, r.bipm!, 85);
      case "vp":
      case "np": {
        // Only ever meaningful for a Shared Services row — a VIC or NSW
        // employee is 100% one pool already.
        if (r.st !== "SHARED") return <span className="text-neutral-300">—</span>;
        const field: "vp" | "np" = c.key === "vp" ? "vp" : "np";
        const v = field === "vp" ? r.vp! : r.np!;
        if (!editing || !c.dsEditable || r.locked) return show(c, v);
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
        if (r.sm || !r.inPool) return <span className="text-neutral-300">—</span>;
        if (!editing || !c.editable || r.locked) return show(c, r.da!);
        return (
          <input
            key={`${r.id}-da-${r.da}`}
            type="text"
            data-row={rowIdx}
            data-col={c.key}
            defaultValue={Math.round(r.da!)}
            disabled={busy}
            onFocus={(e) => e.target.select()}
            onBlur={(e) => handlers.updateDA(r.id, e.target.value)}
            onKeyDown={(e) => gridKeys(e, rowIdx, c.key)}
            className={`${cellInput} w-[80px] text-right tabular-nums`}
          />
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
      default:
        return null;
    }
  }

  return (
    <div
      className="mb-5 max-h-[calc(100vh-260px)] overflow-auto shadow-sm"
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
                  editing && c.key !== "lock" && c.key !== "edit"
                    ? () => {
                        const next = prompt(`Rename the "${c.label}" column to:`, c.label);
                        if (next && next.trim() && next.trim() !== c.label)
                          handlers.renameColumn(c.key, next.trim());
                      }
                    : undefined
                }
                title={editing && !c.noSort ? "Double-click to rename" : undefined}
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
              title={editing ? undefined : "Click to show/hide this row's figures"}
              onClick={(e) => {
                if (editing) return; // clicking a cell should focus it, not mask the row
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
                  className={`whitespace-nowrap px-2 py-2 text-[13px] font-bold text-white ${
                    c.key === "name" ? "sticky left-0 z-[1]" : ""
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
