/**
 * Correct the Eligible Salary of 43 people, and move their bonus entitlement
 * with it.
 *
 *   npx tsx scripts/correct-eligible-salaries.ts            # dry run, writes nothing
 *   npx tsx scripts/correct-eligible-salaries.ts --write    # commits
 *
 * WHY BOTH FIGURES MOVE. `cpm` is not stored — lib/calc.ts's deriveCpm
 * back-derives it from the stored `bipm` so that pkg × bp × cpm === bipm / ipm.
 * So changing `pkg` ALONE changes nothing at all: cpm absorbs it exactly and
 * Potential Bonus does not budge (verified: potential is identical at pkg
 * 133,900, 267,800 and 357,067). The figure that carries the entitlement is
 * `bipm`, so both are scaled by the same ratio and `cpm` is left where it was.
 * That constancy is the invariant asserted below — it is what proves this is a
 * proportional correction and not a re-pricing in disguise.
 *
 * WHAT THIS DOES NOT DO: move anybody's payout. A payout is the stored
 * `baseAmount + daEdit` (lib/schema.ts), so Potential and Calc bonus move here
 * and every Final bonus stays exactly where it is. Making payouts follow is the
 * separate, deliberate act of pressing RECALCULATE, which is permissioned,
 * previewable, and already leaves locked and issued rows alone. A script that
 * silently re-based those payouts — locked ones included — would bypass every
 * one of those protections, so it does not.
 *
 * Takes a snapshot first (the same restore point every mutating action leaves),
 * so /admin/snapshots can undo it.
 *
 * Deliberately does not import lib/store.ts — that module is server-only. Same
 * shape as scripts/seed-base-amounts.ts, including the .env.local loader.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { neon } from "@neondatabase/serverless";
import { DatasetSchema, SnapshotSchema, type Employee } from "../lib/schema";
import { deriveCpm } from "../lib/calc";

const envPath = join(__dirname, "..", ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}

/**
 * The corrected Eligible Salaries, as supplied. Embedded rather than read from
 * a file so the change is reviewable in the diff and reproducible from the
 * repository alone.
 *
 * 43 of the 49 figures supplied on 28 August 2026. The other six are in
 * NOT_IN_ROSTER below.
 */
const CORRECTIONS: Record<string, number> = {
  ADHAS: 232_200, ALANT: 180_000, ANNKA: 250_000, AVROB: 73_435,
  BEJEN: 207_000, DADOY: 245_300, GITAS: 187_600, GRGRI: 245_000,
  GYSCI: 222_500, HUMCL: 235_000, JAALV: 68_435, JADRI: 83_435,
  JOBEN: 200_000, JUROS: 252_800, JYSHA: 235_000, KAPET: 78_435,
  KETAL: 200_700, KUPIC: 83_435, LEBRO: 185_000, LUGUI: 225_000,
  LUTOW: 267_000, MAJOS: 220_000, MACOO: 360_000, MARUB: 62_435,
  MACAR: 180_000, MAMOR: 227_500, MIJAR: 305_000, MILAR: 192_500,
  MIBRI: 260_000, MISHA: 170_000, NETIM: 290_000, NIBAI: 205_000,
  NOPER: 205_000, PADAR: 290_000, PADWY: 260_300, RIMOS: 78_435,
  ROHUG: 197_500, RUCUN: 185_000, SALUP: 260_000, SCPOR: 280_000,
  STHOW: 245_300, TANIC: 190_000, THMCC: 275_000,
};

/**
 * Supplied in the same list, but no employee carries these ids — not in the
 * live roster of 146, and not on the dataset's `excludedIds` either, so they
 * were never removed: they have simply never been in Kestrel. Owner decision,
 * 28 August 2026: ignore them and correct the other 43.
 *
 * Held here rather than deleted so the omission is a recorded decision instead
 * of six figures that quietly went missing, and so re-adding them later is a
 * matter of moving a line. Deliberately NOT fed to the run — the "every id must
 * exist" guard below stays absolute, because a salary correction that skips
 * people silently is the one failure nobody notices until it matters.
 */
const NOT_IN_ROSTER: Record<string, number> = {
  ALGOM: 83_435, BAMEA: 185_000, DACON: 179_200,
  JOTUR: 69_000, SUDAL: 78_435, ZACOA: 75_000,
};

const WRITE = process.argv.includes("--write");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set — point this at a store before running it.");
  process.exit(1);
}
const sql = neon(url);

const DOC = { data: "kestrel:data:fy26" } as const;

