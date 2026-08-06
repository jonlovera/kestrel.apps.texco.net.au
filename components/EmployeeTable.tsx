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
  /** dataset doc, numeric: Package, After IPM, FY25 */
  dsEditable?: boolean;
  /** dataset doc, identity text and state */
  textEditable?: boolean;
  noSort?: boolean;
  format?: ColumnFormat;
  decimals?: number;
}

export interface TableHandlers {
  updatePercent: (id: string, field: "bpEdit" | "ipmEdit", val: string) => void;
  updateDA: (id: string, val: string) => void;
  updateDatasetFigure: (
    id: string,
    field: "pkg" | "bipm" | "f25",
    current: number,
    raw: string
  ) => void;
  updateText: (
    id: string,
    field: "gn" | "sn" | "pos" | "dept" | "mgr" | "cat",
    current: string,
    raw: string
  ) => void;
  updateState: (id: string, st: "VIC" | "NSW" | "SHARED") => void;
  toggleLock: (id: string) => void;
  openRowEditor: (id: string) => void;
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
  /** existing values offered as datalist suggestions while editing */
  facets: { cats: string[]; depts: string[]; mgrs: string[] };
  handlers: TableHandlers;
}

const STATES = ["VIC", "NSW", "SHARED"] as const;

const cellInput =
  "rounded border border-neutral-300 px-1.5 py-1 text-xs outline-none focus:border-[#FC4D0F] disabled:opacity-50";

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
  facets,
  handlers,
}: Props) {
  const show = (c: TableColumn, v: number) =>
    fmtValue(c.format ?? "currency", c.decimals ?? 0, v);

  function textCell(
    r: DisplayRow,
    rowIdx: number,
    c: TableColumn,
    field: "pos" | "dept" | "mgr" | "cat",
    value: string,
    list?: string
  ) {
    if (!editing || !c.textEditable) return value;
    return (
      <input
        key={`${r.id}-${field}-${value}`}
        type="text"
        list={list}
        data-row={rowIdx}
        data-col={c.key}
        defaultValue={value}
        disabled={busy}
        onFocus={(e) => e.target.select()}
        onBlur={(e) => handlers.updateText(r.id, field, value, e.target.value)}
        onKeyDown={(e) => gridKeys(e, rowIdx, c.key)}
        className={`${cellInput} w-full min-w-[110px]`}
      />
    );
  }

  function moneyCell(
    r: DisplayRow,
    rowIdx: number,
    c: TableColumn,
    field: "pkg" | "bipm" | "f25",
    value: number,
    width: number
  ) {
    return (
      <input
        key={`${r.id}-${field}-${value}`}
        type="text"
        data-row={rowIdx}
        data-col={c.key}
        defaultValue={Math.round(value)}
        disabled={busy}
        onFocus={(e) => e.target.select()}
        onBlur={(e) => handlers.updateDatasetFigure(r.id, field, value, e.target.value)}
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
      return <span className="select-none text-neutral-300">••••</span>;
    }

    switch (c.key) {
      case "name": {
        if (!editing || !c.textEditable || r.gn === undefined) return r.name;
        // the source keeps the halves apart, so editing does too rather than
        // guessing where a surname starts
        return (
          <div className="flex gap-1">
            <input
              key={`${r.id}-gn-${r.gn}`}
              type="text"
              data-row={rowIdx}
              data-col="name"
              defaultValue={r.gn}
              disabled={busy}
              aria-label="Given name"
              onFocus={(e) => e.target.select()}
              onBlur={(e) => handlers.updateText(r.id, "gn", r.gn!, e.target.value)}
              onKeyDown={(e) => gridKeys(e, rowIdx, "name")}
              className={`${cellInput} w-[80px]`}
            />
            <input
              key={`${r.id}-sn-${r.sn}`}
              type="text"
              defaultValue={r.sn}
              disabled={busy}
              aria-label="Surname"
              onFocus={(e) => e.target.select()}
              onBlur={(e) => handlers.updateText(r.id, "sn", r.sn!, e.target.value)}
              onKeyDown={(e) => gridKeys(e, rowIdx, "name")}
              className={`${cellInput} w-[90px]`}
            />
          </div>
        );
      }
      case "state": {
        if (editing && c.textEditable) {
          return (
            <select
              data-row={rowIdx}
              data-col={c.key}
              value={r.st}
              disabled={busy}
              onChange={(e) =>
                handlers.updateState(r.id, e.target.value as (typeof STATES)[number])
              }
              className={`${cellInput} w-[92px]`}
            >
              {STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          );
        }
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
        return textCell(r, rowIdx, c, "pos", r.pos);
      case "dept":
        return textCell(r, rowIdx, c, "dept", r.dept, "dept-suggestions");
      case "mgr":
        return textCell(r, rowIdx, c, "mgr", r.mgr, "mgr-suggestions");
      case "cat":
        return textCell(r, rowIdx, c, "cat", r.cat, "cat-suggestions");

      case "pkg":
        // a package edit carries After IPM with it, pro rata — see
        // scaledBipm() in lib/dataset-edit.ts for why
        if (!editing || !c.dsEditable || r.locked) return show(c, r.pkg!);
        return moneyCell(r, rowIdx, c, "pkg", r.pkg!, 90);
      case "bp":
      case "ipm": {
        const v = c.key === "bp" ? r.bp! : r.ipm!;
        if (!editing || !c.editable || r.locked) return show(c, v);
        // Input parsing stays semantic (percent-style, "90" means 90%)
        // regardless of the configured display format.
        return (
          <input
            key={`${r.id}-${c.key}-${v}`}
            type="text"
            data-row={rowIdx}
            data-col={c.key}
            defaultValue={`${Math.round(v * 100)}%`}
            disabled={busy}
            onFocus={(e) => e.target.select()}
            onBlur={(e) =>
              handlers.updatePercent(r.id, c.key === "bp" ? "bpEdit" : "ipmEdit", e.target.value)
            }
            onKeyDown={(e) => gridKeys(e, rowIdx, c.key)}
            className={`${cellInput} w-[58px] text-right tabular-nums`}
          />
        );
      }
      case "bipm":
        if (!editing || !c.dsEditable || r.locked) return show(c, r.bipm!);
        return moneyCell(r, rowIdx, c, "bipm", r.bipm!, 85);
      case "calc":
        return show(c, r.calc!);
      case "f25":
        // last year's figure: a fact, unaffected by this year's lock
        if (!editing || !c.dsEditable)
          return <span className="text-neutral-400">{show(c, r.f25!)}</span>;
        return moneyCell(r, rowIdx, c, "f25", r.f25!, 85);
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
            onClick={() => handlers.toggleLock(r.id)}
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
            title={`Pool split, site-manager flag, or remove ${r.name}`}
            disabled={busy}
            onClick={() => handlers.openRowEditor(r.id)}
            className="h-7 w-7 rounded border-[1.5px] border-neutral-300 text-sm transition-colors hover:border-[#FC4D0F] disabled:opacity-40"
          >
            ✎
          </button>
        );
      default:
        return null;
    }
  }

  return (
    <div className="mb-5 max-h-[calc(100vh-260px)] overflow-auto rounded-lg shadow-sm">
      {editing && (
        <>
          <datalist id="dept-suggestions">
            {facets.depts.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
          <datalist id="mgr-suggestions">
            {facets.mgrs.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <datalist id="cat-suggestions">
            {facets.cats.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </>
      )}

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
                    c.num ? "text-right tabular-nums" : ""
                  } ${c.key === "final" ? "bg-[#E7D8FC]" : c.key === "f25" ? "bg-[#f7f7f7]" : ""}`}
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
                  ? `TOTALS (${rows.length})`
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
  );
}
