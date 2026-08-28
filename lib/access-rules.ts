import { z } from "zod";
import { NUMERIC_FIELDS } from "./access-types";

/**
 * Access-rule shapes and the pure merge logic. No config and no I/O here —
 * this module is shared by the server-only config (lib/access.ts), the
 * store (lib/store.ts) and the Vitest suite.
 */
/**
 * The figures anyone below full access can be granted the right to change.
 * Everything else on a row comes from the spreadsheet. Locking is its own
 * grant (`canLock`, below) — it used to ride on holding any of these, but
 * that conflated two different questions ("can they change a figure" and
 * "can they freeze a row") that an admin may reasonably want to answer
 * differently.
 *
 * IPM used to be removed from here (a formula-derived figure a manual
 * override could corrupt) and has since been reopened: it's grantable again,
 * on the same terms as Discretionary.
 */
export const EDITABLE_FIELDS = ["da", "ipm"] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

/**
 * Defaulted, never required, and the reason matters.
 *
 * Rules stored before this field existed parse cleanly and come back granting
 * both, which is exactly what they were doing implicitly, so nobody on the
 * list changes. Making it required would be far worse than a migration
 * headache: loadDoc validates the whole overlay as one record, so a single
 * unparseable rule returns {} and every db-granted user loses access at once,
 * with nothing but a console.error to say so.
 */
const editableFields = z
  .array(z.enum(EDITABLE_FIELDS))
  .default([...EDITABLE_FIELDS]);

/**
 * Independent of `editableFields` — a lead can hold Discretionary/IPM
 * without this, or hold this without either. Defaulted to `false` rather
 * than mirrored off `editableFields` the way that field defaults to "grant
 * everything": there is no stored data predating this permission whose
 * implicit behaviour needs preserving, so an unset value is treated as "not
 * granted" rather than assumed.
 */
const canLock = z.boolean().default(false);

/**
 * A full-access admin does not get this just by being full access — it's a
 * narrower grant on top, for the same reason `canLock` is separate from
 * `editableFields`: "may see and change everything about the bonus scheme"
 * and "may change the pool caps themselves" are different questions, and an
 * owner may reasonably want most admins to have the first without the
 * second. No stored data predates this either, so it defaults to false the
 * same way `canLock` does.
 */
const canEditCaps = z.boolean().default(false);

/**
 * May lock/unlock, set IPM and grant a discretionary amount on the VIC site
 * managers, whose fixed bonuses are otherwise untouchable (lib/calc.ts's
 * isAdjustable, 24 August 2026). Its own grant on a full-access rule, not
 * implied by full access, for the same reason `canEditCaps` is not — owner
 * decision, 26 August 2026. Full rules only: a lead never holds it. Defaults
 * to false so every stored rule keeps parsing.
 */
const canEditVicSiteManagers = z.boolean().default(false);

/**
 * May press RECALCULATE THE POOL: re-derive the Scale Factor from Potential
 * Bonus at 100% IPM and re-base every eligible payout in one operation
 * (lib/recalculate.ts). The one action in the app that deliberately moves
 * everybody's money at once, which is exactly why it is a grant of its own and
 * NOT implied by full access — the same reasoning as `canEditCaps`, and the
 * owner asked for it explicitly.
 *
 * Full rules only: a lead is never sent the caps the operation runs on, and it
 * spans both pools rather than anyone's scope. Defaults to false so every
 * stored rule keeps parsing and nobody acquires it by having been an admin
 * first.
 */
const canRecalculatePool = z.boolean().default(false);

/**
 * May REVERT an issued bonus — take a committed amount back to merely locked
 * (lib/schema.ts's `issued`).
 *
 * Issuing is deliberately a one-way door: the amount has been communicated, so
 * nothing in the ordinary run of the app can move it. That is the right default
 * and it stays the default. But a one-way door with no key at all makes a
 * mis-click unrecoverable except by restoring a snapshot, which rolls back
 * everybody else's work too — so the key exists, and it is held separately from
 * the ability to issue in the first place. The person who can commit an amount
 * is not automatically the person who can un-commit one.
 *
 * Full rules only, and not implied by full access, for the same reason
 * `canEditCaps` and `canRecalculatePool` are not. Defaults to false so every
 * stored rule keeps parsing and nobody acquires it by having been an admin
 * first.
 */
