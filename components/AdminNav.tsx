"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Columns, wording and the scheme parameters are edited in place on the
// dashboard now, directly, with no separate mode to switch into — what's
// left here is what doesn't belong in a cell.
const TABS = [
  { href:"/admin/access", label: "Access" },
  { href:"/admin/import", label: "Import" },
  { href:"/admin/snapshots", label: "Snapshots" },
  { href:"/admin/visitors", label: "Visitors" },
];

export default function AdminNav() {
  const pathname = usePathname();
  return (
    <div className="flex gap-1 px-5 pt-4">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={`px-5 py-2 text-xs font-bold tracking-wide transition-colors ${
            pathname.startsWith(t.href)
              ? "bg-brand-orange text-white"
              : "bg-neutral-200 text-brand-70 hover:bg-neutral-300"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
