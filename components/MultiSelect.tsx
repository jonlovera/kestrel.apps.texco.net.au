"use client";

import { useEffect, useRef, useState } from "react";

/** Multi-select dropdown, matching the prototype's .ms-wrap behaviour. */
export function MultiSelect({
  label,
  items,
  selected,
  onChange,
}: {
  label: string; // e.g. "Roles"
  items: string[];
  selected: string[];
  onChange: (sel: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(ev: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(ev.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  const allSelected = selected.length === items.length;
  const btnLabel =
    allSelected || selected.length === 0 ? (
      `All ${label}`
    ) : selected.length === 1 ? (
      selected[0]
    ) : (
      <>
        {label}{" "}
        <span className="ml-1 inline-block rounded-full bg-[#FC4D0F] px-1.5 py-px text-[10px] font-bold text-white">
          {selected.length}
        </span>
      </>
    );

  return (
    <div ref={wrapRef} className="relative inline-block min-w-[160px]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full min-w-[160px] items-center justify-between gap-1.5 rounded-md border-2 bg-white px-3.5 py-2 text-left text-[13px] outline-none ${
          open ? "border-[#FC4D0F]" : "border-neutral-200"
        }`}
      >
        <span>{btnLabel}</span>
        <span className="text-[10px] text-neutral-400">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-0.5 max-h-[260px] overflow-y-auto rounded-md border-2 border-neutral-200 bg-white shadow-lg">
          <label className="flex cursor-pointer items-center gap-2 border-b border-neutral-100 px-3 py-1.5 text-[13px] font-semibold hover:bg-neutral-100">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-[#FC4D0F]"
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
                className="h-3.5 w-3.5 accent-[#FC4D0F]"
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
