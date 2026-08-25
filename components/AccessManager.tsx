"use client";

import { useState } from "react";
import type { GrantingRule, RuleSource, EditableField } from "@/lib/access-rules";
import { EDITABLE_FIELDS, describeEditing } from "@/lib/access-rules";
import type { NumericField } from "@/lib/access-types";
import { NUMERIC_FIELDS } from "@/lib/access-types";
import EmailCombobox from "./EmailCombobox";

interface RuleRow {
  email: string;
  rule: GrantingRule;
  source: RuleSource;
}

interface EmployeeOption {
  id: string;
  name: string;
  st: string;
  pos?: string;
}

interface PositionOption {
  pos: string;
  count: number;
}

const FIELD_LABELS: Record<NumericField, string> = {
  elig: "Eligibility %",
  totalPkg: "Total Package",
  pkg: "Eligible Salary",
  bp: "Bonus%",
  potential: "Potential Bonus",
  ipm: "IPM%",
  bipm: "After IPM",
  calc: "Calc bonus",
  f25: "FY25 Bonus (Paid)",
  da: "Discretionary",
  yoy: "YoY Change",
  final: "FY26 Bonus (Final)",
  vp: "VIC %",
  np: "NSW %",
};
// Raw salary figures, opt-in only for a new access grant — unlike bonus
// outcomes, these reveal what someone is actually paid.
const SENSITIVE: NumericField[] = ["totalPkg", "pkg", "bp"];
const STATES = ["VIC", "NSW", "SHARED"] as const;
const DEFAULT_FIELDS: NumericField[] = [
  "elig",
  "potential",
  "ipm",
  "bipm",
  "calc",
  "f25",
  "da",
  "yoy",
  "final",
  "vp",
  "np",
];

