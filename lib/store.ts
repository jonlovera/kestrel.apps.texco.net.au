import "server-only";
import { Redis } from "@upstash/redis";
import { z } from "zod";
import {
  OverridesSchema,
  HistoryEntrySchema,
  DatasetSchema,
  SnapshotSchema,
  type Overrides,
  type HistoryEntry,
  type Dataset,
  type Snapshot,
} from "./schema";
import { AccessRuleSchema, type AccessRule } from "./access-rules";
import {
  ColumnConfigSchema,
  DEFAULT_COLUMNS,
  normalizeConfig,
  type ColumnConfig,
} from "./columns";
import { ParamsSchema, type Params } from "./params-apply";

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
  let raw: unknown;
  try {
    const client = redis();
    raw = client ? await client.get(key) : await devRead(file);
  } catch (err) {
    // A storage outage must not take the whole app down: reads degrade to
    // baseline data (no overrides / seed-only access), writes still fail loud.
    console.error(`[store] failed to load ${key}; using empty doc:`, err);
    return empty;
  }
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

// ── source dataset (employees + caps), managed via /admin/import ────────────
const DATA_KEY = "kestrel:data:fy26";
const DATA_FILE = "dataset.json";

/** Returns null when no dataset has been stored (callers fall back). */
export async function loadStoredDataset(): Promise<Dataset | null> {
  const doc = await loadDoc<Dataset | null>(
    DATA_KEY,
    DATA_FILE,
    DatasetSchema as z.ZodType<Dataset | null>,
    null
  );
  return doc;
}

export function saveStoredDataset(doc: Dataset): Promise<void> {
  return saveDoc(DATA_KEY, DATA_FILE, doc);
}

// ── editors' bonus adjustments (versioned: lost updates return 409) ──────────
const OVERRIDES_KEY = "kestrel:overrides:fy26";
const OVERRIDES_FILE = "overrides.json";
const OVERRIDES_VER_KEY = "kestrel:overrides:ver";
const OVERRIDES_VER_FILE = "overrides.ver.json";

export function loadOverrides(): Promise<Overrides> {
  return loadDoc(OVERRIDES_KEY, OVERRIDES_FILE, OverridesSchema, {});
}

