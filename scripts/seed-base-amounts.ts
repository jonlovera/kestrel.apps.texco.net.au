/**
 * Materialise every row's payout as a STORED figure.
 *
 *   npx tsx scripts/seed-base-amounts.ts            # dry run, writes nothing
 *   npx tsx scripts/seed-base-amounts.ts --write    # commits
 *
 * A payout is `baseAmount + daEdit` (lib/schema.ts). `baseAmount` is optional
 * while it is being introduced over live data, and lib/calc.ts falls back for a
 * row that has none — to the legacy `lockedFinal` for the rows frozen before
 * 25 August 2026, and otherwise to the advisory "Calc bonus" figure. That last
 * fallback is a derivation, which is what this removes: once every row carries a
 * `baseAmount`, a payout is read from storage and nothing recomputes it.
 *
 * Number-neutral by construction: `baseAmount = finalBonus - daEdit` as the
 * engine reports them right now, so every payout is identical afterwards. The
 * script asserts that before writing and refuses if any row would move.
 *
 * Takes a snapshot first (same restore point every mutating action leaves), so
 * /admin/snapshots can undo it.
 *
 * Deliberately does not import lib/store.ts — that module is server-only. Same
 * shape as scripts/seed-store.ts, including the .env.local loader.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { neon } from "@neondatabase/serverless";
import {
  DatasetSchema,
  OverridesSchema,
  SnapshotSchema,
  type Overrides,
} from "../lib/schema";
import { ParamsSchema, applyParams, defaultParams } from "../lib/params-apply";
import { applyOverrides, computeScalesAndBonuses } from "../lib/calc";

const envPath = join(__dirname, "..", ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}

const WRITE = process.argv.includes("--write");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set — point this at a store before running it.");
  process.exit(1);
}
const sql = neon(url);

const DOC = {
  data: "kestrel:data:fy26",
  overrides: "kestrel:overrides:fy26",
  params: "kestrel:params:fy26",
} as const;

async function readDoc<T>(key: string): Promise<T | null> {
  const rows = (await sql`SELECT doc FROM kestrel_docs WHERE key = ${key}`) as {
    doc: T;
  }[];
  return rows.length > 0 ? rows[0].doc : null;
}

const fmt = (n: number) =>
  "$" + n.toLocaleString("en-AU", { maximumFractionDigits: 0 });

async function main() {
  const rawData = await readDoc<unknown>(DOC.data);
  if (!rawData) throw new Error(`${DOC.data} is empty — nothing to seed against.`);
  const base = DatasetSchema.parse(rawData);
  const rawParams = await readDoc<unknown>(DOC.params);
  const params = rawParams
    ? ParamsSchema.parse(rawParams)
    : defaultParams(base);
  const data = applyParams(base, params);
  const stored = OverridesSchema.parse((await readDoc<unknown>(DOC.overrides)) ?? {});

  const rows = applyOverrides(data.emp, stored);
  computeScalesAndBonuses(rows, data);

  const next: Overrides = { ...stored };
  let added = 0;
  let already = 0;
  for (const e of rows) {
    if (stored[e.id]?.baseAmount !== undefined) {
      already += 1;
      continue;
    }
    next[e.id] = { ...next[e.id], baseAmount: e.finalBonus - e.daEdit };
    added += 1;
  }

  // The guarantee: seeding moves nothing. Re-price the whole document with the
  // stored amounts in place and compare every payout before committing.
  const after = applyOverrides(data.emp, next);
  computeScalesAndBonuses(after, data);
  const wasById = new Map(rows.map((e) => [e.id, e.finalBonus]));
  const moved = after.filter(
    (e) => Math.abs(e.finalBonus - (wasById.get(e.id) ?? 0)) > 0.005
  );

  console.log(`rows                : ${rows.length}`);
  console.log(`already had a base  : ${already}`);
  console.log(`bases to write      : ${added}`);
  console.log(`payouts that move   : ${moved.length}`);
  console.log(
    `total payout        : ${fmt(rows.reduce((s, e) => s + e.finalBonus, 0))} -> ${fmt(after.reduce((s, e) => s + e.finalBonus, 0))}`
  );

  if (moved.length > 0) {
    for (const e of moved.slice(0, 10)) {
      console.error(
        `  MOVED ${e.id} ${e.gn} ${e.sn}: ${fmt(wasById.get(e.id) ?? 0)} -> ${fmt(e.finalBonus)}`
      );
    }
    throw new Error(
      "refusing to write: seeding must not move a payout. Investigate before retrying."
    );
  }

  if (!WRITE) {
    console.log("\ndry run — nothing written. Re-run with --write to commit.");
    return;
  }

  // Restore point first, in exactly the shape lib/snapshots.ts writes and
  // SnapshotSchema parses — a malformed one would be unrestorable, which
  // defeats the point of taking it.
  const version = (
    (await sql`SELECT version FROM kestrel_docs WHERE key = ${DOC.overrides}`) as {
      version: number;
    }[]
  )[0]?.version;
  const snapshot = {
    ts: new Date().toISOString(),
    actor: "scripts/seed-base-amounts.ts",
    reason: "edit",
    state: {
      dataset: base,
      overrides: stored,
      ...(typeof version === "number" ? { overridesVersion: version } : {}),
      params: rawParams ?? null,
      columns: (await readDoc<unknown>("kestrel:columns:fy26")) ?? null,
      copy: (await readDoc<unknown>("kestrel:copy:fy26")) ?? null,
      access: (await readDoc<unknown>("kestrel:access:fy26")) ?? null,
    },
  };
  // parse before writing: an unparseable snapshot is worse than none
  SnapshotSchema.parse(snapshot);
  await sql`INSERT INTO kestrel_log (key, entry)
            VALUES ('kestrel:snapshots:fy26', ${JSON.stringify(snapshot)}::jsonb)`;

  await sql`UPDATE kestrel_docs
            SET doc = ${JSON.stringify(next)}::jsonb,
                version = version + 1,
                updated_at = now()
            WHERE key = ${DOC.overrides}`;
  console.log(`\nwrote ${added} bases, snapshot taken. Payouts unchanged.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
