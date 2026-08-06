/**
 * Seed the Postgres store with the local source data file.
 *
 *   npx tsx scripts/seed-store.ts            # uses .env.local / env creds
 *
 * Reads data/bonus.json (untracked, local only), validates it, and writes it
 * to the `kestrel:data:fy26` doc. Run once against production credentials
 * after `scripts/init-db.ts`, and after any out-of-band data fix.
 * (Deliberately does not import lib/store.ts — that module is server-only.)
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { neon } from "@neondatabase/serverless";
import { DatasetSchema } from "../lib/schema";

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
  console.error("DATABASE_URL not set — nothing to seed against.");
  process.exit(1);
}

const data = DatasetSchema.parse(
  JSON.parse(readFileSync(join(__dirname, "..", "data", "bonus.json"), "utf-8"))
);

const sql = neon(url);
sql`INSERT INTO kestrel_docs (key, doc)
    VALUES ('kestrel:data:fy26', ${JSON.stringify(data)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`
  .then(async () => {
    const rows = await sql`SELECT doc FROM kestrel_docs WHERE key = 'kestrel:data:fy26'`;
    const parsed = DatasetSchema.parse(rows[0]?.doc);
    console.log(`Seeded kestrel:data:fy26 with ${parsed.emp.length} employees.`);
    console.log(`Caps: vCap ${parsed.vCap}  nCap ${parsed.nCap}  gCap ${parsed.gCap}`);
  })
  .catch((err) => {
    console.error("Seed failed:", err.message);
    process.exit(1);
  });
