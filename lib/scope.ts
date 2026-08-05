import "server-only";
import { getDataset } from "./data";
import { loadOverrides } from "./store";
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
  const data = await getDataset();
  const overrides = await loadOverrides();
  return buildPayloadCore(data, overrides, scope, user);
}
