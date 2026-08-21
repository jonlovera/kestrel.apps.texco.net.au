"use client";

import { useEffect, useMemo, useState } from "react";
import type { Employee } from "@/lib/schema";

type State = "VIC" | "NSW" | "SHARED";

const STATE_OPTIONS: { value: State; label: string; note: string }[] = [
  { value: "VIC", label: "VIC pool", note: "paid entirely from the VIC pool" },
  { value: "NSW", label: "NSW pool", note: "paid entirely from the NSW pool" },
  {
    value: "SHARED",
    label: "Shared Services",
    note: "split between the two pools at the percentages below",
  },
];

/** The id convention in the data: first two letters of the given name plus
 *  first three of the surname, uppercase (Alan Bidychak becomes ALBID). */
function suggestId(gn: string, sn: string, taken: ReadonlySet<string>): string {
  const letters = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, "");
  const g = letters(gn);
  const s = letters(sn);
  if (!g || !s) return "";
  const candidates = [
    g.slice(0, 2) + s.slice(0, 3),
    g.slice(0, 2) + s.slice(0, 4),
    g.slice(0, 3) + s.slice(0, 3),
  ];
  return candidates.find((c) => c.length >= 2 && !taken.has(c)) ?? candidates[0];
}

/**
 * Add a brand-new person to the roster — the "+ Add person" ability restored
 * for admins. Collects the full Employee shape; the two figures with sane
 * defaults are suggested live (id from the name, After IPM as pkg x bp x ipm,
 * the figure that gives the new starter a company modifier of exactly 1.0)
 * and stay suggestions until the admin types over them. Submits through the
 * caller's patchDataset, which snapshots first and records history.
 */
