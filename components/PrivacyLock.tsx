"use client";

import { useEffect, useState } from "react";
import { TexcoX } from "./TexcoBrand";

/**
 * Quick privacy screen: press Space (outside any input) to instantly cover
 * the page. Unlocking is a deliberate click — a bumped key won't reveal the
 * data. The lock screen shows nothing about what the app is.
 */
export function PrivacyLock() {
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== " " || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.tagName === "BUTTON" ||
          t.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      setLocked(true);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!locked) return null;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-[#191919]">
      <TexcoX className="mb-8 h-12 w-12" />
      <button
        type="button"
        onClick={() => setLocked(false)}
        className="rounded-md border border-[#FC4D0F]/50 px-6 py-2.5 text-[12px] font-bold uppercase tracking-[2px] text-[#F79470] transition-colors hover:bg-[#FC4D0F] hover:text-white"
      >
        Resume
      </button>
    </div>
  );
}
