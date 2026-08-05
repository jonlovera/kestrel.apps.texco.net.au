import "server-only";
import { Redis } from "@upstash/redis";
import { OverridesSchema, type Overrides } from "./schema";

/**
 * Persistence for editors' adjustments (the Overrides doc): Upstash Redis in
 * production (Vercel Marketplace add-on), a local JSON file during `next dev`
 * when no Redis credentials are configured.
 */
const KEY = "kestrel:overrides:fy26";

function redis(): Redis | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

const DEV_FILE = ".data/overrides.json";

async function devRead(): Promise<unknown> {
  const { readFile } = await import("node:fs/promises");
  try {
    return JSON.parse(await readFile(DEV_FILE, "utf-8"));
  } catch {
    return {};
  }
}

async function devWrite(doc: Overrides): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(".data", { recursive: true });
  await writeFile(DEV_FILE, JSON.stringify(doc, null, 1));
}

export async function loadOverrides(): Promise<Overrides> {
  const client = redis();
  const raw = client ? await client.get(KEY) : await devRead();
  if (!raw) return {};
  const parsed = OverridesSchema.safeParse(raw);
  if (!parsed.success) {
    console.error("[store] stored overrides failed validation; ignoring", parsed.error);
    return {};
  }
  return parsed.data;
}

export async function saveOverrides(doc: Overrides): Promise<void> {
  const client = redis();
  if (client) {
    await client.set(KEY, doc);
  } else if (process.env.NODE_ENV === "development") {
    await devWrite(doc);
  } else {
    throw new Error(
      "No Redis configured (KV_REST_API_URL / KV_REST_API_TOKEN) — cannot persist edits in production."
    );
  }
}
