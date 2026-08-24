"use client";

import { useEffect, useState } from "react";

/**
 * Collapses the header region while the given scroller is scrolled down,
 * expands it again near the top.
 *
 * Takes the element itself (from a callback ref held in state), not a ref
 * object: the table unmounts on the History tab, and an effect keyed on a
 * ref would never re-attach to the replacement element.
 *
 * Two thresholds (hysteresis) so the boundary never flickers, and a
 * minimum-overflow guard: collapsing the header makes the scroller taller,
 * which on a short list lets the browser clamp scrollTop back under the
 * expand threshold — expand, shrink, clamp, collapse, forever. Requiring a
 * comfortable amount of overflow before collapsing kills that loop; a list
 * short enough to trip it didn't need the extra room anyway.
 */
export function useScrollCollapse(
  el: HTMLElement | null,
  { collapseAt = 48, expandAt = 8, minOverflow = 220 } = {}
) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!el) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const y = el.scrollTop;
      const room = el.scrollHeight - el.clientHeight;
      setCollapsed((c) => (c ? y > expandAt : y > collapseAt && room > minOverflow));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    measure();
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [el, collapseAt, expandAt, minOverflow]);

  return collapsed;
}
