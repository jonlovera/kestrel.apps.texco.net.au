import { describe, it, expect } from "vitest";
import { shouldCoalesce } from "./snapshots-core";

/**
 * Coalescing exists so the 3-minute autosave cannot evict the 50-slot
 * snapshot window: consecutive autosaves by the same person within ten
 * minutes share one restore point. A manual Save stays one deliberate act
 * with its own restore point, always.
 */
describe("snapshot coalescing policy", () => {
  const now = new Date("2026-08-20T10:00:00Z");
  const at = (minsAgo: number) =>
    new Date(now.getTime() - minsAgo * 60_000).toISOString();

  it("a manual Save never coalesces, even straight after an autosave", () => {
    expect(
      shouldCoalesce({ ts: at(1), actor: "a@texco.net.au", reason: "autosave" }, "a@texco.net.au", "edit", now)
    ).toBe(false);
  });

  it("an autosave shortly after the same person's autosave coalesces", () => {
    expect(
      shouldCoalesce({ ts: at(3), actor: "a@texco.net.au", reason: "autosave" }, "a@texco.net.au", "autosave", now)
    ).toBe(true);
  });

  it("an autosave shortly after the same person's manual Save coalesces onto it", () => {
    expect(
      shouldCoalesce({ ts: at(3), actor: "a@texco.net.au", reason: "edit" }, "a@texco.net.au", "autosave", now)
    ).toBe(true);
  });

  it("a different person's autosave gets its own restore point", () => {
    expect(
      shouldCoalesce({ ts: at(1), actor: "a@texco.net.au", reason: "autosave" }, "b@texco.net.au", "autosave", now)
    ).toBe(false);
  });

  it("an autosave after the window has gone stale gets its own restore point", () => {
    expect(
      shouldCoalesce({ ts: at(11), actor: "a@texco.net.au", reason: "autosave" }, "a@texco.net.au", "autosave", now)
    ).toBe(false);
  });

  it("the very first save has nothing to coalesce onto", () => {
    expect(shouldCoalesce(undefined, "a@texco.net.au", "autosave", now)).toBe(false);
  });

  it("admin actions never coalesce, in either direction", () => {
    // A dataset edit, an import or a pre-restore point must each stand alone,
    // and an autosave must not ride on one of them either.
    for (const reason of ["dataset", "pre-restore", "import"]) {
      expect(
        shouldCoalesce({ ts: at(1), actor: "a@texco.net.au", reason: "autosave" }, "a@texco.net.au", reason, now)
      ).toBe(false);
      expect(
        shouldCoalesce({ ts: at(1), actor: "a@texco.net.au", reason }, "a@texco.net.au", "autosave", now)
      ).toBe(false);
    }
  });

  it("an unparseable previous timestamp fails safe: take the snapshot", () => {
    expect(
      shouldCoalesce({ ts: "not-a-date", actor: "a@texco.net.au", reason: "autosave" }, "a@texco.net.au", "autosave", now)
    ).toBe(false);
  });
});
