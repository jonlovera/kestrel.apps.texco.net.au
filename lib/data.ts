import "server-only";
import rawData from "@/data/bonus.json";
import { BonusDataSchema, type BonusData } from "./schema";

/**
 * The bonus dataset. Imported as a module (bundled server-side only — the
 * 'server-only' marker makes any client import a build error) and validated
 * once at startup.
 */
let cached: BonusData | null = null;

export function getBonusData(): BonusData {
  if (!cached) cached = BonusDataSchema.parse(rawData);
  return cached;
}