const canRevokeIssued = z.boolean().default(false);

/**
 * May download a person's remuneration letter once their bonus is locked.
 *
 * Granted on EVERY rule shape including `full`, which is the one place this
 * departs from `canLock` (where full access confers it implicitly). The letter
 * is an outward-facing document carrying someone's salary and a director's
 * signature, and the owner asked for it to reach "only some people" — so being
 * an admin is not by itself an answer to whether you may produce one. That
 * makes it read like `canEditCaps`: a narrower grant sitting on top.
 *
 * Defaults to false for the same reason both of those do — no stored rule
 * predates it, so an unset value is "not granted" rather than assumed, and one
 * unparseable rule must never be able to revoke the whole overlay.
 */
const canDownloadLetter = z.boolean().default(false);

/**
 * Emails of the people whose dashboards this person may open through View as
 * AND make changes on. The change is always recorded against this person
 * (the actor), never the dashboard's owner — that requirement is what the
 * whole grant exists for. Empty means View as stays what it always was for
 * them: unavailable below full access, read-only at full access.
 *
 * Element is a plain string, not a validated email, on purpose: this field
 * is normalised at write time (app/api/access/route.ts), and a stored oddity
 * must never fail the overlay parse — one unparseable rule revokes everyone
 * (see the editableFields comment above). Defaulted for the same reason.
 */
const canActAs = z.array(z.string()).default([]);

/**
 * A SCOPED LEAD'S POOL CAP, in dollars — the ceiling their allocation is
 * measured against, set by an admin holding `canEditCaps` (owner decision,
 * 28 August 2026).
 *
 * WHY THE STORED FIGURE IS THE CAP AND NOT THE ALLOWANCE. What an admin types
 * is "additional allocation available" — Dee should never have to work out a
 * seven-figure ceiling by hand — and /admin's editor shows and takes exactly
 * that. But the ALLOWANCE cannot be what persists. A cap of
 * `currentAllocated + allowance` is re-derived on every request, so the moment
 * a lead spends part of it and saves, their allocation rises, the cap rises
 * with it and the whole allowance is handed back. That regeneration is the
 * thing this field exists to stop, so the frozen sum is what is stored and
 * app/api/access/route.ts does the one conversion, from live figures, at write
 * time.
 *
 * ABSENT means no allowance has ever been granted, which is NOT the same as
 * zero and is why this is `.optional()` rather than `.default(0)`: /admin
 * distinguishes "never set" (offer the suggested figure) from "deliberately
 * set to nil". For a group or subset lead an absent cap means no room to grant
 * at all — see lib/manager-pool.ts's rulePool.
 *
 * IGNORED on a whole-state rule, whose cap is the authoritative state pool and
 * is not an admin's to override (owner decision, same day). The field stays on
 * that arm of the union anyway so a rule that changes shape keeps parsing.
 *
 * Optional, like every field added after rules were already stored: the
 * overlay is saved STRICTLY and re-parsed as one record, so a required field
 * would drop every stored rule and revoke everybody — the hazard the
 * editableFields comment above describes.
 */
const allocationCap = z.number().min(0).max(50_000_000).optional();

/** Who last set `allocationCap`, and when. Written only by /api/access. */
const allocationCapBy = z.string().optional();
const allocationCapAt = z.string().optional();

export const AccessRuleSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("full"),
    canEditCaps,
    canEditVicSiteManagers,
    canRecalculatePool,
    canRevokeIssued,
    canActAs,
    canDownloadLetter,
  }),
  z.object({
    type: z.literal("state"),
    states: z.array(z.enum(["VIC", "NSW", "SHARED"])).min(1),
    visibleFields: z.array(z.enum(NUMERIC_FIELDS)),
    editableFields,
    canLock,
    canActAs,
    canDownloadLetter,
    allocationCap,
    allocationCapBy,
    allocationCapAt,
  }),
  z.object({
    type: z.literal("subset"),
    employeeIds: z.array(z.string()).min(1),
    visibleFields: z.array(z.enum(NUMERIC_FIELDS)),
    editableFields,
    canLock,
    canActAs,
    canDownloadLetter,
    allocationCap,
    allocationCapBy,
    allocationCapAt,
  }),
  // A standing group rather than a fixed list: "all VIC site managers" keeps
  // meaning that as people come and go, where a subset would go stale.
  z.object({
    type: z.literal("group"),
    states: z.array(z.enum(["VIC", "NSW", "SHARED"])),
    positions: z.array(z.string().trim().min(1)),
    visibleFields: z.array(z.enum(NUMERIC_FIELDS)),
    editableFields,
    canLock,
    canActAs,
    canDownloadLetter,
    allocationCap,
    allocationCapBy,
    allocationCapAt,
  }).refine(
    (r) => r.states.length > 0 || r.positions.length > 0,
    "a group needs at least one state or position, or it would match everyone"
  ),
  // Tombstone: revokes a code/env-seeded entry without a deploy.
  z.object({ type: z.literal("none") }),
]);
export type AccessRule = z.infer<typeof AccessRuleSchema>;
export type GrantingRule = Exclude<AccessRule, { type: "none" }>;

