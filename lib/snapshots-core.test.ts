import { describe, it, expect } from "vitest";
import { shouldCoalesce } from "./snapshots-core";

/**
 * Coalescing existed to stop a debounced autosave evicting the 50-slot
 * snapshot window in minutes. Saving is now an explicit button press, so one
 * save is one deliberate act and gets one restore point.
 */
describe("snapshot policy", () => {
  it("never coalesces — every save gets its own restore point", () => {
    expect(shouldCoalesce()).toBe(false);
  });
});
