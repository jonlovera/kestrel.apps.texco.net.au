import "server-only";
import { z } from "zod";
import { NUMERIC_FIELDS, type NumericField } from "./access-types";
import {
  AccessRuleSchema,
  describeEditing,
  effectiveRules,
  rewriteActAsReferences,
  type AccessRule,
  type EffectiveRule,
  type GrantingRule,
} from "./access-rules";
import { loadAccessOverlay, saveAccessOverlay, appendHistory } from "./store";

/**
 * ============================================================================
 * ACCESS CONTROL — who can see what.
 *
 * Day-to-day management happens in the app: any full-access user can add or
 * remove people at /admin (stored in the database, no deploy needed). The entries
 * below are the SEED/FALLBACK layer — kept in code so the app always has its
 * owners even if the database is empty, and so jlovera can never be locked
 * out. Precedence per email: this file < BONUS_USERS env var < /admin (db).
 *
 * The access types (see /admin for the same options with a form):
 *   full   — every employee, every field, can edit, can manage access
 *   state  — employees in the listed state(s), listed fields only
 *   group  — a standing state ∧ role group, listed fields only
 *   subset — only the listed employee ids, listed fields only
 * `visibleFields` governs the numeric columns (pkg, bp, ipm, bipm, calc, f25,
 * da, yoy, final); pkg/bp are the salary-sensitive ones. Identity fields
 * (name, position, department, manager) are always visible on permitted rows.
 * `editableFields` is the separate question of what they may CHANGE on those
 * rows: IPM, Discretionary, both, or neither for a read-only view. Everything
 * below `full` used to carry both implicitly, with no way to withhold them.
 * ============================================================================
 */
const ACCESS: Record<string, AccessRule> = {
  'jlovera@texco.net.au': { type: 'full', canEditCaps: false, canEditVicSiteManagers: false, canActAs: [], canDownloadLetter: false },
  'dgibson@texco.net.au': { type: 'full', canEditCaps: false, canEditVicSiteManagers: false, canActAs: [], canDownloadLetter: false },
  'tbull@texco.net.au': { type: 'full', canEditCaps: false, canEditVicSiteManagers: false, canActAs: [], canDownloadLetter: false },
  'jbull@texco.net.au': { type: 'full', canEditCaps: false, canEditVicSiteManagers: false, canActAs: [], canDownloadLetter: false },
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
  // The label used to say "read only" for every non-full scope, which was
  // never true — they could all set IPM and Discretionary — and is now a real
  // state someone can be put in, so it follows the grant instead of guessing.
  const where =
    rule.type === "state"
      ? rule.states.join(" + ")
      : rule.type === "group"
        ? rule.states.length
          ? rule.states.join(" + ")
          : "Selected roles"
        : "Selected employees";
  return {
    email: key,
    rule,
    canEdit: false,
    visibleFields: rule.visibleFields,
    label: `${where} — ${describeEditing(rule)}`,
  };
}

/** True when this email's granting rule comes from code/env (not the db). */
export async function isSeeded(email: string): Promise<boolean> {
  const seedAndEnv = effectiveRules(ACCESS, envOverrides(), {});
  return email.toLowerCase() in seedAndEnv;
}

/**
 * Carry someone's access across an email change.
 *
 * Access here is keyed by email, but identity matches people on `m365_id` —
 * the stable Entra object id — precisely because email is not stable. When a
 * known person signs in under a new address, their rule follows them rather
 * than silently disappearing.
 *
 * Only the database overlay can move: the code seed and BONUS_USERS are keyed
 * by email in source and need a deploy, so a stale one is logged loudly rather
 * than fixed quietly.
 */
export async function adoptNewEmail(
  oldEmail: string,
  newEmail: string
): Promise<boolean> {
  const from = oldEmail.toLowerCase();
  const to = newEmail.toLowerCase();
  if (!from || !to || from === to) return false;

  const overlay = await loadAccessOverlay();
  const rule = overlay[from];

  // Delegations pointing AT the old address must follow it too, and they can
  // exist regardless of whether the old address has a movable rule of its
  // own — so this runs on every migration path, not just the happy one.
  const { overlay: rewritten, changed } = rewriteActAsReferences(overlay, from, to);

  let moveRule = false;
  if (!rule) {
    if (await isSeeded(from)) {
      console.warn(
        `[access] ${from} signed in as ${to}, but their access is seeded in code — ` +
          `update lib/access.ts or BONUS_USERS, or they will lose access`
      );
    }
  } else if (overlay[to]) {
    // Never overwrite a rule already sitting under the new address: that one
    // was granted deliberately and is at least as current as the one moving.
    console.warn(
      `[access] ${from} is now ${to}, which already has its own rule — leaving both alone`
    );
  } else {
    moveRule = true;
  }

  if (!moveRule && changed.length === 0) return false;

  let next = rewritten;
  if (moveRule) {
    const { [from]: moved, ...rest } = next;
    next = { ...rest, [to]: moved };
  }
  await saveAccessOverlay(next);

  const entries = [];
  if (moveRule) {
    entries.push({
      ts: new Date().toISOString(),
      actor: "texco-identity",
      kind: "access" as const,
      summary: `Email changed in identity: access for ${from} now applies to ${to}`,
      target: to,
    });
  }
  if (changed.length > 0) {
    entries.push({
      ts: new Date().toISOString(),
      actor: "texco-identity",
      kind: "access" as const,
      summary: `Email changed in identity: "can act for" on ${changed.join(", ")} now names ${to}`,
      target: to,
    });
  }
  await appendHistory(entries);
  console.log(
    `[audit] access-email-migrated from=${from} to=${to} ruleMoved=${moveRule} actAsRewritten=${changed.length} ts=${new Date().toISOString()}`
  );
  return moveRule;
}

export { AccessRuleSchema, type AccessRule };
