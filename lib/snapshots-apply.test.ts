/**
 * applyState — the half of a restore that writes.
 *
 * One assertion here matters more than the rest: a restore must never be able
 * to lock out the person performing it. That behaviour has always been in
 * restoreSnapshot and has never had a test naming it, and it has just gained a
 * second caller in the backup-file restore — where it matters more, because
 * the access overlay in an uploaded file is whatever somebody put there.
 *
 * The store is mocked rather than reached. The suite runs without Postgres and
 * the dev-file fallback only engages under NODE_ENV=development, so the choice
 * is between mocking and not testing this at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Snapshot } from "./schema";

const saved = {
  dataset: undefined as unknown,
  overrides: undefined as unknown,
  access: undefined as unknown,
  columns: "untouched" as unknown,
  params: "untouched" as unknown,
  copy: "untouched" as unknown,
  history: [] as unknown[],
};

/** What the access overlay holds before the restore runs. */
let currentAccess: Record<string, unknown> = {};

vi.mock("./store", () => ({
  saveStoredDataset: vi.fn(async (d: unknown) => void (saved.dataset = d)),
  saveOverridesForce: vi.fn(async (d: unknown) => void (saved.overrides = d)),
  saveColumnConfig: vi.fn(async (d: unknown) => void (saved.columns = d)),
  clearColumnConfig: vi.fn(async () => void (saved.columns = "cleared")),
  saveParams: vi.fn(async (d: unknown) => void (saved.params = d)),
  clearParams: vi.fn(async () => void (saved.params = "cleared")),
  saveCopy: vi.fn(async (d: unknown) => void (saved.copy = d)),
  clearCopy: vi.fn(async () => void (saved.copy = "cleared")),
  loadAccessOverlay: vi.fn(async () => currentAccess),
  saveAccessOverlay: vi.fn(async (d: unknown) => void (saved.access = d)),
  appendHistory: vi.fn(async (e: unknown[]) => void saved.history.push(...e)),
  // reached only by captureState/takeSnapshot, which these tests never call
  loadOverrides: vi.fn(),
  loadOverridesVersion: vi.fn(),
  loadColumnConfig: vi.fn(),
  loadCopy: vi.fn(),
  loadParams: vi.fn(),
  loadSnapshots: vi.fn(async () => []),
  loadSnapshotByTs: vi.fn(),
  pushSnapshot: vi.fn(),
}));
vi.mock("./data", () => ({ getDataset: vi.fn() }));

const { applyState } = await import("./snapshots");
const { AccessRuleSchema } = await import("./access-rules");

const ME = "me@texco.net.au";
const LEAD = "lead@texco.net.au";

const fullRule = { type: "full", canEditCaps: false, canActAs: [] };
const leadRule = {
  type: "state",
  states: ["VIC"],
  visibleFields: ["final"],
  editableFields: ["da"],
  canLock: false,
  canActAs: [],
};

function state(access: unknown): Snapshot["state"] {
  return {
    dataset: {
      emp: [],
      vCap: 1,
      nCap: 1,
      gCap: 2,
      cats: [],
      depts: [],
      mgrs: [],
      excludedIds: [],
    } as unknown as Snapshot["state"]["dataset"],
    overrides: {},
    params: null,
    columns: null,
    copy: null,
    access,
  };
}

beforeEach(() => {
  saved.access = undefined;
  saved.columns = "untouched";
  saved.params = "untouched";
  saved.copy = "untouched";
  saved.history = [];
  currentAccess = {};
});

describe("a restore cannot lock out the admin running it", () => {
  it("keeps the actor's CURRENT access, not the one in the state", () => {
    // The state grants them nothing. Applying it verbatim would remove their
    // own access as a side effect of their own click, with no way back in.
    currentAccess = { [ME]: fullRule, [LEAD]: leadRule };
    return applyState(state({ [LEAD]: leadRule }), ME, "a test").then(() => {
      const overlay = saved.access as Record<string, unknown>;
      // The actor's rule comes back verbatim: it is carried over from what
      // they hold now, never round-tripped through the state.
      expect(overlay[ME]).toEqual(fullRule);
      // Everyone else's is the state's, parsed — so it gains the defaults for
      // any grant added since the state was captured. Compared through the
      // schema rather than against the literal, so adding another grant later
      // does not break this test for no reason.
      expect(overlay[LEAD]).toEqual(AccessRuleSchema.parse(leadRule));
    });
  });

  it("does not invent access the actor does not currently hold", () => {
    // The mirror image: the state grants them full access but they hold none
    // now, so a restore must not be a way to promote yourself.
    currentAccess = {};
    return applyState(state({ [ME]: fullRule, [LEAD]: leadRule }), ME, "a test").then(
      () => {
        const overlay = saved.access as Record<string, unknown>;
        expect(overlay).not.toHaveProperty(ME);
        expect(overlay[LEAD]).toEqual(AccessRuleSchema.parse(leadRule));
      }
    );
  });

  it("leaves access alone when the state carries none", async () => {
    // Old snapshots predate access being captured. Nothing was recorded, so
    // there is nothing to restore to — clearing would be worse than skipping.
    currentAccess = { [ME]: fullRule };
    await applyState(state(undefined), ME, "a test");
    expect(saved.access).toBeUndefined();
  });

  it("leaves access alone when the state's overlay is unreadable", async () => {
    currentAccess = { [ME]: fullRule };
    await applyState(state({ [LEAD]: { type: "nonsense" } }), ME, "a test");
    expect(saved.access).toBeUndefined();
  });
});

describe("documents missing from the state are cleared, not left as they are", () => {
  it("clears params, columns and copy rather than keeping today's", async () => {
    // Keeping today's caps across an old restore is a wrong set of figures
    // wearing a restored label.
    await applyState(state(undefined), ME, "a test");
    expect(saved.params).toBe("cleared");
    expect(saved.columns).toBe("cleared");
    expect(saved.copy).toBe("cleared");
  });
});

describe("the audit trail", () => {
  it("records the restore and names where the state came from", async () => {
    await applyState(state(undefined), ME, "backup file taken yesterday");
    expect(saved.history).toHaveLength(1);
    const entry = saved.history[0] as { kind: string; actor: string; summary: string };
    expect(entry.kind).toBe("restore");
    expect(entry.actor).toBe(ME);
    // The source is the difference between "someone restored a snapshot" and
    // "someone uploaded a file and replaced everything" in the log.
    expect(entry.summary).toContain("backup file taken yesterday");
  });
});
