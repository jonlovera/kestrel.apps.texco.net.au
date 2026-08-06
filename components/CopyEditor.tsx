"use client";

import { useState, useTransition } from "react";
import type { Copy } from "@/lib/copy";

/**
 * /admin/text — the dashboard's wording. Presentation only: nothing here
 * changes a figure or who is allowed to see one (lib/copy.test.ts asserts it).
 */
export default function CopyEditor({
  initial,
  defaults,
  saveAction,
  resetAction,
}: {
  initial: Copy;
  defaults: Copy;
  saveAction: (formData: FormData) => Promise<void>;
  resetAction: () => Promise<void>;
}) {
  const [copy, setCopy] = useState<Copy>(initial);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  function set<K extends keyof Copy>(key: K, value: Copy[K]) {
    setSaved(false);
    setCopy((prev) => ({ ...prev, [key]: value }));
  }

  function setPool(key: keyof Copy["poolTitles"], value: string) {
    setSaved(false);
    setCopy((prev) => ({ ...prev, poolTitles: { ...prev.poolTitles, [key]: value } }));
  }

  function submit() {
    const fd = new FormData();
    fd.set("schemeName", copy.schemeName);
    fd.set("bannerText", copy.bannerText);
    if (copy.bannerVisible) fd.set("bannerVisible", "on");
    fd.set("poolVic", copy.poolTitles.vic);
    fd.set("poolNsw", copy.poolTitles.nsw);
    fd.set("poolGroup", copy.poolTitles.group);
    fd.set("footerText", copy.footerText);
    setError("");
    startTransition(async () => {
      try {
        await saveAction(fd);
        setSaved(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : "That wording could not be saved.");
      }
    });
  }

  function reset() {
    if (!confirm("Put every heading and label back to the original wording?")) return;
    setError("");
    startTransition(async () => {
      try {
        await resetAction();
        setCopy(defaults);
        setSaved(true);
      } catch {
        setError("The reset could not be saved.");
      }
    });
  }

  const inputCls =
    "w-full rounded-md border-2 border-neutral-200 px-2.5 py-1.5 text-[13px] outline-none focus:border-[#FC4D0F]";
  const labelCls =
    "mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[#5C5C5C]";

  const field = (
    key: "schemeName" | "bannerText" | "footerText",
    heading: string,
    hint: string,
    maxLength: number
  ) => (
    <div className="mb-4">
      <label className={labelCls}>{heading}</label>
      <input
        className={inputCls}
        maxLength={maxLength}
        value={copy[key]}
        onChange={(e) => set(key, e.target.value)}
      />
      <p className="mt-1 text-[12px] text-[#5C5C5C]">
        {hint} Default: <em>{defaults[key]}</em>
      </p>
    </div>
  );

  return (
    <div>
      <div className="mx-auto w-full max-w-[900px] flex-1 px-5 py-6">
        <h1 className="mb-1 text-lg font-bold">Headings and wording</h1>
        <p className="mb-4 text-[13px] text-[#5C5C5C]">
          The words on the dashboard — the scheme name in the header, the status
          banner, the pool card titles and the footer. Display only: this never
          changes a figure, a calculation, or who is allowed to see what. A
          snapshot is taken before each save, so any wording can be rolled back
          from Snapshots.
        </p>

        {error && (
          <div className="mb-4 rounded-md border-2 border-[#FC4D0F] bg-[#FED9CC] px-4 py-2 text-[13px] font-semibold">
            {error}
          </div>
        )}

        <div className="mb-5 rounded-lg border-t-4 border-[#FC4D0F] bg-white p-5 shadow-sm">
          {field(
            "schemeName",
            "Scheme name (header)",
            "Shown beside the logo at the top of the dashboard.",
            80
          )}

          <div className="mb-4">
            <label className={labelCls}>Status banner</label>
            <input
              className={inputCls}
              maxLength={80}
              value={copy.bannerText}
              disabled={!copy.bannerVisible}
              onChange={(e) => set("bannerText", e.target.value)}
            />
            <label className="mt-2 flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[#FC4D0F]"
                checked={copy.bannerVisible}
                onChange={(e) => set("bannerVisible", e.target.checked)}
              />
              Show the banner
            </label>
            <p className="mt-1 text-[12px] text-[#5C5C5C]">
              The orange strip under the header — change it to
              &ldquo;Final&rdquo; when the figures are signed off, or untick to
              hide it. Default: <em>{defaults.bannerText}</em>
            </p>
          </div>

          <div className="mb-4">
            <label className={labelCls}>Pool card titles</label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <input
                className={inputCls}
                maxLength={40}
                value={copy.poolTitles.vic}
                onChange={(e) => setPool("vic", e.target.value)}
              />
              <input
                className={inputCls}
                maxLength={40}
                value={copy.poolTitles.nsw}
                onChange={(e) => setPool("nsw", e.target.value)}
              />
              <input
                className={inputCls}
                maxLength={40}
                value={copy.poolTitles.group}
                onChange={(e) => setPool("group", e.target.value)}
              />
            </div>
            <p className="mt-1 text-[12px] text-[#5C5C5C]">
              The three cards above the table (VIC, NSW, group). Renaming a card
              doesn&apos;t change which employees it counts.
            </p>
          </div>

          {field(
            "footerText",
            "Footer",
            "The line at the very bottom of every dashboard page.",
            160
          )}
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={pending}
            onClick={submit}
            className="rounded-md bg-[#FC4D0F] px-6 py-2.5 text-[12px] font-bold uppercase tracking-[2px] text-white transition-colors hover:bg-[#e0440d] disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save wording"}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={reset}
            className="rounded-md bg-neutral-200 px-5 py-2.5 text-[12px] font-bold uppercase tracking-[2px] text-neutral-600 hover:bg-neutral-300 disabled:opacity-50"
          >
            Reset to defaults
          </button>
          {saved && !pending && (
            <span className="text-[13px] font-semibold text-[#FC4D0F]">Saved</span>
          )}
        </div>

        <p className="mt-6 rounded-md bg-neutral-100 px-4 py-3 text-[12px] leading-5 text-[#5C5C5C]">
          The browser tab title, the sign-in page and the no-access page are
          deliberately not editable here: they stay generic so the scheme
          isn&apos;t named on any page someone can reach before signing in.
        </p>
      </div>
    </div>
  );
}
