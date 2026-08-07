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
}

const FIELD_LABELS: Record<NumericField, string> = {
  pkg: "Package",
  bp: "Bonus%",
  ipm: "IPM%",
  bipm: "After IPM",
  calc: "Calc bonus",
  f25: "FY25 bonus",
  da: "Disc adj",
  yoy: "YoY diff",
  final: "Final",
};
const SENSITIVE: NumericField[] = ["pkg", "bp"];
const STATES = ["VIC", "NSW", "SHARED"] as const;
const DEFAULT_FIELDS: NumericField[] = ["ipm", "bipm", "calc", "f25", "da", "yoy", "final"];

export default function AccessManager({
  initialRules,
  employees,
  me,
}: {
  initialRules: RuleRow[];
  employees: EmployeeOption[];
  me: string;
}) {
  const [rules, setRules] = useState<RuleRow[]>(initialRules);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // add form
  const [email, setEmail] = useState("");
  const [type, setType] = useState<"full" | "state" | "subset">("state");
  const [states, setStates] = useState<string[]>(["VIC"]);
  const [ids, setIds] = useState<string[]>([]);
  const [fields, setFields] = useState<NumericField[]>(DEFAULT_FIELDS);
  const [empSearch, setEmpSearch] = useState("");

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
          : { type: "subset", employeeIds: ids, visibleFields: fields };
    if (rule.type === "state" && rule.states.length === 0) {
      setError("Pick at least one state");
      return;
    }
    if (rule.type === "subset" && rule.employeeIds.length === 0) {
      setError("Pick at least one employee");
      return;
    }
    call("POST", { email: email.trim().toLowerCase(), rule });
  }

  function describe(rule: GrantingRule): string {
    if (rule.type === "full") return "Everyone · all fields · can edit";
    if (rule.type === "state")
      return `${rule.states.join(" + ")} · read only`;
    return `${rule.employeeIds.length} employee${rule.employeeIds.length === 1 ? "" : "s"} · read only`;
  }

  function fieldsOf(rule: GrantingRule): string {
    if (rule.type === "full") return "all";
    return rule.visibleFields.map((f) => FIELD_LABELS[f]).join(", ") || "none";
  }

  const toggle = <T,>(arr: T[], v: T, set: (a: T[]) => void) =>
    set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

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
          people outside the bonus scheme too. Changes apply immediately — no
          deploy needed. Entries marked{""}
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
                  <td className="px-3 py-2 text-right">
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
          <h2 className="mb-3 text-[13px] font-bold">
            Add or update a person
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
              <option value="full">Full access — can edit</option>
              <option value="state">State — read only</option>
              <option value="subset">Selected employees — read only</option>
            </select>
            {type === "state" &&
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
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
