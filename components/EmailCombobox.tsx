"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Type a name, pick the person, get their address — so granting access doesn't
 * mean remembering how someone's email is spelled.
 *
 * The list comes from the company directory via /api/directory. It is a
 * shortcut, never a restriction: any address can still be typed in full, which
 * matters because access is often granted to people outside the bonus roster
 * (payroll, IT). If the directory lookup isn't available the field simply
 * behaves as a plain text input and says why.
 */

interface Person {
  id: string;
  name: string;
  email: string;
  jobTitle?: string;
  department?: string;
}

export default function EmailCombobox({
  value,
  onChange,
  className = "",
  placeholder = "Type a name or email…",
}: {
  value: string;
  onChange: (email: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const [people, setPeople] = useState<Person[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  // only the newest query may write results
  const seq = useRef(0);

  const query = value.trim();
  const searchable = query.length >= 2;

  useEffect(() => {
    if (!searchable) return;
    const id = ++seq.current;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/directory?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        if (id !== seq.current) return;
        if (data.available === false) {
          setUnavailable(data.message ?? "Directory lookup is unavailable.");
          setPeople([]);
        } else {
          setUnavailable(null);
          setPeople(data.people ?? []);
          setHighlight(0);
        }
      } catch {
        if (id === seq.current) setPeople([]);
      } finally {
        if (id === seq.current) setLoading(false);
      }
    }, 250); // debounce: one lookup per pause, not per keystroke
    return () => clearTimeout(timer);
  }, [query, searchable]);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  function choose(p: Person) {
    onChange(p.email);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const list = searchable ? people : [];
    if (!open || list.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (h + 1) % list.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (h - 1 + list.length) % list.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(list[Math.min(highlight, list.length - 1)]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  // a stale list from a previous query must not linger once the box is cleared
  const matches = searchable ? people : [];
  const showList = open && searchable && (loading || matches.length > 0);
  const listId = "directory-matches";

  return (
    <div className="relative" ref={box}>
      <input
        type="text"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className={className}
      />

      {showList && (
        <ul id="directory-matches" className="absolute z-50 mt-1 max-h-[280px] w-[360px] overflow-auto border border-neutral-200 bg-white shadow-2xl">
          {loading && matches.length === 0 && (
            <li className="px-3 py-2 text-[12px] text-[#5C5C5C]">Searching…</li>
          )}
          {matches.map((p, i) => (
            <li key={p.id}>
              <button
                type="button"
                onMouseEnter={() => setHighlight(i)}
                onClick={() => choose(p)}
                className={`block w-full px-3 py-2 text-left text-[13px] ${
                  i === highlight ? "bg-[#FED9CC]" : "hover:bg-neutral-50"
                }`}
              >
                <span className="font-semibold">{p.name}</span>
                <br />
                <span className="text-[12px] text-[#5C5C5C]">
                  {p.email}
                  {p.jobTitle ? ` · ${p.jobTitle}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {unavailable && (
        <p className="mt-1 max-w-[420px] text-[11px] leading-4 text-[#5C5C5C]">
          {unavailable}
        </p>
      )}
    </div>
  );
}