/**
 * Whole dollars with separators, for the sentence below. Local rather than
 * lib/fmt.ts's `fmt` on purpose: this module is imported by the store, the
 * pure rule tests and the browser alike, and it has no formatting dependency
 * today worth adding one for.
 */
function dollars(n: number): string {
  return `$${Math.round(n).toLocaleString("en-AU")}`;
}

/** Human names for the editable figures, for the sentence below. */
const EDITABLE_LABELS: Record<EditableField, string> = {
  da: "Discretionary",
  ipm: "IPM",
};

/**
 * "can set Discretionary" | "read only"
 *
 * One definition because five screens say this: the access table, the history
 * entry, the View as picker, the dashboard header label, and the View as
 * banner. They were separately hardcoded to claim everyone below full access
 * could set both, which was true only because nothing could say otherwise.
 */
export function describeEditing(rule: GrantingRule): string {
  if (rule.type === "full") return "can edit";
  const names = EDITABLE_FIELDS.filter((f) =>
    rule.editableFields.includes(f)
  ).map((f) => EDITABLE_LABELS[f]);
  if (names.length === 0) return "read only";
  return `can set ${names.join(" and ")}`;
}

/**
 * One sentence describing a whole rule — "VIC + NSW / can set Discretionary".
 * Shared by the access API's history entries and the snapshot diff
 * (lib/snapshot-diff.ts), so both describe a grant in the same words.
 */
export function describeRule(rule: AccessRule): string {
  if (rule.type === "none") return "no access";
  // "can act for" is part of the sentence for the same reason editing is:
  // this grant is a delegation, and a history entry that omitted it would
  // hide the most consequential thing the rule says.
  const acting =
    rule.canActAs.length > 0 ? `; can act for ${rule.canActAs.join(", ")}` : "";
  // Letters go out of the building over a director's signature, so who may
  // produce one belongs in the sentence for the same reason acting does —
  // an entry that omitted it would hide a grant nobody can see from the rule
  // shape alone.
  const letters = rule.canDownloadLetter ? "; can download letters" : "";
  // Same reasoning once more, and this one is money: a grant that raised or
  // removed somebody's pool ceiling must say so, or the history entry hides the
  // only figure that changed.
  const cap =
    rule.type !== "full" && rule.allocationCap !== undefined
      ? `; pool cap ${dollars(rule.allocationCap)}`
      : "";
  const extras = `${letters}${cap}${acting}`;
  // Same reasoning again: this grant reaches sixteen fixed bonuses nobody else
  // can touch, so the record of who was given it must say so.
  const vicSms =
    rule.type === "full" && rule.canEditVicSiteManagers
      ? "; can adjust VIC site managers"
      : "";
  // And again: this one press re-bases every eligible payout in the scheme, so
  // the entry that granted it has to say so.
  const recalc =
    rule.type === "full" && rule.canRecalculatePool
      ? "; can recalculate the pool"
      : "";
  // Same reasoning again: this one undoes a commitment, so the record of who
  // holds it has to say so.
  const revoke =
    rule.type === "full" && rule.canRevokeIssued
      ? "; can revert issued bonuses"
      : "";
  if (rule.type === "full")
    return `full access${vicSms}${recalc}${revoke}${extras}`;
  // The history has to record what they may CHANGE, not just what they see:
  // a rule going read-only is the whole point of the entry.
  const editing = describeEditing(rule);
  if (rule.type === "state")
    return `${rule.states.join(" + ")} / ${editing}${extras}`;
  if (rule.type === "group") {
    const where = rule.states.length ? rule.states.join(" + ") : "all states";
    const who = rule.positions.length ? rule.positions.join(", ") : "all roles";
    return `${where} / ${who} / ${editing}${extras}`;
  }
  return `${rule.employeeIds.length} selected employee${
    rule.employeeIds.length === 1 ? "" : "s"
  } / ${editing}${extras}`;
}

