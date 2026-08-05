import "server-only";
import { Redis } from "@upstash/redis";
import { z } from "zod";
import { OverridesSchema, type Overrides } from "./schema";
import { AccessRuleSchema, type AccessRule } from "./access-rules";

/**
 * Persistence: Upstash Redis in production (Vercel Marketplace add-on), a
 * local JSON file per document during `next dev` when no Redis credentials
 * are configured. Two documents are stored:
 *  - editors' bonus adjustments (Overrides)
 *  - the access-rule overlay managed from /admin
 */
function redis(): Redis | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

async function devRead(file: string): Promise<unknown> {
  const { readFile } = await import("node:fs/promises");
  try {
    return JSON.parse(await readFile(`.data/${file}`, "utf-8"));
  } catch {
    return null;
  }
}

async function devWrite(file: string, doc: unknown): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(".data", { recursive: true });
  await writeFile(`.data/${file}`, JSON.stringify(doc, null, 1));
}

async function loadDoc<T>(
  key: string,
  file: string,
  schema: z.ZodType<T>,
  empty: T
): Promise<T> {
  const client = redis();
  const raw = client ? await client.get(key) : await devRead(file);
  if (!raw) return empty;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    console.error(`[store] stored doc ${key} failed validation; ignoring`, parsed.error);
    return empty;
  }
  return parsed.data;
}

async function saveDoc(key: string, file: string, doc: unknown): Promise<void> {
  const client = redis();
  if (client) {
    await client.set(key, doc);
  } else if (process.env.NODE_ENV === "development") {
    await devWrite(file, doc);
  } else {
    throw new Error(
      "No Redis configured (KV_REST_API_URL / KV_REST_API_TOKEN) — cannot persist in production."
    );
  }
}

// ── editors' bonus adjustments ───────────────────────────────────────────────
const OVERRIDES_KEY = "kestrel:overrides:fy26";
const OVERRIDES_FILE = "overrides.json";

export function loadOverrides(): Promise<Overrides> {
  return loadDoc(OVERRIDES_KEY, OVERRIDES_FILE, OverridesSchema, {});
}

export function saveOverrides(doc: Overrides): Promise<void> {
  return saveDoc(OVERRIDES_KEY, OVERRIDES_FILE, doc);
}

// ── access-rule overlay (managed from /admin) ────────────────────────────────
const ACCESS_KEY = "kestrel:access:fy26";
const ACCESS_FILE = "access.json";
const AccessOverlaySchema = z.record(z.string(), AccessRuleSchema);
export type AccessOverlay = Record<string, AccessRule>;

export function loadAccessOverlay(): Promise<AccessOverlay> {
  return loadDoc(ACCESS_KEY, ACCESS_FILE, AccessOverlaySchema, {});
}

export function saveAccessOverlay(doc: AccessOverlay): Promise<void> {
  return saveDoc(ACCESS_KEY, ACCESS_FILE, doc);
}
