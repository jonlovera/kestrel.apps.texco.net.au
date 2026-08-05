/**
 * Seed the Redis store with the local source data file.
 *
 *   npx tsx scripts/seed-store.ts            # uses .env.local / env creds
 *
 * Reads data/bonus.json (untracked, local only), validates it, and writes it
 * to the `kestrel:data:fy26` doc. Run once against production credentials
 * after the Upstash resource is working, and after any out-of-band data fix.
 * (Deliberately does not import lib/store.ts — that module is server-only.)
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Redis } from "@upstash/redis";
import { DatasetSchema } from "../lib/schema";

// minimal .env.local loader so the script works outside `next dev`
const envPath = join(__dirname, "..", ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}

const url = process.env.KV_REST_API_URL;
const token = process.env.KV_REST_API_TOKEN;
if (!url || !token) {
  console.error("KV_REST_API_URL / KV_REST_API_TOKEN not set — nothing to seed against.");
  process.exit(1);
}

const data = DatasetSchema.parse(
  JSON.parse(readFileSync(join(__dirname, "..", "data", "bonus.json"), "utf-8"))
);

const redis = new Redis({ url, token });
redis
  .set("kestrel:data:fy26", data)
  .then(async () => {
    const back = await redis.get("kestrel:data:fy26");
    const parsed = DatasetSchema.parse(back);
    console.log(`Seeded kestrel:data:fy26 with ${parsed.emp.length} employees.`);
    console.log(`Caps: vCap ${parsed.vCap}  nCap ${parsed.nCap}  gCap ${parsed.gCap}`);
  })
  .catch((err) => {
    console.error("Seed failed:", err.message);
    process.exit(1);
  });