export async function loadOverridesVersion(): Promise<number> {
  try {
    const client = redis();
    const raw = client
      ? await client.get(OVERRIDES_VER_KEY)
      : await devRead(OVERRIDES_VER_FILE);
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch (err) {
    console.error("[store] failed to load overrides version:", err);
    return 0;
  }
}

export type CasResult =
  | { ok: true; version: number }
  | { ok: false; current: number };

/**
 * Compare-and-set save: only writes when the caller's version matches the
 * stored one, otherwise reports the current version so the caller can 409.
 * Atomic on Redis via a single Lua script; the dev file fallback does a
 * plain compare (single-process `next dev`).
 */
export async function saveOverridesCas(
  doc: Overrides,
  expectedVersion: number
): Promise<CasResult> {
  const client = redis();
  if (client) {
    const result = await client.eval(
      `local v = tonumber(redis.call('GET', KEYS[2]) or '0')
       if v ~= tonumber(ARGV[2]) then return -1 - v end
       redis.call('SET', KEYS[1], ARGV[1])
       return redis.call('INCR', KEYS[2])`,
      [OVERRIDES_KEY, OVERRIDES_VER_KEY],
      [JSON.stringify(doc), String(expectedVersion)]
    );
    const n = Number(result);
    // script returns new version on success, (-1 - current) on mismatch
    if (n >= 0) return { ok: true, version: n };
    return { ok: false, current: -1 - n };
  }
  if (process.env.NODE_ENV === "development") {
    const current = await loadOverridesVersion();
    if (current !== expectedVersion) return { ok: false, current };
    await devWrite(OVERRIDES_FILE, doc);
    await devWrite(OVERRIDES_VER_FILE, current + 1);
    return { ok: true, version: current + 1 };
  }
  throw new Error(
    "No Redis configured (KV_REST_API_URL / KV_REST_API_TOKEN) — cannot persist in production."
  );
}

/**
 * Unconditional write that still bumps the version (used by snapshot
 * restore), so any editor holding a stale version gets a 409 next save.
 */
export async function saveOverridesForce(doc: Overrides): Promise<void> {
  const client = redis();
  if (client) {
    await client.set(OVERRIDES_KEY, doc);
    await client.incr(OVERRIDES_VER_KEY);
  } else if (process.env.NODE_ENV === "development") {
    await devWrite(OVERRIDES_FILE, doc);
    await devWrite(OVERRIDES_VER_FILE, (await loadOverridesVersion()) + 1);
  } else {
    throw new Error(
      "No Redis configured (KV_REST_API_URL / KV_REST_API_TOKEN) — cannot persist in production."
    );
  }
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

// ── scheme-wide parameters (managed via /admin/params) ──────────────────────
const PARAMS_KEY = "kestrel:params:fy26";
const PARAMS_FILE = "params.json";

/** null = no explicit params stored; caller falls back to dataset defaults */
export async function loadParams(): Promise<Params | null> {
  return loadDoc<Params | null>(
    PARAMS_KEY,
    PARAMS_FILE,
    ParamsSchema as z.ZodType<Params | null>,
    null
  );
}

export function saveParams(params: Params): Promise<void> {
  return saveDoc(PARAMS_KEY, PARAMS_FILE, params);
}

// ── column presentation config (managed via /admin/columns) ─────────────────
const COLUMNS_KEY = "kestrel:columns:fy26";
const COLUMNS_FILE = "columns.json";

export async function loadColumnConfig(): Promise<ColumnConfig> {
  const cfg = await loadDoc<ColumnConfig>(
    COLUMNS_KEY,
    COLUMNS_FILE,
    ColumnConfigSchema as z.ZodType<ColumnConfig>,
    DEFAULT_COLUMNS
  );
  return normalizeConfig(cfg);
}

export function saveColumnConfig(cfg: ColumnConfig): Promise<void> {
  return saveDoc(COLUMNS_KEY, COLUMNS_FILE, cfg);
}

// ── snapshots (newest first, capped at 50) ───────────────────────────────────
const SNAPSHOTS_KEY = "kestrel:snapshots:fy26";
const SNAPSHOTS_FILE = "snapshots.json";
const SNAPSHOTS_CAP = 50;

export async function pushSnapshot(snapshot: Snapshot): Promise<void> {
  const client = redis();
  if (client) {
    await client.lpush(SNAPSHOTS_KEY, JSON.stringify(snapshot));
    await client.ltrim(SNAPSHOTS_KEY, 0, SNAPSHOTS_CAP - 1);
  } else if (process.env.NODE_ENV === "development") {
    const prev = (((await devRead(SNAPSHOTS_FILE)) as Snapshot[]) ?? []);
    await devWrite(SNAPSHOTS_FILE, [snapshot, ...prev].slice(0, SNAPSHOTS_CAP));
  } else {
    throw new Error("No Redis configured — cannot snapshot in production.");
  }
}

export async function loadSnapshots(limit = SNAPSHOTS_CAP): Promise<Snapshot[]> {
  try {
    const client = redis();
    const raw = client
      ? await client.lrange(SNAPSHOTS_KEY, 0, limit - 1)
      : (((await devRead(SNAPSHOTS_FILE)) as unknown[]) ?? []).slice(0, limit);
    return raw
      .map((item) => {
        const obj = typeof item === "string" ? JSON.parse(item) : item;
        const parsed = SnapshotSchema.safeParse(obj);
        return parsed.success ? parsed.data : null;
      })
      .filter((s): s is Snapshot => s !== null);
  } catch (err) {
    console.error("[store] failed to load snapshots:", err);
    return [];
  }
}

// ── change history (append-only, newest first, capped) ───────────────────────
const HISTORY_KEY = "kestrel:history:fy26";
const HISTORY_FILE = "history.json";
const HISTORY_CAP = 2000;

/**
 * Append history entries. Never throws — a history failure must not fail the
 * save it describes.
 */
export async function appendHistory(entries: HistoryEntry[]): Promise<void> {
  if (entries.length === 0) return;
  try {
    const client = redis();
    if (client) {
      // newest first: LPUSH in reverse so entries[0] ends up at the head
      await client.lpush(
        HISTORY_KEY,
        ...[...entries].reverse().map((e) => JSON.stringify(e))
      );
      await client.ltrim(HISTORY_KEY, 0, HISTORY_CAP - 1);
    } else if (process.env.NODE_ENV === "development") {
      const prev = ((await devRead(HISTORY_FILE)) as HistoryEntry[]) ?? [];
      await devWrite(HISTORY_FILE, [...entries, ...prev].slice(0, HISTORY_CAP));
    }
  } catch (err) {
    console.error("[store] failed to append history:", err);
  }
}

export async function loadHistory(limit = 500): Promise<HistoryEntry[]> {
  try {
    const client = redis();
    const raw = client
      ? await client.lrange(HISTORY_KEY, 0, limit - 1)
      : (((await devRead(HISTORY_FILE)) as unknown[]) ?? []).slice(0, limit);
    return raw
      .map((item) => {
        const obj = typeof item === "string" ? JSON.parse(item) : item;
        const parsed = HistoryEntrySchema.safeParse(obj);
        return parsed.success ? parsed.data : null;
      })
      .filter((e): e is HistoryEntry => e !== null);
  } catch (err) {
    console.error("[store] failed to load history:", err);
    return [];
  }
}
