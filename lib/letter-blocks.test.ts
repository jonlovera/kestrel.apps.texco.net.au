/**
 * Who signs whose letter.
 *
 * These assertions are about a person's signature going onto a salary letter,
 * so they are pinned by name rather than by count wherever the name is the
 * point. A routing change that a reviewer would wave through — a manager
 * quietly falling back to a different block — is exactly the failure this file
 * exists to make loud.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BLOCKS,
  SIGNATORIES,
  canonicalManager,
  signatoriesFor,
  signatureRouteFor,
  letterUnavailableReason,
} from "./letter-blocks";
import type { Employee } from "./schema";

describe("signatureRouteFor", () => {
  it("routes every NSW employee to Scott Griffin, whatever their manager", () => {
    // The rule that replaced five separate "this manager has no signature"
    // delegations. Marcus Cooper's people are the reason it exists — 36 of
    // them, the largest single group of letters in the scheme.
    for (const mgr of ["Marcus Cooper", "Tom McCreanor", "Jon Benjamin", "Jay Sharma", "Matthew Henwood", "Scott Griffin"]) {
      const route = signatureRouteFor({ st: "NSW", mgr });
      expect(signatoriesFor(route!)).toEqual(["Scott Griffin"]);
    }
  });

  it("lets the state rule beat the manager map, not the other way round", () => {
    // Clint Cassar has his own block, so this is a real precedence test rather
    // than a vacuous one: NSW must win even for a manager who is mapped.
    expect(signatoriesFor(signatureRouteFor({ st: "NSW", mgr: "Clint Cassar" })!))
      .toEqual(["Scott Griffin"]);
    expect(signatoriesFor(signatureRouteFor({ st: "VIC", mgr: "Clint Cassar" })!))
      .toEqual(["Clint Cassar", "Jonathan Glick"]);
  });

  it("reconciles the two spreadsheet spellings", () => {
    expect(canonicalManager("Matt Barker")).toBe("Matthew Barker");
    expect(canonicalManager("Jon Glick")).toBe("Jonathan Glick");
    // and the alias reaches the same block the canonical name does
    expect(signatureRouteFor({ st: "SHARED", mgr: "Matt Barker" }))
      .toEqual(signatureRouteFor({ st: "SHARED", mgr: "Matthew Barker" }));
  });

  it("builds Brock Ellett's pair, which the template does not contain", () => {
    // Matthew Barker only ever appears beside Tom Bull and Dee Gibson only ever
    // alone, so this pairing is composed rather than kept. Pinned by name
    // because getting it wrong puts Tom Bull's signature on the letter.
    const route = signatureRouteFor({ st: "SHARED", mgr: "Brock Ellett" })!;
    expect(route).toEqual({ block: 6, right: "Dee Gibson" });
    expect(BLOCKS[route.block]).toEqual(["Matthew Barker", "Tom Bull"]);
    expect(signatoriesFor(route)).toEqual(["Matthew Barker", "Dee Gibson"]);
  });

  it("returns null for a manager nobody has mapped", () => {
    expect(signatureRouteFor({ st: "VIC", mgr: "Someone New" })).toBeNull();
    // ...but never for NSW, which the state rule covers unconditionally
    expect(signatureRouteFor({ st: "NSW", mgr: "Someone New" })).not.toBeNull();
  });

  it("only ever names signatories the template holds", () => {
    for (const block of BLOCKS) {
      for (const who of block) expect(SIGNATORIES).toContain(who);
    }
  });
});

/**
 * The bug this pins: locking a row and clicking Download without saving.
 *
 * The control was live on the row's ON-SCREEN lock, but /api/letter builds the
 * letter from the SAVED document, so it refused — and because the control was
 * a plain link at the time, the refusal replaced the dashboard with raw JSON.
 * The link is gone; this is the other half.
 */
describe("letterUnavailableReason", () => {
  const row = { st: "VIC", mgr: "Clint Cassar", locked: true };

  it("allows a letter only once the lock has been SAVED", () => {
    expect(letterUnavailableReason(row, true)).toBeNull();
    // locked on screen, not yet saved — the reported bug
    expect(letterUnavailableReason(row, false)).toMatch(/Save this lock/);
  });

  it("tells the two failing lock states apart", () => {
    // "never locked" and "locked but unsaved" need different things done, and
    // one message covering both would tell someone to lock a locked row
    expect(letterUnavailableReason({ ...row, locked: false }, false)).toMatch(
      /Lock this row first/
    );
    expect(letterUnavailableReason(row, false)).not.toMatch(/Lock this row first/);
  });

  it("reports a missing signature ahead of the lock", () => {
    // the same order /api/letter checks in, so the tooltip and the refusal
    // never tell different stories about the same row
    const orphan = { st: "VIC", mgr: "Nobody At All", locked: false };
    expect(letterUnavailableReason(orphan, false)).toMatch(/No signature on file/);
    expect(letterUnavailableReason(orphan, true)).toMatch(/No signature on file/);
  });
});

const DATA = join(__dirname, "..", "data", "bonus.json");

describe.skipIf(!existsSync(DATA))("every real employee resolves", () => {
  const emps: Employee[] = JSON.parse(readFileSync(DATA, "utf-8")).emp;

  it("covers all 155, with nobody left unroutable", () => {
    const unrouted = emps.filter((e) => !signatureRouteFor(e));
    expect(unrouted.map((e) => e.mgr)).toEqual([]);
    expect(emps).toHaveLength(155);
  });

  it("distributes them the way the mapping says", () => {
    const tally: Record<string, number> = {};
    for (const e of emps) {
      const key = signatoriesFor(signatureRouteFor(e)!).join(" + ");
      tally[key] = (tally[key] ?? 0) + 1;
    }
    expect(tally).toEqual({
      "Scott Griffin": 54,
      "Clint Cassar + Jonathan Glick": 54,
      "Tom Bull + Jack Bull": 20,
      "Matthew Barker + Tom Bull": 15,
      "Paul Darby + Neil Timms": 6,
      "Dee Gibson": 4,
      "Matthew Barker + Dee Gibson": 2,
    });
  });

  it("never routes a VIC or Shared Services row through the NSW rule", () => {
    // The state rule is unconditional, so the guard that matters is that it
    // does not reach anyone it shouldn't — a VIC person signed by Scott
    // Griffin would be wrong and would look perfectly ordinary.
    const wrong = emps.filter(
      (e) =>
        e.st !== "NSW" &&
        signatoriesFor(signatureRouteFor(e)!).join() === "Scott Griffin"
    );
    expect(wrong).toEqual([]);
  });

  it("sends all 36 of Marcus Cooper's people to Scott Griffin", () => {
    const theirs = emps.filter((e) => e.mgr === "Marcus Cooper");
    expect(theirs).toHaveLength(36);
    for (const e of theirs) {
      expect(signatoriesFor(signatureRouteFor(e)!)).toEqual(["Scott Griffin"]);
    }
  });

  it("sends both of Brock Ellett's people to Matt Barker and Dee Gibson", () => {
    const theirs = emps.filter((e) => e.mgr === "Brock Ellett");
    expect(theirs).toHaveLength(2);
    for (const e of theirs) {
      expect(signatoriesFor(signatureRouteFor(e)!)).toEqual([
        "Matthew Barker",
        "Dee Gibson",
      ]);
    }
  });
});