export default function AccessManager({
  initialRules,
  employees,
  positions,
  me,
}: {
  initialRules: RuleRow[];
  employees: EmployeeOption[];
  positions: PositionOption[];
  me: string;
}) {
  const [rules, setRules] = useState<RuleRow[]>(initialRules);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // add form
  const [email, setEmail] = useState("");
  const [type, setType] = useState<"full" | "state" | "group" | "subset">("state");
  const [states, setStates] = useState<string[]>(["VIC"]);
  const [roles, setRoles] = useState<string[]>([]);
  const [ids, setIds] = useState<string[]>([]);
  const [fields, setFields] = useState<NumericField[]>(DEFAULT_FIELDS);
  /**
   * Which editable figures this person may set — just Discretionary now that
   * IPM can't be granted to anyone. Empty means read only.
   */
  const [editable, setEditable] = useState<EditableField[]>([...EDITABLE_FIELDS]);
  /**
   * Whether this person may lock/unlock a row at all — independent of
   * `editable` above. Defaults to ticked so a freshly-configured lead ends up
   * with the same ability today's leads already have, even though the two
   * are no longer tied together.
   */
  const [canLock, setCanLock] = useState(true);
  /**
   * Full access only — whether this admin may change the pool caps
   * themselves. Not implied by full access any more; defaults to unticked
   * so granting someone full access doesn't quietly also hand them this.
   */
  const [canEditCaps, setCanEditCaps] = useState(false);
  /**
   * Whether this person may download a locked employee's remuneration letter.
   * Offered on every rule type, full access included — unlike Can lock, an
   * admin does not get this for being an admin (lib/access-rules.ts explains
   * why). Defaults to unticked: the letter leaves the building over a
   * director's signature, so it is granted deliberately or not at all.
   */
  const [canDownloadLetter, setCanDownloadLetter] = useState(false);
  /**
   * The "can act for" delegation: whose dashboards this person may open
   * through View as AND make changes on, recorded against their own name.
   * A list of emails from the access list itself (a target not on the list
   * has nothing to act on). Meaningful for every rule type, full included.
   */
  const [actAs, setActAs] = useState<string[]>([]);
  const [empSearch, setEmpSearch] = useState("");
  /** set while amending someone, so the form knows it is replacing not adding */
  const [editingEmail, setEditingEmail] = useState<string | null>(null);

  /**
   * Load an existing rule back into the form. Amending used to mean removing
   * the person and adding them again from scratch, which is easy to get wrong
   * halfway through and leaves them with no access in between.
   */
  function edit(row: RuleRow) {
    setError("");
    setEditingEmail(row.email);
    setEmail(row.email);
    setType(row.rule.type);
    setStates(row.rule.type === "state" || row.rule.type === "group" ? [...row.rule.states] : []);
    setRoles(row.rule.type === "group" ? [...row.rule.positions] : []);
    setIds(row.rule.type === "subset" ? [...row.rule.employeeIds] : []);
    setFields(row.rule.type === "full" ? DEFAULT_FIELDS : [...row.rule.visibleFields]);
    setEditable(
      row.rule.type === "full" ? [...EDITABLE_FIELDS] : [...row.rule.editableFields]
    );
    setCanLock(row.rule.type === "full" ? true : row.rule.canLock);
    setCanEditCaps(row.rule.type === "full" ? row.rule.canEditCaps : false);
    setCanDownloadLetter(row.rule.canDownloadLetter);
    setActAs([...row.rule.canActAs]);
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  }

  function resetForm() {
    setEditingEmail(null);
    setEmail("");
    setType("state");
    setStates(["VIC"]);
    setRoles([]);
    setIds([]);
    setFields(DEFAULT_FIELDS);
    setEditable([...EDITABLE_FIELDS]);
    setCanLock(true);
    setCanEditCaps(false);
    setCanDownloadLetter(false);
    setActAs([]);
    setError("");
  }

  async function call(method: "POST" | "DELETE", body: unknown) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/access", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Request failed");
      } else {
        setRules(data.rules);
      }
    } catch {
      setError("Request failed — is the database configured?");
    } finally {
      setBusy(false);
    }
  }

  function submit() {
    if (!email.includes("@")) {
      setError("Enter a valid email address");
      return;
    }
    // A figure they cannot see is not offered for editing either, so the two
    // rows on the form can never be saved contradicting each other.
    const editableFields = editable.filter((f) => fields.includes(f));
    // the person being edited can never act for themselves
    const canActAs = actAs.filter((e) => e !== email.trim().toLowerCase());
    const rule: GrantingRule =
      type === "full"
        ? { type: "full", canEditCaps, canActAs, canDownloadLetter }
        : type === "state"
          ? {
              type: "state",
              states: states as ("VIC" | "NSW" | "SHARED")[],
              visibleFields: fields,
              editableFields,
              canLock,
              canActAs,
              canDownloadLetter,
            }
          : type === "group"
            ? {
                type: "group",
                states: states as ("VIC" | "NSW" | "SHARED")[],
                positions: roles,
                visibleFields: fields,
                editableFields,
                canLock,
                canActAs,
                canDownloadLetter,
              }
            : {
                type: "subset",
                employeeIds: ids,
                visibleFields: fields,
                editableFields,
                canLock,
                canActAs,
                canDownloadLetter,
              };
    if (rule.type === "state" && rule.states.length === 0) {
      setError("Pick at least one state");
      return;
    }
    if (rule.type === "group" && rule.states.length === 0 && rule.positions.length === 0) {
      setError("Pick at least one state or role — an empty group would match everyone");
      return;
    }
    if (rule.type === "subset" && rule.employeeIds.length === 0) {
      setError("Pick at least one employee");
      return;
    }
    call("POST", { email: email.trim().toLowerCase(), rule });
    resetForm();
  }

  function describe(rule: GrantingRule): string {
    const acting =
      rule.canActAs.length > 0 ? `, can act for ${rule.canActAs.join(", ")}` : "";
    if (rule.type === "full")
      return (
        "Everyone · all fields · can edit" +
        (rule.canEditCaps ? ", can edit pool caps" : "") +
        acting
      );
    // describeEditing rather than a literal: this used to assert "can set IPM
    // and Discretionary" for everyone, which was only ever true because there
    // was no way to say otherwise.
    const editing = describeEditing(rule) + (rule.canLock ? ", can lock" : "") + acting;
    if (rule.type === "state") return `${rule.states.join(" + ")} · ${editing}`;
    if (rule.type === "group") {
      const where = rule.states.length ? rule.states.join(" + ") : "all states";
      const who = rule.positions.length ? rule.positions.join(", ") : "all roles";
      return `${where} · ${who} · ${editing}`;
    }
    return `${rule.employeeIds.length} employee${rule.employeeIds.length === 1 ? "" : "s"} · ${editing}`;
  }

  function fieldsOf(rule: GrantingRule): string {
    if (rule.type === "full") return "all";
    return rule.visibleFields.map((f) => FIELD_LABELS[f]).join(", ") || "none";
  }

  const toggle = <T,>(arr: T[], v: T, set: (a: T[]) => void) =>
    set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  /**
   * How many people the group currently lands on. A standing rule keeps
   * matching as people come and go — but if it matches nobody today, that is
   * almost certainly a mistake worth seeing before saving.
   */
  const groupMatchCount =
    type !== "group" || (states.length === 0 && roles.length === 0)
      ? null
      : employees.filter(
          (e) =>
            (states.length === 0 || states.includes(e.st)) &&
            (roles.length === 0 || roles.includes(e.pos ?? ""))
        ).length;

  const filteredEmployees = employees.filter(
    (e) =>
      !empSearch ||
      e.name.toLowerCase().includes(empSearch.toLowerCase()) ||
      e.id.toLowerCase().includes(empSearch.toLowerCase())
  );

  const inputCls =
    " border-2 border-neutral-200 px-3 py-2 text-[13px] outline-none focus:border-brand-orange";

  return (
    <div>
      <div className="mx-auto w-full max-w-[1100px] flex-1 px-5 py-6">
        <h1 className="mb-1 text-lg font-bold">Who can sign in</h1>
        <p className="mb-4 text-[13px] text-brand-70">
          People sign in with their Texco Microsoft account; they see nothing
          unless listed here. Start typing a name below and pick them from the
          directory, or type any address in full — access can be granted to
          people outside the bonus scheme too. Use <strong>Edit</strong> to
          amend someone in place rather than removing and re-adding them.
          Everyone except full access sees only their own rows.{" "}
          <strong>Can edit</strong> decides what they may change on those rows:
          leave both unticked and they can look but not touch.{" "}
          <strong>Can act for</strong> lets a person make changes on someone
          else&apos;s dashboard through View as, recorded against their own
          name. Changes apply immediately — no deploy needed. Entries marked{" "}
          <span className="font-semibold">code</span> are seeded in the repo and
          reappear unless removed here.
        </p>

        {error && (
          <div className="mb-4 border-2 border-error bg-error-tint px-4 py-2 text-[13px] font-semibold text-brand-95">
            {error}
          </div>
        )}

        <div className="mb-6 overflow-x-auto shadow-sm">
          <table className="w-full border-collapse bg-white text-[13px]">
            <thead>
              <tr>
                {["Email", "Access", "Visible fields", "Source", ""].map((h) => (
                  <th
                    key={h}
                    className="whitespace-nowrap bg-brand-95 px-3 py-2.5 text-left text-[11px] tracking-wide text-white"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.email} className="border-b border-neutral-100 hover:bg-neutral-50">
                  <td className="px-3 py-2 font-semibold">{r.email}</td>
                  <td className="px-3 py-2">{describe(r.rule)}</td>
                  <td className="max-w-[320px] truncate px-3 py-2 text-brand-70" title={fieldsOf(r.rule)}>
                    {fieldsOf(r.rule)}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block px-2 py-0.5 text-[11px] font-bold ${
                        r.source === "db"
                          ? "bg-brand-orange-tint text-brand-orange"
                          : "bg-neutral-200 text-neutral-600"
                      }`}
                    >
                      {r.source}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => edit(r)}
                      className="mr-1 border border-neutral-300 px-3 py-1 text-[11px] font-semibold text-brand-70 transition-colors hover:border-brand-orange hover:text-brand-orange disabled:opacity-40"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={busy || r.email === me}
                      title={r.email === me ? "You can't remove your own access" : undefined}
                      onClick={() => {
                        if (confirm(`Remove all access for ${r.email}?`))
                          call("DELETE", { email: r.email });
                      }}
                      className="border border-neutral-300 px-3 py-1 text-[11px] font-semibold text-brand-70 transition-colors hover:border-brand-orange hover:text-brand-orange disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="border-t-4 border-brand-orange bg-white p-5 shadow-sm">
          <h2 className="mb-3 flex items-center gap-3 text-[13px] font-bold">
            {editingEmail ? `Editing ${editingEmail}` : "Add or update a person"}
            {editingEmail && (
              <button
                type="button"
                onClick={resetForm}
                className="border border-neutral-300 px-2.5 py-0.5 text-[11px] font-semibold text-brand-70 hover:border-brand-orange hover:text-brand-orange"
              >
                Cancel
              </button>
            )}
          </h2>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <EmailCombobox
              value={email}
              onChange={setEmail}
              placeholder="Type a name or email…"
              className={`${inputCls} w-[280px]`}
            />
            <select
              value={type}
              onChange={(e) => setType(e.target.value as typeof type)}
              className={`${inputCls} bg-white`}
            >
              <option value="full">Full access — can edit everything</option>
              <option value="state">A whole state</option>
              <option value="group">A group — state and/or role</option>
              <option value="subset">Named employees</option>
            </select>
            {(type === "state" || type === "group") &&
              STATES.map((s) => (
                <label key={s} className="flex items-center gap-1.5 text-[13px]">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-brand-orange"
                    checked={states.includes(s)}
                    onChange={() => toggle(states, s, setStates)}
                  />
                  {s}
                </label>
              ))}
          </div>

          {type === "group" && (
            <div className="mb-3">
              <div className="mb-1 text-[11px] font-semibold tracking-wide text-brand-70">
                Roles {roles.length > 0 && `(${roles.length} picked)`}
              </div>
              <div className="max-h-[180px] overflow-y-auto border-2 border-neutral-200 p-2">
                {positions.map((p) => (
                  <label
                    key={p.pos}
                    className="flex items-center gap-2 px-1 py-0.5 text-[13px] hover:bg-neutral-50"
                  >
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-brand-orange"
                      checked={roles.includes(p.pos)}
                      onChange={() => toggle(roles, p.pos, setRoles)}
                    />
                    {p.pos}
                    <span className="text-[11px] text-neutral-400">{p.count}</span>
                  </label>
                ))}
              </div>
              <p className="mt-1 text-[12px] text-brand-70">
                {groupMatchCount === null
                  ? "Leave roles empty for everyone in the chosen states."
                  : `Matches ${groupMatchCount} ${groupMatchCount === 1 ? "person" : "people"} right now — and keeps matching as people come and go.`}
              </p>
            </div>
          )}

          {type === "subset" && (
            <div className="mb-3">
              <input
                type="text"
                placeholder="Search employees..."
                value={empSearch}
                onChange={(e) => setEmpSearch(e.target.value)}
                className={`${inputCls} mb-2 w-[280px]`}
              />
              <div className="max-h-[200px] overflow-y-auto border-2 border-neutral-200 p-2">
                {filteredEmployees.map((e) => (
                  <label
                    key={e.id}
                    className="flex items-center gap-2 px-1 py-0.5 text-[13px] hover:bg-neutral-50"
                  >
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-brand-orange"
                      checked={ids.includes(e.id)}
                      onChange={() => toggle(ids, e.id, setIds)}
                    />
                    {e.name}
                    <span className="text-[11px] text-neutral-400">
                      {e.id} · {e.st}
                    </span>
                  </label>
                ))}
              </div>
              <div className="mt-1 text-[11px] text-brand-70">{ids.length} selected</div>
            </div>
          )}

          {type !== "full" && (
            <div className="mb-4">
              <div className="mb-1 text-[11px] font-semibold tracking-wide text-brand-70">
                Visible fields
              </div>
              <div className="flex flex-wrap gap-3">
                {NUMERIC_FIELDS.map((f) => (
                  <label key={f} className="flex items-center gap-1.5 text-[13px]">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-brand-orange"
                      checked={fields.includes(f)}
                      onChange={() => toggle(fields, f, setFields)}
                    />
                    {FIELD_LABELS[f]}
                    {SENSITIVE.includes(f) && (
                      <span className="bg-brand-orange-tint px-1.5 py-px text-[10px] font-bold text-brand-orange">
                        salary
                      </span>
                    )}
                  </label>
                ))}
              </div>
            </div>
          )}

          {type !== "full" && (
            <div className="mb-4">
              <div className="mb-1 text-[11px] font-semibold tracking-wide text-brand-70">
                Can edit
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {EDITABLE_FIELDS.map((f) => {
                  // Editing a figure they were never sent is not a thing that
                  // can happen, so the box says so rather than looking
                  // available and then being ignored on save.
                  const hidden = !fields.includes(f);
                  return (
                    <label
                      key={f}
                      title={
                        hidden
                          ? `Tick ${FIELD_LABELS[f]} under Visible fields first — nobody can change a figure they can't see`
                          : undefined
                      }
                      className={`flex items-center gap-1.5 text-[13px] ${
                        hidden ? "text-brand-70 opacity-60" : ""
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-brand-orange"
                        disabled={hidden}
                        checked={!hidden && editable.includes(f)}
                        onChange={() => toggle(editable, f, setEditable)}
                      />
                      {FIELD_LABELS[f]}
                    </label>
                  );
                })}
                <span className="text-[12px] text-brand-70">
                  Tick none for read only.
                </span>
              </div>
            </div>
          )}

          {type !== "full" && (
            <div className="mb-4">
              <div className="mb-1 text-[11px] font-semibold tracking-wide text-brand-70">
                Can lock
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-1.5 text-[13px]">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-brand-orange"
                    checked={canLock}
                    onChange={() => setCanLock((v) => !v)}
                  />
                  Can lock/unlock rows
                </label>
                <span className="text-[12px] text-brand-70">
                  Independent of Discretionary/IPM above — someone can hold
                  this with no edit grant at all, or an edit grant with this
                  unticked.
                </span>
              </div>
            </div>
          )}

          {/* Every rule type, full access included: being an admin is not by
              itself an answer to whether someone may send a signed letter. */}
          <div className="mb-4">
            <div className="mb-1 text-[11px] font-semibold tracking-wide text-brand-70">
              Can download letters
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5 text-[13px]">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-brand-orange"
                  checked={canDownloadLetter}
                  onChange={() => setCanDownloadLetter((v) => !v)}
                />
                Can download remuneration letters
              </label>
              <span className="text-[12px] text-brand-70">
                The signed FY27 review and FY26 award letter, for their own
                people once a row is locked. Not implied by full access —
                every admin needs this ticked too.
              </span>
            </div>
          </div>

          {type === "full" && (
            <div className="mb-4">
              <div className="mb-1 text-[11px] font-semibold tracking-wide text-brand-70">
                Can edit pool caps
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-1.5 text-[13px]">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-brand-orange"
                    checked={canEditCaps}
                    onChange={() => setCanEditCaps((v) => !v)}
                  />
                  Can edit VIC/NSW/Group pool caps
                </label>
                <span className="text-[12px] text-brand-70">
                  Separate from full access itself — most admins won&apos;t
                  need this. Unticked by default even for a new full-access
                  grant.
                </span>
              </div>
            </div>
          )}

          {/* Rendered for every rule type, full included — the delegation is
              about the TARGETS' dashboards, so the grantee's own access type
              doesn't decide whether it makes sense. */}
          <div className="mb-4">
            <div className="mb-1 text-[11px] font-semibold tracking-wide text-brand-70">
              Can act for
            </div>
            <p className="mb-2 max-w-[640px] text-[12px] text-brand-70">
              This person can open the ticked people&apos;s dashboards through
              View as and make changes there. Every change is recorded against
              this person&apos;s name, not the dashboard owner&apos;s. Full
              access dashboards stay read only in View as.
            </p>
            <div className="flex max-h-[200px] max-w-[640px] flex-col gap-1 overflow-auto border border-neutral-200 bg-white p-2">
              {rules.filter((r) => r.email !== email.trim().toLowerCase()).length ===
                0 && (
                <span className="px-1 py-1 text-[12px] text-brand-70">
                  Nobody else is on the access list yet.
                </span>
              )}
              {rules
                .filter((r) => r.email !== email.trim().toLowerCase())
                .map((r) => (
                  <label
                    key={r.email}
                    className="flex items-start gap-1.5 px-1 text-[13px]"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-3.5 w-3.5 accent-brand-orange"
                      checked={actAs.includes(r.email)}
                      onChange={() => toggle(actAs, r.email, setActAs)}
                    />
                    <span>
                      <span className="font-semibold">{r.email}</span>{" "}
                      <span className="text-[12px] text-brand-70">
                        · {describe(r.rule)}
                      </span>
                      {actAs.includes(r.email) &&
                        r.rule.type !== "full" &&
                        r.rule.editableFields.length === 0 && (
                          <span className="block text-[12px] text-brand-70">
                            This person&apos;s own access is read only, so
                            acting for them changes nothing until you grant
                            them an editable figure.
                          </span>
                        )}
                    </span>
                  </label>
                ))}
            </div>
          </div>

          <button
            type="button"
            disabled={busy}
            onClick={submit}
            className="bg-brand-orange px-6 py-2.5 text-[12px] font-bold text-white transition-colors hover:bg-brand-orange-hover disabled:opacity-50"
          >
            {busy ? "Saving…" : editingEmail ? "Save changes" : "Grant access"}
          </button>
        </div>
      </div>
    </div>
  );
}
