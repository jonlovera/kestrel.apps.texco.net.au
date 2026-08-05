import "server-only";
import { getDataset } from "./data";
import { loadOverrides, loadOverridesVersion } from "./store";
import { buildPayloadCore } from "./scope-core";
import type { Scope } from "./access";
import type { DashboardPayload, UserInfo } from "./payload-types";

/**
 * Server wrapper: load the stored docs, then delegate to the pure
 * buildPayloadCore (lib/scope-core.ts) which owns row filtering and the
 * authoritative field-stripping loop.
 */
export async function buildDashboardPayload(
  scope: Scope,
  user: UserInfo
): Promise<DashboardPayload> {
  const [data, overrides, overridesVersion] = await Promise.all([
    getDataset(),
    loadOverrides(),
    loadOverridesVersion(),
  ]);
  return buildPayloadCore(data, overrides, scope, user, overridesVersion);
}
