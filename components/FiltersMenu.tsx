"use client";

import { useRef, useState } from "react";
import type { ColumnConfig } from "@/lib/columns";
import { useDismissable } from "@/lib/use-dismissable";
import { MultiSelect } from "./MultiSelect";
import ColumnMenu from "./ColumnMenu";

/**
 * Everything the toolbar used to spread across seven controls, behind one
 * button: the four facet filters, and (for a configuring admin) Add person,
 * the column control, the company modifier and the build-up toggle. The
 * badge counts facets actually narrowing the table — same rule as the
 * filtering itself, where a full or empty selection means "no filter".
 *
 * The panel scrolls itself and the MultiSelects open inline within it: the
 * page no longer scrolls, so a popover escaping the viewport would be
 * unreachable, not merely awkward.
 */
export default function FiltersMenu({
  facets,
  selRoles,
  setSelRoles,
  selCats,
  setSelCats,
  selDepts,
  setSelDepts,
  selMgrs,
  setSelMgrs,
  activeFilterCount,
  configuring,
  dsBusy,
  onAddPerson,
  columnConfig,
  onColumnConfigChange,
  companyModifier,
  buildupColumnCount,
  buildupOpen,
  onToggleBuildup,
}: {
  facets: { roles: string[]; cats: string[]; depts: string[]; mgrs: string[] };
  selRoles: string[];
  setSelRoles: (sel: string[]) => void;
  selCats: string[];
  setSelCats: (sel: string[]) => void;
  selDepts: string[];
  setSelDepts: (sel: string[]) => void;
  selMgrs: string[];
  setSelMgrs: (sel: string[]) => void;
  activeFilterCount: number;
  configuring: boolean;
  dsBusy: boolean;
  onAddPerson: () => void;
  columnConfig: ColumnConfig;
  onColumnConfigChange: (next: ColumnConfig) => void;
  companyModifier: number;
  buildupColumnCount: number;
  buildupOpen: boolean;
  onToggleBuildup: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useDismissable(wrapRef, open, () => setOpen(false));

  return (
    <>

      <div ref={wrapRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={`flex items-center gap-1.5 border-2 bg-white px-3.5 py-2 text-[13px] outline-none ${open ? "border-brand-orange" : "border-neutral-200"
            }`}
        >
          Filters &amp; options
          {activeFilterCount > 0 && (
            <span className="inline-block bg-brand-orange px-1.5 py-px text-[10px] font-bold text-white">
              {activeFilterCount}
            </span>
          )}
          <span className="text-[10px] text-neutral-400">▾</span>
        </button>

        {open && (
          <div className="absolute left-0 z-40 mt-1 max-h-[calc(100dvh-220px)] w-[360px] overflow-y-auto border-2 border-neutral-200 bg-white p-3 shadow-2xl">
            <div className="flex flex-col gap-2">
              {/* "Roles" = positions, matching what the word means on the
                access screen. The cat facet ("Employee" / "Texco Management")
                keeps its own picker under the name the rest of the app uses
                for that field: Category. */}
              <MultiSelect variant="inline" label="Roles" items={facets.roles} selected={selRoles} onChange={setSelRoles} />
              <MultiSelect variant="inline" label="Categories" items={facets.cats} selected={selCats} onChange={setSelCats} />
              <MultiSelect variant="inline" label="Departments" items={facets.depts} selected={selDepts} onChange={setSelDepts} />
              <MultiSelect variant="inline" label="Managers" items={facets.mgrs} selected={selMgrs} onChange={setSelMgrs} />
            </div>

            {configuring && (
              <>
                <div className="my-3 border-t border-neutral-200" />
                <div className="flex flex-wrap items-center gap-2">
                  {/* Restored: new starters shouldn't wait for the next
                    workbook. Admin-only by the same gate as every other
                    roster control (requireWriter server-side). */}
                  <button
                    type="button"
                    disabled={dsBusy}
                    onClick={() => {
                      onAddPerson();
                      setOpen(false);
                    }}
                    className="border-2 border-brand-orange px-3.5 py-1.5 text-[11px] font-bold tracking-wide text-brand-orange transition-colors hover:bg-brand-orange hover:text-white disabled:opacity-40"
                  >
                    + Add person
                  </button>
                  <ColumnMenu
                    config={columnConfig}
                    onChange={onColumnConfigChange}
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
                    <span className="tabular-nums text-brand-95">{companyModifier}</span>
                  </span>
                </div>
              </>
            )}

          </div>
        )}
      </div>

      {buildupColumnCount > 0 && (
        <>
          <div className="my-3 mr-3 border-t border-neutral-200" />
          <label
            className="flex cursor-pointer items-center gap-2 text-[13px]"
            title="Eligibility %, Package, Bonus %, Potential Bonus and After IPM, side by side"
          >
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-brand-orange"
              checked={buildupOpen}
              onChange={onToggleBuildup}
            />
            Show build-up columns ({buildupColumnCount})
          </label>
        </>
      )}</>
  );
}
