/**
 * The backup file's contract.
 *
 * The download and the restore are written together and then used months
 * apart, so what matters here is that they still agree — a backup that cannot
 * be restored is worse than no backup, because nobody finds out until the day
 * they need it. The refusals matter more than the acceptance: a file this
 * rewrites everything from must fail whole, never half.
 */
import { describe, it, expect } from "vitest";
import {
  BACKUP_VERSION,
  BackupSchema,
  backupFilename,
  buildBackup,
  describeBackupProblem,
} from "./backup";
import type { Snapshot } from "./schema";

const AT = new Date("2026-08-26T11:46:00+10:00");

/** The smallest thing captureState can legitimately return. */
function state(over: Partial<Snapshot["state"]> = {}): Snapshot["state"] {
  return {
    dataset: {
      emp: [
        {
          id: "A",
          sn: "Alpha",
          gn: "Ann",
          pos: "Role",
          dept: "Dept",
          mgr: "Mgr",
          cat: "Employee",
          st: "VIC",
          vp: 1,
          np: 0,
          pkg: 1000,
          bp: 0.1,
          ipm: 1,
          bipm: 100,
          da: 0,
          f25: 0,
          sm: 0,
        },
      ],
      vCap: 1000,
      nCap: 500,
      gCap: 1500,
      cats: ["Employee"],
      depts: ["Dept"],
      mgrs: ["Mgr"],
      excludedIds: [],
    },
    overrides: { A: { daEdit: 50 } },
    overridesVersion: 7,
    params: { vCap: 1000, nCap: 500, gCap: 1500, companyModifier: 1 },
    columns: null,
    copy: null,
    access: { "someone@texco.net.au": { type: "none" } },
    ...over,
  };
}

describe("the backup round trip", () => {
  it("accepts a file the download path produced", () => {
    // The assertion the whole feature rests on: what /api/backup writes is
    // what the restore action can read back.
    const file = buildBackup(state(), "jlovera@texco.net.au", [], AT);
    const parsed = BackupSchema.safeParse(JSON.parse(JSON.stringify(file)));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.state.dataset.emp).toHaveLength(1);
      expect(parsed.data.state.overrides).toEqual({ A: { daEdit: 50 } });
      // The access overlay has to survive: it is the half the Excel export
      // never carried, and the reason a backup exists at all.
      expect(parsed.data.state.access).toEqual({
        "someone@texco.net.au": { type: "none" },
      });
    }
  });

  it("carries the version, and the taker, so a file can identify itself", () => {
    const file = buildBackup(state(), "jlovera@texco.net.au", [], AT);
    expect(file.kestrelBackup).toBe(BACKUP_VERSION);
    expect(file.takenBy).toBe("jlovera@texco.net.au");
    expect(file.takenAt).toBe(AT.toISOString());
  });

  it("keeps the audit log for the record", () => {
    const file = buildBackup(
      state(),
      "a@b.com",
      [{ ts: AT.toISOString(), actor: "a@b.com", kind: "edit", summary: "did a thing" }],
      AT
    );
    const parsed = BackupSchema.safeParse(JSON.parse(JSON.stringify(file)));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.history).toHaveLength(1);
  });
});

describe("what a restore refuses", () => {
  it("refuses a file from a format it does not read", () => {
    // Half-applying a future format is the failure that leaves the scheme in
    // a state nobody can name, so the version is checked before anything else.
    const file = { ...buildBackup(state(), "a@b.com", [], AT), kestrelBackup: 99 };
    expect(BackupSchema.safeParse(file).success).toBe(false);
    expect(describeBackupProblem(file)).toMatch(/format 99/);
    expect(describeBackupProblem(file)).toMatch(/[Nn]othing has been changed/);
  });

  it("refuses something that is not a backup at all", () => {
    expect(BackupSchema.safeParse({ hello: "world" }).success).toBe(false);
    expect(describeBackupProblem({ hello: "world" })).toMatch(/no kestrelBackup version/);
  });

  it("refuses a file whose dataset is malformed", () => {
    const broken = buildBackup(state(), "a@b.com", [], AT) as unknown as {
      state: { dataset: unknown };
    };
    broken.state.dataset = { emp: "not an array" };
    expect(BackupSchema.safeParse(broken).success).toBe(false);
    // right version, wrong shape — the message must not blame the version
    expect(describeBackupProblem(broken)).not.toMatch(/format/);
  });

  it("refuses a file with no state block", () => {
    const rest: Record<string, unknown> = { ...buildBackup(state(), "a@b.com", [], AT) };
    delete rest.state;
    expect(BackupSchema.safeParse(rest).success).toBe(false);
  });
});

describe("the sub-documents stay loosely typed on purpose", () => {
  it("accepts a stale params or columns document rather than rejecting the file", () => {
    // applyState re-parses each of these against its own schema and clears it
    // to defaults if it fails. Tightening the backup schema here would refuse
    // a whole backup over one sub-document that a restore would have handled.
    const file = buildBackup(
      state({ params: { nonsense: true }, columns: { also: "nonsense" } }),
      "a@b.com",
      [],
      AT
    );
    expect(BackupSchema.safeParse(JSON.parse(JSON.stringify(file))).success).toBe(true);
  });
});

describe("backupFilename", () => {
  it("is sortable and says when it was taken", () => {
    expect(backupFilename(new Date(2026, 7, 26, 11, 46))).toBe(
      "kestrel-backup-2026-08-26-1146.json"
    );
  });

  it("pads, so the names sort as dates", () => {
    expect(backupFilename(new Date(2026, 0, 5, 9, 7))).toBe(
      "kestrel-backup-2026-01-05-0907.json"
    );
  });
});
