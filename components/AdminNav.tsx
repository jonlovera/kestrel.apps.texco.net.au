"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/admin/access", label: "Access" },
  { href: "/admin/columns", label: "Columns" },
  { href: "/admin/text", label: "Text" },
  { href: "/admin/params", label: "Params" },
  { href: "/admin/import", label: "Import" },
  { href: "/admin/snapshots", label: "Snapshots" },
];

export default function AdminNav() {
  const pathname = usePathname();
  return (
    <div className="flex gap-1 px-5 pt-4">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={`rounded-t-md px-5 py-2 text-xs font-bold uppercase tracking-wide transition-colors ${
            pathname.startsWith(t.href)
              ? "bg-[#FC4D0F] text-white"
              : "bg-neutral-200 text-[#5C5C5C] hover:bg-neutral-300"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