export default function EmployeeAddModal({
  roles,
  cats,
  depts,
  mgrs,
  existingIds,
  busy,
  error,
  onAdd,
  onClose,
}: {
  roles: string[];
  cats: string[];
  depts: string[];
  mgrs: string[];
  existingIds: ReadonlySet<string>;
  busy: boolean;
  /** the dashboard's dataset error, surfaced inline while the modal is open */
  error: string | null;
  onAdd: (employee: Employee) => void;
  onClose: () => void;
}) {
  const [gn, setGn] = useState("");
  const [sn, setSn] = useState("");
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [pos, setPos] = useState("");
  const [dept, setDept] = useState("");
  const [mgr, setMgr] = useState("");
  const [cat, setCat] = useState(cats[0] ?? "Employee");
  const [st, setSt] = useState<State>("VIC");
  const [vicPct, setVicPct] = useState(50);
  const [pkg, setPkg] = useState("");
  const [bpPct, setBpPct] = useState("10");
  const [ipmPct, setIpmPct] = useState("100");
  const [bipm, setBipm] = useState("");
  const [bipmTouched, setBipmTouched] = useState(false);
  const [f25, setF25] = useState("0");
  const [sm, setSm] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const effectiveId = idTouched ? id : suggestId(gn, sn, existingIds);
  const num = (s: string) => parseFloat(s.replace(/[^\d.-]/g, "")) || 0;
  const suggestedBipm = Math.round(num(pkg) * (num(bpPct) / 100) * (num(ipmPct) / 100));
  const effectiveBipm = bipmTouched && bipm !== "" ? num(bipm) : suggestedBipm;

  const duplicate = existingIds.has(effectiveId);
  const ready = useMemo(
    () =>
      gn.trim() !== "" &&
      sn.trim() !== "" &&
      /^[A-Za-z][A-Za-z0-9]{1,5}$/.test(effectiveId) &&
      !duplicate &&
      pos.trim() !== "" &&
      dept.trim() !== "" &&
      mgr.trim() !== "" &&
      cat.trim() !== "" &&
      num(pkg) > 0,
    [gn, sn, effectiveId, duplicate, pos, dept, mgr, cat, pkg]
  );

  function submit() {
    const vp = st === "VIC" ? 1 : st === "NSW" ? 0 : vicPct / 100;
    onAdd({
      id: effectiveId.toUpperCase(),
      gn: gn.trim(),
      sn: sn.trim(),
      pos: pos.trim(),
      dept: dept.trim(),
      mgr: mgr.trim(),
      cat: cat.trim(),
      st,
      vp,
      np: Math.round((1 - vp) * 10000) / 10000,
      pkg: num(pkg),
      bp: num(bpPct) / 100,
      ipm: num(ipmPct) / 100,
      bipm: effectiveBipm,
      da: 0,
      f25: num(f25),
      sm: sm ? 1 : 0,
    });
  }

  const fieldCls =
    "w-full border border-neutral-300 px-2 py-1 text-[13px] focus:border-brand-orange focus:outline-none";
  const labelCls = "mb-0.5 block text-[11px] font-bold tracking-wide text-brand-70";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add a person"
        className="flex max-h-[85vh] w-full max-w-[520px] flex-col overflow-y-auto bg-white shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-neutral-100 px-5 py-4">
          <div className="text-[14px] font-bold">Add a person</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="px-2 text-[18px] leading-none text-brand-70 transition-colors hover:text-brand-orange"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4">
          {error && (
            <div className="mb-3 border-2 border-error bg-error-tint px-3 py-2 text-[12px] font-semibold">
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>GIVEN NAME</label>
              <input className={fieldCls} value={gn} disabled={busy} onChange={(e) => setGn(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>SURNAME</label>
              <input className={fieldCls} value={sn} disabled={busy} onChange={(e) => setSn(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>EMPLOYEE ID</label>
              <input
                className={`${fieldCls} uppercase tabular-nums ${duplicate ? "border-error" : ""}`}
                value={effectiveId}
                disabled={busy}
                onChange={(e) => {
                  setIdTouched(true);
                  setId(e.target.value.toUpperCase());
                }}
              />
              <span className="text-[10px] text-brand-70">
                {duplicate
                  ? "Already taken — pick another"
                  : "Suggested from the name; 2 to 6 letters"}
              </span>
            </div>
            <div>
              <label className={labelCls}>POSITION</label>
              <input className={fieldCls} value={pos} disabled={busy} list="add-roles" onChange={(e) => setPos(e.target.value)} />
              <datalist id="add-roles">{roles.map((r) => <option key={r} value={r} />)}</datalist>
            </div>
            <div>
              <label className={labelCls}>DEPARTMENT</label>
              <input className={fieldCls} value={dept} disabled={busy} list="add-depts" onChange={(e) => setDept(e.target.value)} />
              <datalist id="add-depts">{depts.map((d) => <option key={d} value={d} />)}</datalist>
            </div>
            <div>
              <label className={labelCls}>MANAGER</label>
              <input className={fieldCls} value={mgr} disabled={busy} list="add-mgrs" onChange={(e) => setMgr(e.target.value)} />
              <datalist id="add-mgrs">{mgrs.map((m) => <option key={m} value={m} />)}</datalist>
            </div>
            <div>
              <label className={labelCls}>CATEGORY</label>
              <input className={fieldCls} value={cat} disabled={busy} list="add-cats" onChange={(e) => setCat(e.target.value)} />
              <datalist id="add-cats">{cats.map((c) => <option key={c} value={c} />)}</datalist>
            </div>
            <div>
              <label className={labelCls}>PACKAGE $ (ELIGIBLE SALARY)</label>
              <input className={`${fieldCls} tabular-nums`} value={pkg} disabled={busy} inputMode="decimal" onChange={(e) => setPkg(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>BONUS %</label>
              <input className={`${fieldCls} tabular-nums`} value={bpPct} disabled={busy} inputMode="decimal" onChange={(e) => setBpPct(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>IPM %</label>
              <input className={`${fieldCls} tabular-nums`} value={ipmPct} disabled={busy} inputMode="decimal" onChange={(e) => setIpmPct(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>AFTER IPM $</label>
              <input
                className={`${fieldCls} tabular-nums`}
                value={bipmTouched && bipm !== "" ? bipm : String(suggestedBipm)}
                disabled={busy}
                inputMode="decimal"
                onChange={(e) => {
                  setBipmTouched(true);
                  setBipm(e.target.value);
                }}
              />
              <span className="text-[10px] text-brand-70">
                Suggested Package × Bonus % × IPM %, a company modifier of exactly 1
              </span>
            </div>
            <div>
              <label className={labelCls}>FY25 BONUS $</label>
              <input className={`${fieldCls} tabular-nums`} value={f25} disabled={busy} inputMode="decimal" onChange={(e) => setF25(e.target.value)} />
            </div>
          </div>

          <div className="mt-4 mb-1 text-[11px] font-bold tracking-wide text-brand-70">
            POOL
          </div>
          <div className="space-y-1.5">
            {STATE_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className="flex cursor-pointer items-baseline gap-2 text-[13px]"
              >
                <input
                  type="radio"
                  name="add-employee-state"
                  checked={st === opt.value}
                  disabled={busy}
                  onChange={() => setSt(opt.value)}
                  className="translate-y-[1px] accent-brand-orange"
                />
                <span className="font-semibold">{opt.label}</span>
                <span className="text-[11px] text-brand-70">{opt.note}</span>
              </label>
            ))}
          </div>
          {st === "SHARED" && (
            <div className="mt-3 flex items-center gap-2 text-[13px]">
              <span>VIC</span>
              <input
                type="number"
                min={0}
                max={100}
                value={vicPct}
                disabled={busy}
                onChange={(e) =>
                  setVicPct(Math.min(100, Math.max(0, Math.round(Number(e.target.value) || 0))))
                }
                className="w-[64px] border border-neutral-300 px-2 py-1 text-right tabular-nums focus:border-brand-orange focus:outline-none"
              />
              <span>% · NSW {100 - vicPct}%</span>
            </div>
          )}

          <label className="mt-3 flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={sm}
              disabled={busy}
              onChange={(e) => setSm(e.target.checked)}
              className="h-3.5 w-3.5 accent-brand-orange"
            />
            Site manager (fixed bonus, no pool pro-rating and no Discretionary)
          </label>

          <p className="mt-3 text-[11px] font-semibold text-brand-70">
            The spreadsheet import stays the source of truth. Add{" "}
            {gn.trim() || "this person"} to the next workbook as well, or the
            next import will drop them from the model.
          </p>

          <button
            type="button"
            disabled={busy || !ready}
            onClick={submit}
            className="mt-3 bg-brand-orange px-4 py-1.5 text-[12px] font-bold text-white transition-colors hover:bg-brand-orange-hover disabled:opacity-50"
          >
            {busy ? "Saving…" : "Add person"}
          </button>
        </div>
      </div>
    </div>
  );
}
