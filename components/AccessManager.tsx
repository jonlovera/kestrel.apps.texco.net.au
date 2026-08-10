"use client";

import { useState } from "react";
import type { GrantingRule, RuleSource } from "@/lib/access-rules";
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
  pkg: "Package",
  bp: "Bonus%",
  ipm: "IPM%",
  bipm: "After IPM",
  calc: "Calc bonus",
  f25: "FY25 bonus",
  da: "Discretionary",
  yoy: "YoY diff",
  final: "Final",
};
const SENSITIVE: NumericField[] = ["pkg", "bp"];
const STATES = ["VIC", "NSW", "SHARED"] as const;
const DEFAULT_FIELDS: NumericField[] = ["ipm", "bipm", "calc", "f25", "da", "yoy", "final"];

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
    const rule: GrantingRule =
      type === "full"
        ? { type: "full" }
        : type === "state"
          ? {
              type: "state",
              states: states as ("VIC" | "NSW" | "SHARED")[],
              visibleFields: fields,
            }
          : type === "group"
            ? {
                type: "group",
                states: states as ("VIC" | "NSW" | "SHARED")[],
                positions: roles,
                visibleFields: fields,
              }
            : { type: "subset", employeeIds: ids, visibleFields: fields };
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
    if (rule.type === "full") return "Everyone · all fields · can edit";
    if (rule.type === "state") return `${rule.states.join(" + ")} · can set IPM and Discretionary`;
    if (rule.type === "group") {
      const where = rule.states.length ? rule.states.join(" + ") : "all states";
      const who = rule.positions.length ? rule.positions.join(", ") : "all roles";
      return `${where} · ${who} · can set IPM and Discretionary`;
    }
    return `${rule.employeeIds.length} employee${rule.employeeIds.length === 1 ? "" : "s"} · can set IPM and Discretionary`;
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
    " border-2 border-neutral-200 px-3 py-2 text-[13px] outline-none focus:border-[#FC4D0F]";

  return (
    <div>
      <div className="mx-auto w-full max-w-[1100px] flex-1 px-5 py-6">
        <h1 className="mb-1 text-lg font-bold">Who can sign in</h1>
        <p className="mb-4 text-[13px] text-[#5C5C5C]">
          People sign in with their Texco Microsoft account; they see nothing
          unless listed here. Start typing a name below and pick them from the
          directory, or type any address in full — access can be granted to
          people outside the bonus scheme too. Use <strong>Edit</strong> to
          amend someone in place rather than removing and re-adding them.
          Everyone except full access sees only their own rows, and can set
          IPM and Discretionary on them. Changes apply immediately — no deploy
          needed. Entries marked{" "}
          <span className="font-semibold">code</span> are seeded in the repo and
          reappear unless removed here.
        </p>

        {error && (
          <div className="mb-4 border-2 border-[#FC4D0F] bg-[#FED9CC] px-4 py-2 text-[13px] font-semibold text-[#191919]">
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
                    className="whitespace-nowrap bg-[#191919] px-3 py-2.5 text-left text-[11px] tracking-wide text-white"
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
                  <td className="max-w-[320px] truncate px-3 py-2 text-[#5C5C5C]" title={fieldsOf(r.rule)}>
                    {fieldsOf(r.rule)}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block px-2 py-0.5 text-[11px] font-bold ${
                        r.source === "db"
                          ? "bg-[#FED9CC] text-[#FC4D0F]"
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
                      className="mr-1 border border-neutral-300 px-3 py-1 text-[11px] font-semibold text-[#5C5C5C] transition-colors hover:border-[#FC4D0F] hover:text-[#FC4D0F] disabled:opacity-40"
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
                      className="border border-neutral-300 px-3 py-1 text-[11px] font-semibold text-[#5C5C5C] transition-colors hover:border-[#FC4D0F] hover:text-[#FC4D0F] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="border-t-4 border-[#FC4D0F] bg-white p-5 shadow-sm">
          <h2 className="mb-3 flex items-center gap-3 text-[13px] font-bold">
            {editingEmail ? `Editing ${editingEmail}` : "Add or update a person"}
            {editingEmail && (
              <button
                type="button"
                onClick={resetForm}
                className="border border-neutral-300 px-2.5 py-0.5 text-[11px] font-semibold text-[#5C5C5C] hover:border-[#FC4D0F] hover:text-[#FC4D0F]"
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
                    className="h-3.5 w-3.5 accent-[#FC4D0F]"
                    checked={states.includes(s)}
                    onChange={() => toggle(states, s, setStates)}
                  />
                  {s}
                </label>
              ))}
          </div>

          {type === "group" && (
            <div className="mb-3">
              <div className="mb-1 text-[11px] font-semibold tracking-wide text-[#5C5C5C]">
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
                      className="h-3.5 w-3.5 accent-[#FC4D0F]"
                      checked={roles.includes(p.pos)}
                      onChange={() => toggle(roles, p.pos, setRoles)}
                    />
                    {p.pos}
                    <span className="text-[11px] text-neutral-400">{p.count}</span>
                  </label>
                ))}
              </div>
              <p className="mt-1 text-[12px] text-[#5C5C5C]">
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
                      className="h-3.5 w-3.5 accent-[#FC4D0F]"
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
              <div className="mt-1 text-[11px] text-[#5C5C5C]">{ids.length} selected</div>
            </div>
          )}

          {type !== "full" && (
            <div className="mb-4">
              <div className="mb-1 text-[11px] font-semibold tracking-wide text-[#5C5C5C]">
                Visible fields
              </div>
              <div className="flex flex-wrap gap-3">
                {NUMERIC_FIELDS.map((f) => (
                  <label key={f} className="flex items-center gap-1.5 text-[13px]">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-[#FC4D0F]"
                      checked={fields.includes(f)}
                      onChange={() => toggle(fields, f, setFields)}
                    />
                    {FIELD_LABELS[f]}
                    {SENSITIVE.includes(f) && (
                      <span className="bg-[#FED9CC] px-1.5 py-px text-[10px] font-bold text-[#FC4D0F]">
                        salary
                      </span>
                    )}
                  </label>
                ))}
              </div>
            </div>
          )}

          <button
            type="button"
            disabled={busy}
            onClick={submit}
            className="bg-[#FC4D0F] px-6 py-2.5 text-[12px] font-bold text-white transition-colors hover:bg-[#e0440d] disabled:opacity-50"
          >
            {busy ? "Saving…" : editingEmail ? "Save changes" : "Grant access"}
          </button>
        </div>
      </div>
    </div>
  );
}
