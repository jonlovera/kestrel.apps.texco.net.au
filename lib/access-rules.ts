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

export const AccessRuleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("full"), canEditCaps }),
  z.object({
    type: z.literal("state"),
    states: z.array(z.enum(["VIC", "NSW", "SHARED"])).min(1),
    visibleFields: z.array(z.enum(NUMERIC_FIELDS)),
    editableFields,
    canLock,
  }),
  z.object({
    type: z.literal("subset"),
    employeeIds: z.array(z.string()).min(1),
    visibleFields: z.array(z.enum(NUMERIC_FIELDS)),
    editableFields,
    canLock,
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
  }).refine(
    (r) => r.states.length > 0 || r.positions.length > 0,
    "a group needs at least one state or position, or it would match everyone"
  ),
  // Tombstone: revokes a code/env-seeded entry without a deploy.
  z.object({ type: z.literal("none") }),
]);
export type AccessRule = z.infer<typeof AccessRuleSchema>;
export type GrantingRule = Exclude<AccessRule, { type: "none" }>;

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
  if (rule.type === "full") return "full access";
  // The history has to record what they may CHANGE, not just what they see:
  // a rule going read-only is the whole point of the entry.
  const editing = describeEditing(rule);
  if (rule.type === "state") return `${rule.states.join(" + ")} / ${editing}`;
  if (rule.type === "group") {
    const where = rule.states.length ? rule.states.join(" + ") : "all states";
    const who = rule.positions.length ? rule.positions.join(", ") : "all roles";
    return `${where} / ${who} / ${editing}`;
  }
  return `${rule.employeeIds.length} selected employee${
    rule.employeeIds.length === 1 ? "" : "s"
  } / ${editing}`;
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
