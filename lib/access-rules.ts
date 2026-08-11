import { z } from "zod";
import { NUMERIC_FIELDS } from "./access-types";

/**
 * Access-rule shapes and the pure merge logic. No config and no I/O here —
 * this module is shared by the server-only config (lib/access.ts), the
 * store (lib/store.ts) and the Vitest suite.
 */
/**
 * The only figure anyone below full access can ever be allowed to change.
 * Everything else on a row comes from the spreadsheet, and the lock is the
 * admin's alone (WRITABLE_BY_LEAD in lib/write-scope.ts).
 *
 * IPM was here too, grantable per person. It no longer is, for anyone: IPM is
 * a formula-derived figure, and a manual override corrupts the calculation.
 * See DEPRECATED_EDITABLE_FIELDS below for what that means for rules already
 * stored with "ipm" in this list.
 */
export const EDITABLE_FIELDS = ["da"] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

/**
 * Values `editableFields` used to accept and no longer does.
 *
 * A rule stored with "ipm" in its editableFields array before this change
 * would otherwise fail the zod enum outright — and because the overlay is
 * validated one rule at a time with drop-on-failure (dropInvalidRules below),
 * that failure would silently revoke the person's WHOLE access grant, not
 * just their IPM permission. dropInvalidRules strips these out before
 * validating, so the rule survives with exactly the meaning this change
 * intends: they simply can no longer set IPM, same as everyone else.
 */
const DEPRECATED_EDITABLE_FIELDS = new Set(["ipm"]);

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

export const AccessRuleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("full") }),
  z.object({
    type: z.literal("state"),
    states: z.array(z.enum(["VIC", "NSW", "SHARED"])).min(1),
    visibleFields: z.array(z.enum(NUMERIC_FIELDS)),
    editableFields,
  }),
  z.object({
    type: z.literal("subset"),
    employeeIds: z.array(z.string()).min(1),
    visibleFields: z.array(z.enum(NUMERIC_FIELDS)),
    editableFields,
  }),
  // A standing group rather than a fixed list: "all VIC site managers" keeps
  // meaning that as people come and go, where a subset would go stale.
  z.object({
    type: z.literal("group"),
    states: z.array(z.enum(["VIC", "NSW", "SHARED"])),
    positions: z.array(z.string().trim().min(1)),
    visibleFields: z.array(z.enum(NUMERIC_FIELDS)),
    editableFields,
  }).refine(
    (r) => r.states.length > 0 || r.positions.length > 0,
    "a group needs at least one state or position, or it would match everyone"
  ),
  // Tombstone: revokes a code/env-seeded entry without a deploy.
  z.object({ type: z.literal("none") }),
]);
export type AccessRule = z.infer<typeof AccessRuleSchema>;
export type GrantingRule = Exclude<AccessRule, { type: "none" }>;

/** Human name for the one editable figure, for the sentence below. */
const EDITABLE_LABELS: Record<EditableField, string> = {
  da: "Discretionary",
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

/** Drop values `editableFields` no longer accepts, so the rule still parses. */
function stripDeprecatedGrants(rule: unknown): unknown {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) return rule;
  const r = rule as Record<string, unknown>;
  if (!Array.isArray(r.editableFields)) return rule;
  return {
    ...r,
    editableFields: r.editableFields.filter((f) => !DEPRECATED_EDITABLE_FIELDS.has(f)),
  };
}

/**
 * Keep the rules that still parse, drop the ones that don't.
 *
 * Without this a single malformed entry costs everyone their access: the
 * overlay is validated as one record, so one bad rule fails the lot and
 * loadDoc falls back to {}, silently revoking every db-granted user. Same
 * reasoning as dropRetiredFields in lib/columns.ts, and applied the same way,
 * at the load site only. Saving stays strict.
 *
 * Each rule is normalised (stripDeprecatedGrants) before it's judged, not
 * after — a rule that only fails because it still lists "ipm" should lose
 * that one stale grant, not its owner's entire access.
 */
export function dropInvalidRules(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const out: Record<string, unknown> = {};
  for (const [email, stored] of Object.entries(raw as Record<string, unknown>)) {
    const rule = stripDeprecatedGrants(stored);
    if (AccessRuleSchema.safeParse(rule).success) out[email] = rule;
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