/**
 * Rewrite every `canActAs` reference to `from` so it names `to` instead —
 * the companion to adoptNewEmail (lib/access.ts) moving the rule itself.
 * Without this, a delegation pointing at an email that changed would
 * silently stop working. Pure so it is testable here.
 */
export function rewriteActAsReferences(
  overlay: Record<string, AccessRule>,
  from: string,
  to: string
): { overlay: Record<string, AccessRule>; changed: string[] } {
  const f = from.toLowerCase();
  const t = to.toLowerCase();
  const changed: string[] = [];
  const out: Record<string, AccessRule> = {};
  for (const [email, rule] of Object.entries(overlay)) {
    if (rule.type === "none" || !rule.canActAs.some((e) => e.toLowerCase() === f)) {
      out[email] = rule;
      continue;
    }
    const rewritten = [
      ...new Set(rule.canActAs.map((e) => (e.toLowerCase() === f ? t : e.toLowerCase()))),
    ];
    out[email] = { ...rule, canActAs: rewritten };
    changed.push(email);
  }
  return { overlay: out, changed };
}

/**
 * Keep the rules that still parse, drop the ones that don't.
 *
 * Without this a single malformed entry costs everyone their access: the
 * overlay is validated as one record, so one bad rule fails the lot and
 * loadDoc falls back to {}, silently revoking every db-granted user. Same
 * reasoning as dropRetiredFields in lib/columns.ts, and applied the same way,
 * at the load site only. Saving stays strict.
 */
export function dropInvalidRules(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const out: Record<string, unknown> = {};
  for (const [email, stored] of Object.entries(raw as Record<string, unknown>)) {
    if (AccessRuleSchema.safeParse(stored).success) out[email] = stored;
    else console.error(`[access] stored rule for ${email} is invalid; ignoring it`);
  }
  return out;
}

/** The employee facts a rule is matched against. */
export interface ScopableEmployee {
  id: string;
  st: string;
  pos: string;
}

/**
 * Does this rule cover this employee?
 *
 * The single definition of "in scope", shared by the read boundary
 * (lib/scope-core.ts) and the write boundary (lib/write-scope.ts) so the two
 * can never disagree about whose row it is. An empty dimension on a group
 * means "any", but the schema above forbids all dimensions being empty.
 */
export function ruleMatches(rule: GrantingRule, e: ScopableEmployee): boolean {
  switch (rule.type) {
    case "full":
      return true;
    case "state":
      return (rule.states as readonly string[]).includes(e.st);
    case "subset":
      return rule.employeeIds.includes(e.id);
    case "group":
      return (
        (rule.states.length === 0 ||
          (rule.states as readonly string[]).includes(e.st)) &&
        (rule.positions.length === 0 || rule.positions.includes(e.pos))
      );
  }
}

export type RuleSource = "code" | "env" | "db";
export interface EffectiveRule {
  rule: GrantingRule;
  source: RuleSource;
}

/** The repo owner can never be locked out via the overlay. */
export const OWNER_EMAIL = "jlovera@texco.net.au";

/**
 * Merge the three rule layers. Later layers win per email
 * (code seed < env var < db overlay); a `none` rule deletes the entry,
 * except for OWNER_EMAIL where any earlier granting rule survives.
 */
export function effectiveRules(
  seed: Record<string, AccessRule>,
  env: Record<string, AccessRule>,
  overlay: Record<string, AccessRule>
): Record<string, EffectiveRule> {
  const layers: [Record<string, AccessRule>, RuleSource][] = [
    [seed, "code"],
    [env, "env"],
    [overlay, "db"],
  ];
  const out: Record<string, EffectiveRule> = {};
  for (const [rules, source] of layers) {
    for (const [rawEmail, rule] of Object.entries(rules)) {
      const email = rawEmail.toLowerCase();
      if (rule.type === "none") {
        if (email === OWNER_EMAIL) continue; // owner is unshadowable
        delete out[email];
      } else {
        out[email] = { rule, source };
      }
    }
  }
  return out;
}
