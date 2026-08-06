"use client";

import { useMemo, useState } from "react";
import type { Employee } from "@/lib/schema";
import type { DatasetPatch } from "@/lib/dataset-edit";
import { fmt } from "@/lib/fmt";

/**
 * The per-employee drawer: the fields that don't belong in a table cell
 * (the pool split, the site-manager flag), plus removing someone — and the
 * same form in "add" mode for a new starter.
 *
 * Every change here goes through /api/dataset, which revalidates it against
 * lib/dataset-edit.ts. The client-side checks below are for fast feedback
 * only; the server is what actually decides.
 */

type Mode =
  | { kind: "edit"; employee: Employee }
  | { kind: "add" };

interface Props {
  mode: Mode;
  cats: string[];
  depts: string[];
  mgrs: string[];
  busy: boolean;
  error: string | null;
  onSubmit: (patch: DatasetPatch) => Promise<boolean>;
  onClose: () => void;
}

const STATES = ["VIC", "NSW", "SHARED"] as const;

const pct = (v: number) => Math.round(v * 1000) / 10;

const label = "mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[#5C5C5C]";
const field =
  "w-full rounded border border-neutral-300 px-2 py-1.5 text-[13px] outline-none focus:border-[#FC4D0F] disabled:bg-neutral-100 disabled:text-neutral-400";

