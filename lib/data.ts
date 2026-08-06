import "server-only";
import { DatasetSchema, type Dataset } from "./schema";
import { loadStoredDataset, loadParams } from "./store";
import { applyParams, defaultParams, type Params } from "./params-apply";

/**
 * The source dataset (155 employees + pool caps). The raw file holds real
 * salary packages, so it is NOT in git and NOT bundled. Resolution order:
 *
 *  1. database doc `kestrel:data:fy26` (written by /admin/import and the seed
 *     script; dev fallback `.data/dataset.json`)
 *  2. `BONUS_DATA` env var — base64-encoded JSON of the same shape (lets
 *     production serve data even if the database is unavailable)
 *  3. local `data/bonus.json` (developer machines only; gitignored)
 *
 * No module-level cache: admin imports must be visible on the next request.
 */
export async function getDataset(): Promise<Dataset> {
  const stored = await loadStoredDataset();
  if (stored) return stored;

  const envBlob = process.env.BONUS_DATA;
  if (envBlob) {
    try {
      let bytes = Buffer.from(envBlob, "base64");
      // gzip magic bytes: the blob may be base64(gzip(json)) to fit within
      // Vercel's 64 KB env-var budget
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        const { gunzipSync } = await import("node:zlib");
        bytes = gunzipSync(bytes);
      }
      return DatasetSchema.parse(JSON.parse(bytes.toString("utf-8")));
    } catch (err) {
      console.error("[data] BONUS_DATA env var invalid, trying next source:", err);
    }
  }

  try {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    return DatasetSchema.parse(
      JSON.parse(readFileSync(join(process.cwd(), "data", "bonus.json"), "utf-8"))
    );
  } catch {
    throw new Error(
      "No source data available: database empty, BONUS_DATA unset, and no local data/bonus.json. " +
        "Seed the store (scripts/seed-store.ts) or set BONUS_DATA."
    );
  }
}

/** The stored params, or defaults derived from the dataset's own caps. */
export async function getParams(): Promise<Params> {
  const [stored, data] = await Promise.all([loadParams(), getDataset()]);
  return stored ?? defaultParams(data);
}

/**
 * The dataset as the calc engine should see it: scheme parameters applied
 * (caps replaced, company modifier folded into the bipm input). This is
 * what every server-side calculation path consumes.
 */
export async function getEffectiveDataset(): Promise<Dataset> {
  const [data, params] = await Promise.all([getDataset(), loadParams()]);
  return applyParams(data, params ?? defaultParams(data));
}
