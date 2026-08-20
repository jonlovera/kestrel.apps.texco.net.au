import "server-only";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
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
import {
  AccessRuleSchema,
  dropInvalidRules,
  type AccessRule,
} from "./access-rules";
import {
  ColumnConfigSchema,
  DEFAULT_COLUMNS,
  dropRetiredFields,
  migrateRenamedLabels,
  normalizeConfig,
  type ColumnConfig,
} from "./columns";
import { ParamsSchema, type Params } from "./params-apply";
import { StoredCopySchema, resolveCopy, type Copy } from "./copy";
import { IdentityUsersSchema, type IdentityUsers } from "./identity-schema";
import {
  PageviewEntrySchema,
  AnonVisitEntrySchema,
  type PageviewEntry,
  type AnonVisitEntry,
} from "./pageviews";

/**
 * Persistence: Neon Postgres in production (Vercel Marketplace add-on), a
 * local JSON file per document during `next dev` when no database is
 * configured. Documents are jsonb rows in `kestrel_docs` (whose `version`
 * column backs the overrides compare-and-set); append-only lists (history,
 * snapshots) are rows in `kestrel_log`, read newest-first by id. Tables are
 * created once by `scripts/init-db.ts`.
 */
type Sql = NeonQueryFunction<false, false>;

function sql(): Sql | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  return neon(url);
}

const NO_DB =
  "No database configured (DATABASE_URL) — cannot persist in production.";

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
    const client = sql();
    if (client) {
      const rows = await client`SELECT doc FROM kestrel_docs WHERE key = ${key}`;
      raw = rows[0]?.doc ?? null;
    } else {
      raw = await devRead(file);
    }
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

// Docs are always written as a JSON string param cast to jsonb: the driver
// would serialize a JS array as a Postgres array, not jsonb, if passed raw.
async function saveDoc(key: string, file: string, doc: unknown): Promise<void> {
  const client = sql();
  if (client) {
    await client`INSERT INTO kestrel_docs (key, doc)
      VALUES (${key}, ${JSON.stringify(doc)}::jsonb)
      ON CONFLICT (key) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`;
  } else if (process.env.NODE_ENV === "development") {
    await devWrite(file, doc);
  } else {
    throw new Error(NO_DB);
  }
}

/** Keep the newest `cap` rows of a list, matching Redis LTRIM semantics. */
async function trimLog(client: Sql, list: string, cap: number): Promise<void> {
  await client`DELETE FROM kestrel_log WHERE list = ${list} AND id < (
    SELECT min(id) FROM (
      SELECT id FROM kestrel_log WHERE list = ${list} ORDER BY id DESC LIMIT ${cap}
    ) keep)`;
}

// ── versioned documents (lost updates return 409) ───────────────────────────
//
// Two documents carry a version: the overrides doc (many editors, debounced
// autosave) and the dataset (inline figure edits and imports). The primitives
// below are shared by both; the dev file fallback keeps the counter in a
// sibling `.ver.json` because there is no version column to read.

export type CasResult =
  | { ok: true; version: number }
  | { ok: false; current: number };

