import "server-only";
import { z } from "zod";
import { NUMERIC_FIELDS, type NumericField } from "./access-types";

/**
 * ============================================================================
 * ACCESS CONTROL CONFIG — who can see what.
 *
 * HOW TO ADD A PERSON
 * -------------------
 * 1. They sign in with their normal Texco Microsoft (M365) account — anyone in
 *    the tenant can *authenticate*, but they see nothing until listed here.
 * 2. Add an entry keyed by their work email (lowercase). Pick one of the three
 *    access types:
 *
 *    FULL — sees every employee and every field, and can edit:
 *      'dee.gibson@texco.net.au': { type: 'full' },
 *
 *    STATE — sees all employees in the listed state(s), read-only. List the
 *    fields they may see; anything not listed is stripped SERVER-SIDE and
 *    never reaches their browser. 'pkg' (package) and 'bp' (bonus %) are the
 *    salary-sensitive fields — omit them unless the person is cleared:
 *      'clint.cassar@texco.net.au': {
 *        type: 'state',
 *        states: ['VIC'],                       // may list several, or 'SHARED'
 *        visibleFields: ['ipm', 'bipm', 'calc', 'f25', 'da', 'yoy', 'final'],
 *      },
 *
 *    SUBSET — sees only the listed employee IDs (the 5-letter `id` codes in
 *    data/bonus.json), read-only, with the listed fields:
 *      'board.member@texco.net.au': {
 *        type: 'subset',
 *        employeeIds: ['ALBID', 'BRELL'],
 *        visibleFields: ['final'],
 *      },
 *
 *    Identity fields (name, position, department, manager, state) are always
 *    visible for rows a person is allowed to see; `visibleFields` governs the
 *    numeric columns: pkg, bp, ipm, bipm, calc, f25, da, yoy, final.
 *
 * 3. Redeploy (`vercel deploy --prod`). Alternatively set the BONUS_USERS env
 *    var to a JSON object of the same shape — it is merged over this config,
 *    so you can add or override people without a code change.
 * ============================================================================
 */
const ACCESS: Record<string, AccessRule> = {
  'jlovera@texco.net.au': { type: 'full' },
  // ── placeholders: replace with real Texco emails ──────────────────────────
  'full.access@texco.net.au': { type: 'full' },
  'vic.leader@texco.net.au': {
    type: 'state',
    states: ['VIC'],
    visibleFields: ['ipm', 'bipm', 'calc', 'f25', 'da', 'yoy', 'final'],
  },
  'nsw.leader@texco.net.au': {
    type: 'state',
    states: ['NSW'],
    visibleFields: ['ipm', 'bipm', 'calc', 'f25', 'da', 'yoy', 'final'],
  },
  'subset.viewer@texco.net.au': {
    // employee IDs are the 5-letter codes from data/bonus.json (e.g. 'ALBID')
    type: 'subset',
    employeeIds: ['ALBID', 'BRELL'],
    visibleFields: ['final'],
  },
};


const AccessRuleSchema = z.discriminatedUnion("type", [
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
]);
export type AccessRule = z.infer<typeof AccessRuleSchema>;

/** Resolved scope handed to the rest of the server code. */
export interface Scope {
  email: string;
  rule: AccessRule;
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

export function scopeForUser(email: string | null | undefined): Scope | null {
  if (!email) return null;
  const key = email.toLowerCase();
  const rule = { ...ACCESS, ...envOverrides() }[key];
  if (!rule) return null;

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
