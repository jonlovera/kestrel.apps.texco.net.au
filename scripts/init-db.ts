/**
 * Create the Postgres tables the store uses (idempotent).
 *
 *   npx tsx scripts/init-db.ts            # uses .env.local / env creds
 *
 * Run once after provisioning the Neon resource, before the first deploy.
 * Creates only the schema — deliberately seeds no rows: the overrides CAS
 * relies on the overrides row being absent until the first save.
 * (Deliberately does not import lib/store.ts — that module is server-only.)
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { neon } from "@neondatabase/serverless";

// minimal .env.local loader so the script works outside `next dev`
const envPath = join(__dirname, "..", ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set — nothing to initialize.");
  process.exit(1);
}

const sql = neon(url);

async function main() {
  // one statement per call: the Neon HTTP driver runs a single statement per request
  await sql`CREATE TABLE IF NOT EXISTS kestrel_docs (
    key text PRIMARY KEY,
    doc jsonb NOT NULL,
    version integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS kestrel_log (
    id bigserial PRIMARY KEY,
    list text NOT NULL,
    entry jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now())`;
  await sql`CREATE INDEX IF NOT EXISTS kestrel_log_list_id_idx
    ON kestrel_log (list, id DESC)`;
  const docs = await sql`SELECT count(*) AS n FROM kestrel_docs`;
  const log = await sql`SELECT count(*) AS n FROM kestrel_log`;
  console.log(
    `Tables ready: kestrel_docs (${docs[0].n} rows), kestrel_log (${log[0].n} rows).`
  );
}

main().catch((err) => {
  console.error("Init failed:", err.message);
  process.exit(1);
});
