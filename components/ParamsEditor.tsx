"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import type { Dataset, Overrides } from "@/lib/schema";
import { ParamsSchema, applyParams, type Params } from "@/lib/params-apply";
import { applyOverrides, computeScalesAndBonuses } from "@/lib/calc";
import { fmt } from "@/lib/fmt";
import { TexcoX, TexcoWordmark } from "./TexcoBrand";

/** Rerun the real engine (same pure modules the server uses) for a preview. */
function preview(dataset: Dataset, overrides: Overrides, params: Params) {
  const eff = applyParams(dataset, params);
  const emps = applyOverrides(eff.emp, overrides);
  const pool = computeScalesAndBonuses(emps, eff);
  const total = emps.reduce((s, e) => s + e.finalBonus, 0);
  return {
    vicScale: pool.vicScale,
    nswScale: pool.nswScale,
    total,
    groupRemaining: eff.gCap - total,
  };
}

export default function ParamsEditor({
  dataset,
  overrides,
  current,
  saveAction,
}: {
  dataset: Dataset;
  overrides: Overrides;
  current: Params;
  saveAction: (formData: FormData) => Promise<void>;
}) {
  const [form, setForm] = useState({
    vCap: String(current.vCap),
    nCap: String(current.nCap),
    gCap: String(current.gCap),
    companyModifier: String(current.companyModifier),
  });
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  const candidate = useMemo(() => {
    const parsed = ParamsSchema.safeParse({
      vCap: Number(form.vCap),
      nCap: Number(form.nCap),
      gCap: Number(form.gCap),
      companyModifier: Number(form.companyModifier),
    });
    return parsed.success ? parsed.data : null;
  }, [form]);

  const now = useMemo(
    () => preview(dataset, overrides, current),
    [dataset, overrides, current]
  );
  const next = useMemo(
    () => (candidate ? preview(dataset, overrides, candidate) : null),
    [dataset, overrides, candidate]
  );

  const capsMismatch =
    candidate && Math.abs(candidate.vCap + candidate.nCap - candidate.gCap) > 0.01;

  function set(k: keyof typeof form, v: string) {
    setSaved(false);
    setForm((f) => ({ ...f, [k]: v }));
  }

  function submit() {
    if (!candidate) return;
    const fd = new FormData();
    fd.set("vCap", String(candidate.vCap));
    fd.set("nCap", String(candidate.nCap));
    fd.set("gCap", String(candidate.gCap));
    fd.set("companyModifier", String(candidate.companyModifier));
    startTransition(async () => {
      await saveAction(fd);
      setSaved(true);
    });
  }

  const inputCls =
    "w-[180px] rounded-md border-2 border-neutral-200 px-3 py-2 text-[14px] tabular-nums outline-none focus:border-[#FC4D0F]";
  const delta = (a: number, b: number, fmtFn: (n: number) => string) =>
    a === b ? (
      <span className="text-neutral-400">unchanged</span>
    ) : (
      <span className="font-bold">
        {fmtFn(a)} → {fmtFn(b)}
      </span>
    );

  return (
    <div className="flex min-h-screen flex-col">
      <div className="sticky top-0 z-40 flex items-center justify-between bg-[#191919] px-6 py-3">
        <div className="flex items-center">
          <TexcoX className="mr-2.5 h-[22px] w-[22px] shrink-0" />
          <TexcoWordmark className="mr-4 h-[18px] w-auto shrink-0" />
          <span className="hidden text-xs font-medium uppercase tracking-[2px] text-[#FC4D0F] sm:inline">
            Scheme parameters
          </span>
        </div>
        <Link
          href="/"
          className="rounded border border-[#FC4D0F]/50 px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#F79470] transition-colors hover:bg-[#FC4D0F] hover:text-white"
        >
          Back to dashboard
        </Link>
      </div>

      <div className="mx-auto w-full max-w-[900px] flex-1 px-5 py-6">
        <h1 className="mb-1 text-lg font-bold">Scheme parameters</h1>
        <p className="mb-4 text-[13px] text-[#5C5C5C]">
          The pool caps and the company-wide modifier. The preview below reruns
          the full calculation with your candidate values before anything is
          saved; a snapshot is taken automatically on save so it can be undone.
        </p>

        <div className="mb-5 rounded-lg border-t-4 border-[#FC4D0F] bg-white p-5 shadow-sm">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {(
              [
                ["vCap", "VIC pool cap ($)"],
                ["nCap", "NSW pool cap ($)"],
                ["gCap", "Group cap ($)"],
                ["companyModifier", "Company modifier (1 = no change)"],
              ] as const
            ).map(([k, label]) => (
              <label key={k} className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[#5C5C5C]">
                  {label}
                </span>
                <input
                  type="number"
                  step="any"
                  value={form[k]}
                  onChange={(e) => set(k, e.target.value)}
                  className={inputCls}
                />
              </label>
            ))}
          </div>
          {!candidate && (
            <p className="mt-3 text-[13px] font-semibold text-[#FC4D0F]">
              Values out of range — caps must be positive (VIC/NSW ≤ $50M) and
              the modifier between 0.1 and 2.
            </p>
          )}
          {capsMismatch && (
            <p className="mt-3 text-[13px] text-[#5C5C5C]">
              Note: group cap ≠ VIC + NSW ({fmt(candidate!.vCap + candidate!.nCap)}).
              Allowed, but check it&apos;s intentional.
            </p>
          )}
        </div>

        <div className="mb-5 rounded-lg bg-white p-5 shadow-sm">
          <h2 className="mb-3 text-[13px] font-bold uppercase tracking-[1.5px]">
            Impact preview (current → candidate)
          </h2>
          {next ? (
            <div className="grid grid-cols-1 gap-2 text-[13px] sm:grid-cols-2">
              <div>VIC scale factor: {delta(now.vicScale, next.vicScale, (n) => n.toFixed(4) + "x")}</div>
              <div>NSW scale factor: {delta(now.nswScale, next.nswScale, (n) => n.toFixed(4) + "x")}</div>
              <div>Total bonus pool: {delta(now.total, next.total, fmt)}</div>
              <div>
                Group remaining:{" "}
                <span className={next.groupRemaining < 0 ? "font-bold text-[#FC4D0F]" : "font-bold"}>
                  {fmt(next.groupRemaining)}
                </span>
              </div>
            </div>
          ) : (
            <p className="text-[13px] text-neutral-400">Fix the values above to see the impact.</p>
          )}
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={pending || !candidate}
            onClick={submit}
            className="rounded-md bg-[#FC4D0F] px-6 py-2.5 text-[12px] font-bold uppercase tracking-[2px] text-white transition-colors hover:bg-[#e0440d] disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save parameters"}
          </button>
          {saved && !pending && (
            <span className="text-[13px] font-semibold text-[#191919]">
              Saved — every calculation now uses these values.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
