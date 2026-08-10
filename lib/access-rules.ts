import { z } from "zod";
import { NUMERIC_FIELDS } from "./access-types";

/**
 * Access-rule shapes and the pure merge logic. No config and no I/O here —
 * this module is shared by the server-only config (lib/access.ts), the
 * store (lib/store.ts) and the Vitest suite.
 */
export const AccessRuleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("full") }),
  z.object({
    type: z.literal("state"),
    states: z.array(z.enum(["VIC", "NSW", "SHARED"])).min(1),
    visibleFields: z.array(z.enum(NUMERIC_FIELDS)),
  }),
  z.object({
    type: z.literal("subset"),
    employeeIds: z.array(z.string()).min(1),
    visibleFields: z.array(z.enum(NUMERIC_FIELDS)),
  }),
  // A standing group rather than a fixed list: "all VIC site managers" keeps
  // meaning that as people come and go, where a subset would go stale.
  z.object({
    type: z.literal("group"),
    states: z.array(z.enum(["VIC", "NSW", "SHARED"])),
    positions: z.array(z.string().trim().min(1)),
    visibleFields: z.array(z.enum(NUMERIC_FIELDS)),
  }).refine(
    (r) => r.states.length > 0 || r.positions.length > 0,
    "a group needs at least one state or position, or it would match everyone"
  ),
  // Tombstone: revokes a code/env-seeded entry without a deploy.
  z.object({ type: z.literal("none") }),
]);
export type AccessRule = z.infer<typeof AccessRuleSchema>;
export type GrantingRule = Exclude<AccessRule, { type: "none" }>;

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