async function loadDocVersion(key: string, verFile: string): Promise<number> {
  try {
    const client = sql();
    let raw: unknown;
    if (client) {
      const rows =
        await client`SELECT version FROM kestrel_docs WHERE key = ${key}`;
      raw = rows[0]?.version ?? 0;
    } else {
      raw = await devRead(verFile);
    }
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch (err) {
    console.error(`[store] failed to load version for ${key}:`, err);
    return 0;
  }
}

/**
 * Compare-and-set save: only writes when the caller's version matches the
 * stored one, otherwise reports the current version so the caller can 409.
 * Each branch is a single atomic statement. The two branches exist because a
 * lone guarded upsert would insert unconditionally when no row exists yet —
 * a stale expectedVersion > 0 must fail against an empty table, not win.
 * The dev file fallback does a plain compare (single-process `next dev`).
 */
async function saveDocCas(
  key: string,
  file: string,
  verFile: string,
  doc: unknown,
  expectedVersion: number
): Promise<CasResult> {
  const client = sql();
  if (client) {
    const payload = JSON.stringify(doc);
    const rows =
      expectedVersion === 0
        ? await client`INSERT INTO kestrel_docs (key, doc, version)
            VALUES (${key}, ${payload}::jsonb, 1)
            ON CONFLICT (key) DO UPDATE
              SET doc = EXCLUDED.doc, version = kestrel_docs.version + 1, updated_at = now()
              WHERE kestrel_docs.version = 0
            RETURNING version`
        : await client`UPDATE kestrel_docs
            SET doc = ${payload}::jsonb, version = version + 1, updated_at = now()
            WHERE key = ${key} AND version = ${expectedVersion}
            RETURNING version`;
    if (rows.length > 0) return { ok: true, version: Number(rows[0].version) };
    // Mismatch. The version reported here is read after the failed write, so
    // it can be newer than the one that caused the failure — equally valid
    // for the caller's 409 payload (the client refreshes to it either way).
    const cur = await client`SELECT version FROM kestrel_docs WHERE key = ${key}`;
    return { ok: false, current: Number(cur[0]?.version ?? 0) };
  }
  if (process.env.NODE_ENV === "development") {
    const current = await loadDocVersion(key, verFile);
    if (current !== expectedVersion) return { ok: false, current };
    await devWrite(file, doc);
    await devWrite(verFile, current + 1);
    return { ok: true, version: current + 1 };
  }
  throw new Error(NO_DB);
}

/**
 * Unconditional write that still bumps the version (snapshot restore, import,
 * and any dataset write), so an editor holding a stale version gets a 409 on
 * their next save rather than silently overwriting.
 */
async function saveDocForce(
  key: string,
  file: string,
  verFile: string,
  doc: unknown
): Promise<number> {
  const client = sql();
  if (client) {
    const rows = await client`INSERT INTO kestrel_docs (key, doc, version)
      VALUES (${key}, ${JSON.stringify(doc)}::jsonb, 1)
      ON CONFLICT (key) DO UPDATE
        SET doc = EXCLUDED.doc, version = kestrel_docs.version + 1, updated_at = now()
      RETURNING version`;
    return Number(rows[0]?.version ?? 0);
  }
  if (process.env.NODE_ENV === "development") {
    const next = (await loadDocVersion(key, verFile)) + 1;
    await devWrite(file, doc);
    await devWrite(verFile, next);
    return next;
  }
  throw new Error(NO_DB);
}

// ── source dataset (employees + caps), edited inline and via /admin/import ───
const DATA_KEY = "kestrel:data:fy26";
const DATA_FILE = "dataset.json";
const DATA_VER_FILE = "dataset.ver.json";

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

export function loadStoredDatasetVersion(): Promise<number> {
  return loadDocVersion(DATA_KEY, DATA_VER_FILE);
}

/**
 * Unconditional dataset write (import, snapshot restore, seed script). Still
 * bumps the version, so an editor with the old roster open 409s on their next
 * inline edit instead of writing against data that has since been replaced.
 */
export function saveStoredDataset(doc: Dataset): Promise<number> {
  return saveDocForce(DATA_KEY, DATA_FILE, DATA_VER_FILE, doc);
}

/** Versioned dataset write, used by the inline figure editor. */
export function saveStoredDatasetCas(
  doc: Dataset,
  expectedVersion: number
): Promise<CasResult> {
  return saveDocCas(DATA_KEY, DATA_FILE, DATA_VER_FILE, doc, expectedVersion);
}

// ── editors' bonus adjustments (versioned) ──────────────────────────────────
const OVERRIDES_KEY = "kestrel:overrides:fy26";
const OVERRIDES_FILE = "overrides.json";
const OVERRIDES_VER_FILE = "overrides.ver.json";

export function loadOverrides(): Promise<Overrides> {
  return loadDoc(OVERRIDES_KEY, OVERRIDES_FILE, OverridesSchema, {});
}

export function loadOverridesVersion(): Promise<number> {
  return loadDocVersion(OVERRIDES_KEY, OVERRIDES_VER_FILE);
}

export function saveOverridesCas(
  doc: Overrides,
  expectedVersion: number
): Promise<CasResult> {
  return saveDocCas(
    OVERRIDES_KEY,
    OVERRIDES_FILE,
    OVERRIDES_VER_FILE,
    doc,
    expectedVersion
  );
}

/** Returns the new version so a caller can hand it back to an open client. */
export function saveOverridesForce(doc: Overrides): Promise<number> {
  return saveDocForce(OVERRIDES_KEY, OVERRIDES_FILE, OVERRIDES_VER_FILE, doc);
}

// ── access-rule overlay (managed from /admin) ────────────────────────────────
const ACCESS_KEY = "kestrel:access:fy26";
const ACCESS_FILE = "access.json";
const AccessOverlaySchema = z.record(z.string(), AccessRuleSchema);
export type AccessOverlay = Record<string, AccessRule>;

export function loadAccessOverlay(): Promise<AccessOverlay> {
  // preprocess so one unparseable rule costs that person their access rather
  // than failing the whole record and silently revoking everybody's
  const Tolerant = z.preprocess(
    dropInvalidRules,
    AccessOverlaySchema
  ) as z.ZodType<AccessOverlay>;
  return loadDoc(ACCESS_KEY, ACCESS_FILE, Tolerant, {});
}

export function saveAccessOverlay(doc: AccessOverlay): Promise<void> {
  return saveDoc(ACCESS_KEY, ACCESS_FILE, doc);
}

// ── scheme-wide parameters (edited on the dashboard's pool cards) ───────────
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

/**
 * Back to "no explicit params stored" — a JSON null in the doc slot, which
 * loadParams reads as its empty value so callers fall back to the dataset's
 * own caps. Restoring a snapshot that predates any stored params needs this:
 * without it, an old restore silently kept today's caps and modifier.
 */
export function clearParams(): Promise<void> {
  return saveDoc(PARAMS_KEY, PARAMS_FILE, null);
}

// ── column presentation config (edited from the dashboard column menu) ──────
const COLUMNS_KEY = "kestrel:columns:fy26";
const COLUMNS_FILE = "columns.json";

export async function loadColumnConfig(): Promise<ColumnConfig> {
  // preprocess so an entry for a retired field costs that one column rather
  // than failing validation and resetting every column setting
  const Tolerant = z.preprocess(
    dropRetiredFields,
    ColumnConfigSchema
  ) as z.ZodType<ColumnConfig>;
  const cfg = await loadDoc<ColumnConfig>(
    COLUMNS_KEY,
    COLUMNS_FILE,
    Tolerant,
    DEFAULT_COLUMNS
  );
  return migrateRenamedLabels(normalizeConfig(cfg));
}

export function saveColumnConfig(cfg: ColumnConfig): Promise<void> {
  return saveDoc(COLUMNS_KEY, COLUMNS_FILE, cfg);
}

/** Back to defaults (see clearParams — same restore-time reasoning). */
export function clearColumnConfig(): Promise<void> {
  return saveDoc(COLUMNS_KEY, COLUMNS_FILE, null);
}

// ── dashboard wording (edited in place on the dashboard) ────────────────────
const COPY_KEY = "kestrel:copy:fy26";
const COPY_FILE = "copy.json";

export async function loadCopy(): Promise<Copy> {
  const stored = await loadDoc<Partial<Copy> | null>(
    COPY_KEY,
    COPY_FILE,
    StoredCopySchema as z.ZodType<Partial<Copy> | null>,
    null
  );
  return resolveCopy(stored);
}

export function saveCopy(copy: Copy): Promise<void> {
  return saveDoc(COPY_KEY, COPY_FILE, copy);
}

/** Back to default wording (see clearParams — same restore-time reasoning). */
export function clearCopy(): Promise<void> {
  return saveDoc(COPY_KEY, COPY_FILE, null);
}

// ── people who have signed in through Texco Identity ────────────────────────
// Not a users table: authorisation stays keyed by email (lib/access.ts). This
// holds only what email can't — the stable m365_id mapping and the session
// epoch. See lib/identity-users.ts.
const IDENTITY_USERS_KEY = "kestrel:identity:users";
const IDENTITY_USERS_FILE = "identity-users.json";

export function loadIdentityUsers(): Promise<IdentityUsers> {
  return loadDoc(IDENTITY_USERS_KEY, IDENTITY_USERS_FILE, IdentityUsersSchema, {});
}

export function saveIdentityUsers(users: IdentityUsers): Promise<void> {
  return saveDoc(IDENTITY_USERS_KEY, IDENTITY_USERS_FILE, users);
}

// ── snapshots (newest first, capped at 50) ───────────────────────────────────
const SNAPSHOTS_KEY = "kestrel:snapshots:fy26";
const SNAPSHOTS_FILE = "snapshots.json";
const SNAPSHOTS_CAP = 50;

export async function pushSnapshot(snapshot: Snapshot): Promise<void> {
  const client = sql();
  if (client) {
    await client`INSERT INTO kestrel_log (list, entry)
      VALUES (${SNAPSHOTS_KEY}, ${JSON.stringify(snapshot)}::jsonb)`;
    await trimLog(client, SNAPSHOTS_KEY, SNAPSHOTS_CAP);
  } else if (process.env.NODE_ENV === "development") {
    const prev = (((await devRead(SNAPSHOTS_FILE)) as Snapshot[]) ?? []);
    await devWrite(SNAPSHOTS_FILE, [snapshot, ...prev].slice(0, SNAPSHOTS_CAP));
  } else {
    throw new Error(NO_DB);
  }
}

export async function loadSnapshots(limit = SNAPSHOTS_CAP): Promise<Snapshot[]> {
  try {
    const client = sql();
    const raw = client
      ? (
          await client`SELECT entry FROM kestrel_log
            WHERE list = ${SNAPSHOTS_KEY} ORDER BY id DESC LIMIT ${limit}`
        ).map((row) => row.entry)
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
    const client = sql();
    if (client) {
      // newest first: insert in reverse so entries[0] gets the highest id
      await client`INSERT INTO kestrel_log (list, entry)
        SELECT ${HISTORY_KEY}, e
        FROM jsonb_array_elements(${JSON.stringify([...entries].reverse())}::jsonb) AS e`;
      await trimLog(client, HISTORY_KEY, HISTORY_CAP);
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
    const client = sql();
    const raw = client
      ? (
          await client`SELECT entry FROM kestrel_log
            WHERE list = ${HISTORY_KEY} ORDER BY id DESC LIMIT ${limit}`
        ).map((row) => row.entry)
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

// ── signed-in page views (append-only, newest first, capped) ────────────────
// Logged from proxy.ts on every real navigation by an authenticated user —
// see lib/pageviews.ts for the entry shape and proxy.ts for what counts as
// "real" (not an API call, not a router prefetch).
const PAGEVIEWS_KEY = "kestrel:pageviews:fy26";
const PAGEVIEWS_FILE = "pageviews.json";
const PAGEVIEWS_CAP = 5000;

/** Never throws — a logging failure must not break the request it describes. */
export async function appendPageview(entry: PageviewEntry): Promise<void> {
  try {
    const client = sql();
    if (client) {
      await client`INSERT INTO kestrel_log (list, entry)
        VALUES (${PAGEVIEWS_KEY}, ${JSON.stringify(entry)}::jsonb)`;
      await trimLog(client, PAGEVIEWS_KEY, PAGEVIEWS_CAP);
    } else if (process.env.NODE_ENV === "development") {
      const prev = ((await devRead(PAGEVIEWS_FILE)) as PageviewEntry[]) ?? [];
      await devWrite(PAGEVIEWS_FILE, [entry, ...prev].slice(0, PAGEVIEWS_CAP));
    }
  } catch (err) {
    console.error("[store] failed to append pageview:", err);
  }
}

export async function loadPageviews(limit = 500): Promise<PageviewEntry[]> {
  try {
    const client = sql();
    const raw = client
      ? (
          await client`SELECT entry FROM kestrel_log
            WHERE list = ${PAGEVIEWS_KEY} ORDER BY id DESC LIMIT ${limit}`
        ).map((row) => row.entry)
      : (((await devRead(PAGEVIEWS_FILE)) as unknown[]) ?? []).slice(0, limit);
    return raw
      .map((item) => {
        const obj = typeof item === "string" ? JSON.parse(item) : item;
        const parsed = PageviewEntrySchema.safeParse(obj);
        return parsed.success ? parsed.data : null;
      })
      .filter((e): e is PageviewEntry => e !== null);
  } catch (err) {
    console.error("[store] failed to load pageviews:", err);
    return [];
  }
}

// ── anonymous visits (append-only, newest first, capped) ────────────────────
// Hits from people who never signed in, to any page other than /login itself
// (that exclusion happens in proxy.ts). Answers "how many random visitors and
// what were they trying to reach" without ever storing a full IP.
const ANON_VISITS_KEY = "kestrel:visits:anon:fy26";
const ANON_VISITS_FILE = "visits-anon.json";
const ANON_VISITS_CAP = 5000;

export async function appendAnonVisit(entry: AnonVisitEntry): Promise<void> {
  try {
    const client = sql();
    if (client) {
      await client`INSERT INTO kestrel_log (list, entry)
        VALUES (${ANON_VISITS_KEY}, ${JSON.stringify(entry)}::jsonb)`;
      await trimLog(client, ANON_VISITS_KEY, ANON_VISITS_CAP);
    } else if (process.env.NODE_ENV === "development") {
      const prev = ((await devRead(ANON_VISITS_FILE)) as AnonVisitEntry[]) ?? [];
      await devWrite(ANON_VISITS_FILE, [entry, ...prev].slice(0, ANON_VISITS_CAP));
    }
  } catch (err) {
    console.error("[store] failed to append anonymous visit:", err);
  }
}

export async function loadAnonVisits(limit = 500): Promise<AnonVisitEntry[]> {
  try {
    const client = sql();
    const raw = client
      ? (
          await client`SELECT entry FROM kestrel_log
            WHERE list = ${ANON_VISITS_KEY} ORDER BY id DESC LIMIT ${limit}`
        ).map((row) => row.entry)
      : (((await devRead(ANON_VISITS_FILE)) as unknown[]) ?? []).slice(0, limit);
    return raw
      .map((item) => {
        const obj = typeof item === "string" ? JSON.parse(item) : item;
        const parsed = AnonVisitEntrySchema.safeParse(obj);
        return parsed.success ? parsed.data : null;
      })
      .filter((e): e is AnonVisitEntry => e !== null);
  } catch (err) {
    console.error("[store] failed to load anonymous visits:", err);
    return [];
  }
}
