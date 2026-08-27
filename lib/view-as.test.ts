/**
 * View-as tests, run against the REAL decision functions
 * (lib/view-as-core.ts) — this file used to assert a hand-kept copy of the
 * rule, which would have kept passing while the resolver changed underneath
 * it. resolveViewer itself still reaches for the session and the database;
 * these functions are everything it decides.
 *
 * The load-bearing rules:
 *  - the cookie naming someone to view as is honoured only when the actor's
 *    own scope authorises that specific target: full access for anyone, or
 *    the target on the actor's `canActAs` list. A forged cookie outside that
 *    is inert.
 *  - a view is writable (canActOn) ONLY for a listed, non-full-access
 *    target. An admin's blanket view stays read-only; nobody can act with a
 *    full-access window.
 */
import { describe, it, expect } from "vitest";
import type { Scope } from "./access";
import { viewAsTarget, canActOn } from "./view-as-core";

const FIELDS = ["ipm", "da", "calc", "final"] as const;

const scope = (
  email: string,
  rule: Scope["rule"],
  canEdit: boolean
): Scope => ({
  email,
  rule,
  canEdit,
  visibleFields: [...FIELDS],
  label: email,
});

const admin = scope(
  "admin@texco.net.au",
  { type: "full", canEditCaps: false, canEditVicSiteManagers: false, canRecalculatePool: false, canRevokeIssued: false, canActAs: [], canDownloadLetter: false },
  true
);
const lead = scope(
  "vic.lead@texco.net.au",
  {
    type: "state",
    states: ["VIC"],
    visibleFields: [...FIELDS],
    editableFields: ["da"],
    canLock: false,
    canActAs: [], canDownloadLetter: false,
  },
  false
);
/** Clint: a lead delegated one specific person's dashboard. */
const clint = scope(
  "clint@texco.net.au",
  {
    type: "state",
    states: ["NSW"],
    visibleFields: [...FIELDS],
    editableFields: ["da"],
    canLock: false,
    canActAs: ["jglick@texco.net.au"], canDownloadLetter: false,
  },
  false
);
const jglick = scope(
  "jglick@texco.net.au",
  {
    type: "state",
    states: ["VIC"],
    visibleFields: [...FIELDS],
    editableFields: ["da"],
    canLock: false,
    canActAs: [], canDownloadLetter: false,
  },
  false
);
/** An admin who was ALSO delegated one person — the write sanction rides on the list, not on full access. */
const delegatedAdmin = scope(
  "admin2@texco.net.au",
  { type: "full", canEditCaps: false, canEditVicSiteManagers: false, canRecalculatePool: false, canRevokeIssued: false, canActAs: ["jglick@texco.net.au"], canDownloadLetter: false },
  true
);

describe("who may open a view of whom (viewAsTarget)", () => {
  it("a full-access user may view anyone", () => {
    expect(viewAsTarget(admin, admin.email, "vic.lead@texco.net.au")).toBe(
      "vic.lead@texco.net.au"
    );
  });

  it("a lead with no delegation may not — a forged cookie is ignored outright", () => {
    // the escalation attempt: a lead naming an admin
    expect(viewAsTarget(lead, lead.email, "admin@texco.net.au")).toBeNull();
  });

  it("a delegated lead may view exactly their listed target and nobody else", () => {
    expect(viewAsTarget(clint, clint.email, "jglick@texco.net.au")).toBe(
      "jglick@texco.net.au"
    );
    expect(viewAsTarget(clint, clint.email, "admin@texco.net.au")).toBeNull();
    expect(viewAsTarget(clint, clint.email, "vic.lead@texco.net.au")).toBeNull();
  });

  it("someone with no scope at all may not", () => {
    expect(viewAsTarget(null, "nobody@texco.net.au", "admin@texco.net.au")).toBeNull();
  });

  it("viewing as yourself is a no-op rather than a special case", () => {
    expect(viewAsTarget(admin, admin.email, "ADMIN@texco.net.au")).toBeNull();
    expect(viewAsTarget(clint, clint.email, "clint@texco.net.au")).toBeNull();
  });

  it("no cookie means your own view", () => {
    expect(viewAsTarget(admin, admin.email, undefined)).toBeNull();
    expect(viewAsTarget(admin, admin.email, "")).toBeNull();
    expect(viewAsTarget(admin, admin.email, null)).toBeNull();
  });

  it("is case-insensitive, since email is", () => {
    expect(viewAsTarget(admin, admin.email, "VIC.Lead@Texco.net.au")).toBe(
      "vic.lead@texco.net.au"
    );
    expect(viewAsTarget(clint, clint.email, "JGlick@Texco.net.au")).toBe(
      "jglick@texco.net.au"
    );
  });
});

describe("who may WRITE while viewing (canActOn)", () => {
  it("a delegated lead may act on their listed non-full target", () => {
    expect(canActOn(clint, jglick)).toBe(true);
  });

  it("an admin's blanket view stays read-only — full access is not a delegation", () => {
    expect(canActOn(admin, jglick)).toBe(false);
    expect(canActOn(admin, lead)).toBe(false);
  });

  it("an admin who was explicitly delegated someone may act on them", () => {
    expect(canActOn(delegatedAdmin, jglick)).toBe(true);
  });

  it("a full-access target is never actable, even when listed", () => {
    // acting for an admin would mean writing with an admin-wide window
    const clintDelegatedAnAdmin = scope(
      clint.email,
      { ...clint.rule, canActAs: ["admin@texco.net.au"], canDownloadLetter: false },
      false
    );
    expect(canActOn(clintDelegatedAnAdmin, admin)).toBe(false);
  });

  it("an unlisted target is never actable", () => {
    expect(canActOn(clint, lead)).toBe(false);
  });

  it("a missing scope on either side refuses", () => {
    expect(canActOn(null, jglick)).toBe(false);
    expect(canActOn(clint, null)).toBe(false);
  });

  it("matches the target case-insensitively", () => {
    const shoutyTarget = { ...jglick, email: "JGlick@Texco.net.au" };
    expect(canActOn(clint, shoutyTarget)).toBe(true);
  });
});
