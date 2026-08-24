"use client";

import { useRef, useState } from "react";
import { useDismissable } from "@/lib/use-dismissable";

/**
 * Multi-select dropdown, matching the prototype's .ms-wrap behaviour.
 *
 * Two renderings of the open list: `popover` floats it over whatever is
 * underneath (the original toolbar behaviour), `inline` opens it in normal
 * flow, accordion-style — for use inside the Filters & options panel, where
 * the page no longer scrolls and a popover poking past the bottom of the
 * viewport would be unreachable rather than merely awkward.
 */
export function MultiSelect({
  label,
  items,
  selected,
  onChange,
  variant = "popover",
}: {
  label: string; // e.g. "Roles"
  items: string[];
  selected: string[];
  onChange: (sel: string[]) => void;
  variant?: "popover" | "inline";
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Inline lists are accordions: they close from their own trigger or with
  // the whole panel, never on an outside mousedown — dismissing there would
  // shift the panel's layout mid-click and the click would miss its target.
  useDismissable(wrapRef, open && variant === "popover", () => setOpen(false));

  const allSelected = selected.length === items.length;
  const btnLabel =
    allSelected || selected.length === 0 ? (
      `All ${label}`
    ) : selected.length === 1 ? (
      selected[0]
    ) : (
      <>
        {label}{""}
        <span className="ml-1 inline-block bg-brand-orange px-1.5 py-px text-[10px] font-bold text-white">
          {selected.length}
        </span>
      </>
    );

  return (
    <div
      ref={wrapRef}
      className={variant === "inline" ? "block" : "relative inline-block min-w-[160px]"}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full min-w-[160px] items-center justify-between gap-1.5 border-2 bg-white px-3.5 py-2 text-left text-[13px] outline-none ${
          open ? "border-brand-orange" : "border-neutral-200"
        }`}
      >
        <span>{btnLabel}</span>
        <span className="text-[10px] text-neutral-400">{open && variant === "inline" ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div
          className={
            variant === "inline"
              ? "mt-0.5 max-h-[200px] overflow-y-auto border-2 border-neutral-200 bg-white"
              : "absolute left-0 right-0 top-full z-50 mt-0.5 max-h-[260px] overflow-y-auto border-2 border-neutral-200 bg-white shadow-lg"
          }
        >
          <label className="flex cursor-pointer items-center gap-2 border-b border-neutral-100 px-3 py-1.5 text-[13px] font-semibold hover:bg-neutral-100">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-brand-orange"
              checked={allSelected}
              onChange={(e) => onChange(e.target.checked ? [...items] : [])}
            />
            Select all
          </label>
          {items.map((item) => (
            <label
              key={item}
              className="flex cursor-pointer items-center gap-2 whitespace-nowrap px-3 py-1.5 text-[13px] hover:bg-neutral-100"
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-brand-orange"
                checked={selected.includes(item)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...selected, item]
                      : selected.filter((s) => s !== item)
                  )
                }
              />
              {item}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
