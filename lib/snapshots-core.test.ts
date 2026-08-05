import { describe, it, expect } from "vitest";
import { shouldCoalesce, EDIT_COALESCE_MS } from "./snapshots-core";

const T0 = "2026-08-05T10:00:00.000Z";
const plus = (ms: number) => new Date(new Date(T0).getTime() + ms).toISOString();

describe("snapshot coalescing", () => {
  const newest = { ts: T0, actor: "a@x.com", reason: "edit" };

  it("coalesces rapid edit saves by the same actor", () => {
    expect(shouldCoalesce(newest, "a@x.com", "edit", plus(1000))).toBe(true);
    expect(shouldCoalesce(newest, "a@x.com", "edit", plus(EDIT_COALESCE_MS - 1))).toBe(true);
  });

  it("does not coalesce after the window, across actors, or for other reasons", () => {
    expect(shouldCoalesce(newest, "a@x.com", "edit", plus(EDIT_COALESCE_MS + 1))).toBe(false);
    expect(shouldCoalesce(newest, "b@x.com", "edit", plus(1000))).toBe(false);
    expect(shouldCoalesce(newest, "a@x.com", "import", plus(1000))).toBe(false);
    expect(
      shouldCoalesce({ ...newest, reason: "import" }, "a@x.com", "edit", plus(1000))
    ).toBe(false);
  });

  it("never coalesces when there is no previous snapshot", () => {
    expect(shouldCoalesce(undefined, "a@x.com", "edit", plus(0))).toBe(false);
  });
});
