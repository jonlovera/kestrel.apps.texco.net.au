import "server-only";
import { z } from "zod";
import { NUMERIC_FIELDS, type NumericField } from "./access-types";
import {
  AccessRuleSchema,
  effectiveRules,
  type AccessRule,
  type EffectiveRule,
  type GrantingRule,
} from "./access-rules";
import { loadAccessOverlay } from "./store";

/**
 * ============================================================================
 * ACCESS CONTROL — who can see what.
 *
 * Day-to-day management happens in the app: any full-access user can add or
 * remove people at /admin (stored in Redis, no deploy needed). The entries
 * below are the SEED/FALLBACK layer — kept in code so the app always has its
 * owners even if the database is empty, and so jlovera can never be locked
 * out. Precedence per email: this file < BONUS_USERS env var < /admin (db).
 *
 * The three access types (see /admin for the same options with a form):
 *   full   — every employee, every field, can edit, can manage access
 *   state  — employees in the listed state(s), read-only, listed fields only
 *   subset — only the listed employee ids, read-only, listed fields only
 * `visibleFields` governs the numeric columns (pkg, bp, ipm, bipm, calc, f25,
 * da, yoy, final); pkg/bp are the salary-sensitive ones. Identity fields
 * (name, position, department, manager) are always visible on permitted rows.
 * ============================================================================
 */
const ACCESS: Record<string, AccessRule> = {
  'jlovera@texco.net.au': { type: 'full' },
  'dgibson@texco.net.au': { type: 'full' },
  'tbull@texco.net.au': { type: 'full' },
  'jbull@texco.net.au': { type: 'full' },
};

/** Resolved scope handed to the rest of the server code. */
export interface Scope {
  email: string;
  rule: GrantingRule;
  canEdit: boolean;
  /** numeric fields this user may receive */
  visibleFields: NumericField[];
  /** human-readable label for the header */
  label: string;
}

function envOverrides(): Record<string, AccessRule> {
  const raw = process.env.BONUS_USERS;
  if (!raw) return {};
  try {
    const parsed = z.record(z.string(), AccessRuleSchema).parse(JSON.parse(raw));
    return Object.fromEntries(
      Object.entries(parsed).map(([k, v]) => [k.toLowerCase(), v])
    );
  } catch (err) {
    console.error("[access] BONUS_USERS env var is invalid and was ignored:", err);
    return {};
  }
}

/** All effective rules (seed + env + db overlay), keyed by email. */
export async function allRules(): Promise<Record<string, EffectiveRule>> {
  return effectiveRules(ACCESS, envOverrides(), await loadAccessOverlay());
}

export async function scopeForUser(
  email: string | null | undefined
): Promise<Scope | null> {
  if (!email) return null;
  const key = email.toLowerCase();
  const eff = (await allRules())[key];
  if (!eff) return null;
  const rule = eff.rule;

  if (rule.type === "full") {
    return {
      email: key,
      rule,
      canEdit: true,
      visibleFields: [...NUMERIC_FIELDS],
      label: "Full access — can edit",
    };
  }
  if (rule.type === "state") {
    return {
      email: key,
      rule,
      canEdit: false,
      visibleFields: rule.visibleFields,
      label: `${rule.states.join(" + ")} — read only`,
    };
  }
  return {
    email: key,
    rule,
    canEdit: false,
    visibleFields: rule.visibleFields,
    label: "Selected employees — read only",
  };
}

/** True when this email's granting rule comes from code/env (not the db). */
export async function isSeeded(email: string): Promise<boolean> {
  const seedAndEnv = effectiveRules(ACCESS, envOverrides(), {});
  return email.toLowerCase() in seedAndEnv;
}

export { AccessRuleSchema, type AccessRule };