async function readDoc<T>(key: string): Promise<T | null> {
  const rows = (await sql`SELECT doc FROM kestrel_docs WHERE key = ${key}`) as {
    doc: T;
  }[];
  return rows.length > 0 ? rows[0].doc : null;
}

const money = (n: number) =>
  "$" + n.toLocaleString("en-AU", { maximumFractionDigits: 0 });
/** Two decimals, so a stored figure stays a clean dollars-and-cents number. */
const cents = (n: number) => Math.round(n * 100) / 100;

async function main() {
  const rawData = await readDoc<unknown>(DOC.data);
  if (!rawData) throw new Error(`${DOC.data} is empty — nothing to correct.`);
  // The RAW dataset, not the params-folded one: this writes back to the source
  // document, and applyParams would bake the company modifier into `bipm`.
  const base = DatasetSchema.parse(rawData);
  const byId = new Map(base.emp.map((e) => [e.id, e]));

  const ids = Object.keys(CORRECTIONS);
  console.log(`corrections to apply : ${ids.length}`);
  console.log(`employees in dataset : ${base.emp.length}`);
  console.log(
    `deliberately ignored : ${Object.keys(NOT_IN_ROSTER).length} not in the roster ` +
      `(${Object.keys(NOT_IN_ROSTER).join(", ")})\n`
  );

  // ── guard 1: every id must exist. A silent skip on a salary correction is
  // the one failure nobody would notice until it mattered.
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    console.error(`NOT IN THE DATASET (${missing.length}): ${missing.join(", ")}`);
    throw new Error(
      "refusing to run: every id must match an employee. Check the ids against the roster before retrying."
    );
  }

  const emp: Employee[] = base.emp.map((e) => {
    const next = CORRECTIONS[e.id];
    if (next === undefined) return e;
    const ratio = next / e.pkg;
    return { ...e, pkg: next, bipm: cents(e.bipm * ratio) };
  });

  // ── the table, for sign-off ──
  const rows = ids
    .map((id) => {
      const was = byId.get(id)!;
      const now = emp.find((e) => e.id === id)!;
      return { id, was, now, ratio: now.pkg / was.pkg };
    })
    .sort((a, b) => a.ratio - b.ratio);

  console.log(
    `${"ID".padEnd(7)}${"NAME".padEnd(24)}${"SALARY".padStart(22)}${"AFTER IPM".padStart(22)}${"RATIO".padStart(8)}`
  );
  for (const { id, was, now, ratio } of rows) {
    const name = `${was.gn} ${was.sn}`.slice(0, 23);
    console.log(
      id.padEnd(7) +
        name.padEnd(24) +
        `${money(was.pkg)} → ${money(now.pkg)}`.padStart(22) +
        `${money(was.bipm)} → ${money(now.bipm)}`.padStart(22) +
        `${(ratio * 100).toFixed(1)}%`.padStart(8)
    );
  }

  // ── guard 2: cpm must not move. If it does, the two figures were not scaled
  // together and this is re-pricing somebody rather than correcting a salary.
  const drifted = rows.filter(({ was, now }) => {
    const a = deriveCpm(was).cpm;
    const b = deriveCpm(now).cpm;
    return Math.abs(b - a) > Math.max(1e-6, Math.abs(a) * 1e-6);
  });
  // ── guard 3: a salary must stay positive, and a real entitlement must not be
  // wiped out. A bipm that was ALREADY zero and stays zero is not a regression:
  // five of these people carry `bp: 0` — no bonus percentage at all — so their
  // entitlement is nil by design and they are paid entirely through
  // discretionary. Scaling nothing by anything is still nothing, and refusing
  // the batch over it would block 38 legitimate corrections.
  const nonPositive = rows.filter(
    ({ was, now }) => now.pkg <= 0 || (was.bipm > 0 && now.bipm <= 0)
  );
  const alreadyNil = rows.filter(({ was }) => was.bipm === 0);

  const potentialWas = rows.reduce((s, r) => s + deriveCpm(r.was).preIpm, 0);
  const potentialNow = rows.reduce((s, r) => s + deriveCpm(r.now).preIpm, 0);
  console.log(`\ncpm drift            : ${drifted.length} (must be 0)`);
  console.log(`entitlements wiped   : ${nonPositive.length} (must be 0)`);
  console.log(
    `no entitlement anyway: ${alreadyNil.length}` +
      (alreadyNil.length
        ? `  (${alreadyNil.map((r) => r.id).join(", ")} — bonus % is 0; salary corrects, bonus stays nil)`
        : "")
  );
  console.log(
    `potential (these ${rows.length})  : ${money(potentialWas)} → ${money(potentialNow)}`
  );

  // ── the display-only fields the supplied list says nothing about. Not
  // changed here, and not invented: reported so the inconsistency is a
  // decision rather than a surprise.
  const withElig = rows.filter(({ was }) => was.elig !== undefined);
  const withTotal = rows.filter(({ was }) => was.totalPkg !== undefined);
  console.log(
    `\nrows carrying Eligibility % : ${withElig.length}` +
      (withElig.length ? `  ← will disagree with the new salary` : "")
  );
  console.log(
    `rows carrying Total Package : ${withTotal.length}` +
      (withTotal.length ? `  ← will disagree with the new salary` : "")
  );

  if (drifted.length > 0) {
    for (const { id, was, now } of drifted.slice(0, 10)) {
      console.error(
        `  CPM MOVED ${id}: ${deriveCpm(was).cpm} -> ${deriveCpm(now).cpm}`
      );
    }
    throw new Error("refusing to write: cpm must not move.");
  }
  if (nonPositive.length > 0) {
    console.error(`  WIPED: ${nonPositive.map((r) => r.id).join(", ")}`);
    throw new Error(
      "refusing to write: a salary would go non-positive, or a real entitlement would be wiped out."
    );
  }

  const changing = rows.filter(({ was, now }) => was.pkg !== now.pkg);
  console.log(`\nrows that would change: ${changing.length} of ${ids.length}`);

  if (!WRITE) {
    console.log("\ndry run — nothing written. Re-run with --write to commit.");
    console.log(
      "NOTE: this moves Potential and Calc bonus only. Payouts follow when\n" +
        "      somebody presses Recalculate, which leaves locked and issued rows alone."
    );
    return;
  }
  if (changing.length === 0) {
    console.log("\nnothing to do — every salary is already correct.");
    return;
  }

  // Restore point first, in exactly the shape lib/snapshots.ts writes and
  // SnapshotSchema parses — a malformed one would be unrestorable, which
  // defeats the point of taking it.
  const overridesVersion = (
    (await sql`SELECT version FROM kestrel_docs WHERE key = 'kestrel:overrides:fy26'`) as {
      version: number;
    }[]
  )[0]?.version;
  const snapshot = {
    ts: new Date().toISOString(),
    actor: "scripts/correct-eligible-salaries.ts",
    reason: "dataset",
    state: {
      dataset: base,
      overrides:
        (await readDoc<Record<string, unknown>>("kestrel:overrides:fy26")) ?? {},
      ...(typeof overridesVersion === "number" ? { overridesVersion } : {}),
      params: (await readDoc<unknown>("kestrel:params:fy26")) ?? null,
      columns: (await readDoc<unknown>("kestrel:columns:fy26")) ?? null,
      copy: (await readDoc<unknown>("kestrel:copy:fy26")) ?? null,
      access: (await readDoc<unknown>("kestrel:access:fy26")) ?? null,
    },
  };
  SnapshotSchema.parse(snapshot);
  await sql`INSERT INTO kestrel_log (list, entry)
            VALUES ('kestrel:snapshots:fy26', ${JSON.stringify(snapshot)}::jsonb)`;

  const next = DatasetSchema.parse({ ...base, emp });
  await sql`UPDATE kestrel_docs
            SET doc = ${JSON.stringify(next)}::jsonb,
                version = version + 1,
                updated_at = now()
            WHERE key = ${DOC.data}`;

  const lo = Math.min(...rows.map((r) => r.ratio));
  const hi = Math.max(...rows.map((r) => r.ratio));
  const entry = {
    ts: new Date().toISOString(),
    actor: "scripts/correct-eligible-salaries.ts",
    kind: "dataset",
    summary:
      `Corrected Eligible Salary for ${changing.length} people and scaled their After IPM to match ` +
      `(${(lo * 100).toFixed(1)}%–${(hi * 100).toFixed(1)}% of the previous figure). ` +
      `Potential bonus for these rows ${money(potentialWas)} → ${money(potentialNow)}. ` +
      `Payouts are unchanged until the pool is recalculated.`,
  };
  await sql`INSERT INTO kestrel_log (list, entry)
            VALUES ('kestrel:history:fy26', ${JSON.stringify(entry)}::jsonb)`;

  console.log(`\nwrote ${changing.length} corrections, snapshot taken.`);
  console.log("Payouts are unchanged. Press Recalculate to let them follow.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