export default function EmployeeEditor({
  mode,
  cats,
  depts,
  mgrs,
  busy,
  error,
  onSubmit,
  onClose,
}: Props) {
  const adding = mode.kind === "add";
  const existing = mode.kind === "edit" ? mode.employee : null;

  // ── pool split (edit mode) ────────────────────────────────────────────────
  const [vicPct, setVicPct] = useState(pct(existing?.vp ?? 100));
  const [nswPct, setNswPct] = useState(pct(existing?.np ?? 0));
  const [sm, setSm] = useState<0 | 1>(existing?.sm ?? 0);

  // ── new starter (add mode) ────────────────────────────────────────────────
  const [draft, setDraft] = useState({
    id: "",
    gn: "",
    sn: "",
    pos: "",
    dept: depts[0] ?? "",
    mgr: mgrs[0] ?? "",
    cat: cats[0] ?? "Employee",
    st: "VIC" as (typeof STATES)[number],
    pkg: "",
    bp: "10",
    ipm: "100",
    bipm: "",
    f25: "0",
  });

  const set = <K extends keyof typeof draft>(k: K, v: (typeof draft)[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  // A new starter's After IPM anchors their whole bonus (lib/calc.ts derives
  // the company modifier from it), so suggest the figure that means "modifier
  // of exactly 1.0" until the user types their own.
  const suggestedBipm = useMemo(() => {
    const pkg = Number(draft.pkg);
    const bp = Number(draft.bp) / 100;
    const ipm = Number(draft.ipm) / 100;
    if (!Number.isFinite(pkg) || !pkg || !Number.isFinite(bp) || !Number.isFinite(ipm))
      return null;
    return Math.round(pkg * bp * ipm);
  }, [draft.pkg, draft.bp, draft.ipm]);

  // the state drives the split: VIC/NSW are single-pool, SHARED is a mix
  const state = adding ? draft.st : existing!.st;

  /** Picking a state on a new starter presets a split that will validate. */
  function changeState(st: (typeof STATES)[number]) {
    set("st", st);
    if (st === "VIC") { setVicPct(100); setNswPct(0); }
    else if (st === "NSW") { setVicPct(0); setNswPct(100); }
    else { setVicPct(50); setNswPct(50); }
  }

  function changeVic(v: number) {
    setVicPct(v);
    if (state === "SHARED") setNswPct(Math.round((100 - v) * 10) / 10);
  }
  function changeNsw(v: number) {
    setNswPct(v);
    if (state === "SHARED") setVicPct(Math.round((100 - v) * 10) / 10);
  }

  const inPool = vicPct > 0 || nswPct > 0;
  const splitOk = !inPool || Math.abs(vicPct + nswPct - 100) < 0.05;

  async function submitAdd() {
    const employee: Employee = {
      id: draft.id.trim().toUpperCase(),
      sn: draft.sn.trim(),
      gn: draft.gn.trim(),
      pos: draft.pos.trim(),
      dept: draft.dept.trim(),
      mgr: draft.mgr.trim(),
      cat: draft.cat.trim(),
      st: draft.st,
      vp: vicPct / 100,
      np: nswPct / 100,
      pkg: Number(draft.pkg) || 0,
      bp: Number(draft.bp) / 100,
      ipm: Number(draft.ipm) / 100,
      bipm: draft.bipm === "" ? (suggestedBipm ?? 0) : Number(draft.bipm),
      da: 0,
      f25: Number(draft.f25) || 0,
      sm,
    };
    if (await onSubmit({ op: "add", employee })) onClose();
  }

  async function submitEdit() {
    const e = existing!;
    const vp = vicPct / 100;
    const np = nswPct / 100;
    let ok = true;
    if (vp !== e.vp || np !== e.np) ok = await onSubmit({ op: "split", id: e.id, vp, np });
    if (ok && sm !== e.sm)
      ok = await onSubmit({ op: "field", id: e.id, field: "sm", value: sm });
    if (ok) onClose();
  }

  async function remove() {
    const e = existing!;
    if (
      !confirm(
        `Remove ${e.gn} ${e.sn} from the scheme?\n\nTheir row goes, and any Bonus%, IPM% or discretionary adjustment entered for them goes with it. A snapshot is taken first, so this can be undone from Snapshots.`
      )
    )
      return;
    if (await onSubmit({ op: "remove", id: e.id })) onClose();
  }

  const addReady =
    draft.id.trim() !== "" &&
    draft.gn.trim() !== "" &&
    draft.sn.trim() !== "" &&
    draft.pos.trim() !== "" &&
    draft.dept.trim() !== "" &&
    draft.mgr.trim() !== "" &&
    draft.pkg !== "" &&
    splitOk;

  const dirty =
    !adding &&
    (vicPct !== pct(existing!.vp) || nswPct !== pct(existing!.np) || sm !== existing!.sm);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="absolute inset-0 bg-black/30"
        onClick={busy ? undefined : onClose}
        aria-hidden
      />
      <div className="relative flex h-full w-full max-w-[440px] flex-col overflow-auto bg-white shadow-2xl">
        <div className="sticky top-0 flex items-start justify-between bg-[#191919] px-5 py-3.5">
          <div>
            <h2 className="text-[13px] font-bold uppercase tracking-[1.5px] text-white">
              {adding ? "Add a person" : `${existing!.gn} ${existing!.sn}`}
            </h2>
            {!adding && (
              <p className="mt-0.5 text-[11px] text-[#F79470]">
                {existing!.pos} · {existing!.dept}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="ml-4 rounded border border-[#FC4D0F]/50 px-2.5 py-1 text-[11px] font-semibold uppercase text-[#F79470] hover:bg-[#FC4D0F] hover:text-white disabled:opacity-40"
          >
            Close
          </button>
        </div>

        <div className="flex-1 px-5 py-4">
          {error && (
            <div className="mb-4 rounded-md border-2 border-[#FC4D0F] bg-[#FED9CC] px-3 py-2 text-[13px] font-semibold">
              {error}
            </div>
          )}

          {adding && (
            <>
              <div className="mb-4 grid grid-cols-2 gap-3">
                <div>
                  <label className={label}>Employee id</label>
                  <input
                    className={field}
                    value={draft.id}
                    onChange={(e) => set("id", e.target.value)}
                    placeholder="e.g. SMIJA"
                  />
                </div>
                <div>
                  <label className={label}>Category</label>
                  <input className={field} list="cat-list" value={draft.cat}
                    onChange={(e) => set("cat", e.target.value)} />
                  <datalist id="cat-list">
                    {cats.map((c) => <option key={c} value={c} />)}
                  </datalist>
                </div>
                <div>
                  <label className={label}>Given name</label>
                  <input className={field} value={draft.gn}
                    onChange={(e) => set("gn", e.target.value)} />
                </div>
                <div>
                  <label className={label}>Surname</label>
                  <input className={field} value={draft.sn}
                    onChange={(e) => set("sn", e.target.value)} />
                </div>
                <div className="col-span-2">
                  <label className={label}>Position</label>
                  <input className={field} value={draft.pos}
                    onChange={(e) => set("pos", e.target.value)} />
                </div>
                <div>
                  <label className={label}>Department</label>
                  <input className={field} list="dept-list" value={draft.dept}
                    onChange={(e) => set("dept", e.target.value)} />
                  <datalist id="dept-list">
                    {depts.map((d) => <option key={d} value={d} />)}
                  </datalist>
                </div>
                <div>
                  <label className={label}>Manager</label>
                  <input className={field} list="mgr-list" value={draft.mgr}
                    onChange={(e) => set("mgr", e.target.value)} />
                  <datalist id="mgr-list">
                    {mgrs.map((m) => <option key={m} value={m} />)}
                  </datalist>
                </div>
                <div className="col-span-2">
                  <label className={label}>State</label>
                  <select className={field} value={draft.st}
                    onChange={(e) => changeState(e.target.value as (typeof STATES)[number])}>
                    {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>

              <div className="mb-4 grid grid-cols-2 gap-3 border-t border-neutral-200 pt-4">
                <div>
                  <label className={label}>Package $</label>
                  <input className={field} inputMode="numeric" value={draft.pkg}
                    onChange={(e) => set("pkg", e.target.value)} placeholder="200000" />
                </div>
                <div>
                  <label className={label}>FY25 bonus $</label>
                  <input className={field} inputMode="numeric" value={draft.f25}
                    onChange={(e) => set("f25", e.target.value)} />
                </div>
                <div>
                  <label className={label}>Bonus %</label>
                  <input className={field} inputMode="decimal" value={draft.bp}
                    onChange={(e) => set("bp", e.target.value)} />
                </div>
                <div>
                  <label className={label}>IPM %</label>
                  <input className={field} inputMode="decimal" value={draft.ipm}
                    onChange={(e) => set("ipm", e.target.value)} />
                </div>
                <div className="col-span-2">
                  <label className={label}>After IPM $</label>
                  <input
                    className={field}
                    inputMode="numeric"
                    value={draft.bipm}
                    onChange={(e) => set("bipm", e.target.value)}
                    placeholder={suggestedBipm !== null ? String(suggestedBipm) : ""}
                  />
                  <p className="mt-1 text-[11px] text-[#5C5C5C]">
                    This figure anchors their bonus. Leave it blank to use{" "}
                    {suggestedBipm !== null ? fmt(suggestedBipm) : "package × bonus % × IPM %"}{" "}
                    — package × bonus % × IPM %, i.e. a company modifier of 1.0.
                  </p>
                </div>
              </div>
            </>
          )}

          {/* pool split — both modes */}
          <div className="mb-4 border-t border-neutral-200 pt-4">
            <h3 className="mb-2 text-[12px] font-bold uppercase tracking-wide">
              Pool split
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>VIC share %</label>
                <input
                  className={field}
                  inputMode="decimal"
                  disabled={state === "NSW"}
                  value={vicPct}
                  onChange={(e) => changeVic(Number(e.target.value) || 0)}
                />
              </div>
              <div>
                <label className={label}>NSW share %</label>
                <input
                  className={field}
                  inputMode="decimal"
                  disabled={state === "VIC"}
                  value={nswPct}
                  onChange={(e) => changeNsw(Number(e.target.value) || 0)}
                />
              </div>
            </div>
            <p className={`mt-1.5 text-[11px] ${splitOk ? "text-[#5C5C5C]" : "font-semibold text-[#FC4D0F]"}`}>
              {splitOk
                ? inPool
                  ? "Which pool their bonus is drawn from. Must add up to 100%."
                  : "0% / 0% — outside both pools, so their bonus doesn't count against either cap."
                : `Currently ${Math.round((vicPct + nswPct) * 10) / 10}% — the shares must add up to 100%, or both be 0%.`}
            </p>
            {!adding && (
              <label className="mt-3 flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[#FC4D0F]"
                  checked={sm === 1}
                  onChange={(e) => setSm(e.target.checked ? 1 : 0)}
                />
                Site manager — fixed bonus, not redistributed and not adjustable
              </label>
            )}
          </div>

          <p className="mb-4 rounded-md bg-neutral-100 px-3 py-2 text-[11px] leading-5 text-[#5C5C5C]">
            These are payroll facts, so they live in the source data and{" "}
            <strong>are replaced the next time a spreadsheet is imported</strong>.
            Bonus %, IPM % and discretionary adjustments are your entries — those
            survive an import. A snapshot is taken before every change.
          </p>

          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={busy || (adding ? !addReady : !dirty)}
              onClick={adding ? submitAdd : submitEdit}
              className="rounded-md bg-[#FC4D0F] px-5 py-2.5 text-[12px] font-bold uppercase tracking-[2px] text-white transition-colors hover:bg-[#e0440d] disabled:opacity-40"
            >
              {busy ? "Saving…" : adding ? "Add person" : "Save changes"}
            </button>
            {!adding && (
              <button
                type="button"
                disabled={busy}
                onClick={remove}
                className="ml-auto rounded-md border-2 border-[#FC4D0F] px-4 py-2 text-[12px] font-bold uppercase tracking-wide text-[#FC4D0F] transition-colors hover:bg-[#FED9CC] disabled:opacity-40"
              >
                Remove person
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
