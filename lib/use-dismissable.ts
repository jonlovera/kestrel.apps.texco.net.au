"use client";

import { useEffect, type RefObject } from "react";

/**
 * Close-on-outside-click and close-on-Escape for a popover or menu. Listeners
 * exist only while `open` is true, so a page full of closed menus costs
 * nothing. Mousedown rather than click, so dragging a selection out of the
 * panel doesn't dismiss it.
 */
export function useDismissable(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void
) {
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
    // onClose is a state setter in every caller; re-subscribing on its
    // identity would tear the listeners down every render for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ref]);
}
