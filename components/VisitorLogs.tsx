"use client";

interface PageviewRow {
  ts: string;
  path: string;
  email: string;
  name?: string;
}

interface AnonVisitRow {
  ts: string;
  path: string;
  ipPrefix: string | null;
}

interface Stats {
  totalPageviews: number;
  uniqueEmails: number;
  totalAnonVisits: number;
  uniqueIpPrefixes: number;
}

function formatWhen(ts: string): string {
  return new Date(ts).toLocaleString("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-[140px] flex-1 border border-neutral-200 bg-white px-4 py-3">
      <div className="text-xl font-bold tabular-nums">{value.toLocaleString("en-AU")}</div>
      <div className="text-[11px] font-bold tracking-wide text-brand-70">{label}</div>
    </div>
  );
}

export default function VisitorLogs({
  pageviews,
  anonVisits,
  stats,
}: {
  pageviews: PageviewRow[];
  anonVisits: AnonVisitRow[];
  stats: Stats;
}) {
  return (
    <div className="mx-auto w-full max-w-[1100px] flex-1 px-5 py-6">
      <h1 className="mb-1 text-lg font-bold">Visitors</h1>
      <p className="mb-4 text-[13px] text-brand-70">
        Every real page navigation is logged as it happens — signed-in visits
        attributed to the person&apos;s email, and hits from anyone who never
        signs in recorded with a truncated address only (never a full IP), and
        never for the login page itself. The most recent 5,000 of each are kept.
      </p>

      <div className="mb-6 flex flex-wrap gap-3">
        <StatTile label="SIGNED-IN PAGE VIEWS" value={stats.totalPageviews} />
        <StatTile label="UNIQUE SIGNED-IN USERS" value={stats.uniqueEmails} />
        <StatTile label="ANONYMOUS HITS" value={stats.totalAnonVisits} />
        <StatTile label="APPROX. UNIQUE ANON SOURCES" value={stats.uniqueIpPrefixes} />
      </div>

      <h2 className="mb-2 text-[13px] font-bold tracking-wide">Signed-in activity</h2>
      <div className="mb-6 overflow-x-auto shadow-sm">
        <table className="w-full border-collapse bg-white text-[13px]">
          <thead>
            <tr>
              {["When", "Who", "Page"].map((h) => (
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
            {pageviews.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-8 text-center text-brand-70">
                  No signed-in page views logged yet.
                </td>
              </tr>
            )}
            {pageviews.map((p, i) => (
              <tr key={`${p.ts}-${i}`} className="border-b border-neutral-100 hover:bg-neutral-50">
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">{formatWhen(p.ts)}</td>
                <td className="whitespace-nowrap px-3 py-2">{p.name ? `${p.name} (${p.email})` : p.email}</td>
                <td className="whitespace-nowrap px-3 py-2 text-brand-70">{p.path}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mb-2 text-[13px] font-bold tracking-wide">Anonymous activity</h2>
      <div className="overflow-x-auto shadow-sm">
        <table className="w-full border-collapse bg-white text-[13px]">
          <thead>
            <tr>
              {["When", "Page attempted", "Approx. source"].map((h) => (
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
            {anonVisits.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-8 text-center text-brand-70">
                  No anonymous visits logged yet.
                </td>
              </tr>
            )}
            {anonVisits.map((v, i) => (
              <tr key={`${v.ts}-${i}`} className="border-b border-neutral-100 hover:bg-neutral-50">
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">{formatWhen(v.ts)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-brand-70">{v.path}</td>
                <td className="whitespace-nowrap px-3 py-2">{v.ipPrefix ?? "unknown"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
