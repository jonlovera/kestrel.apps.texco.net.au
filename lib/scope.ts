import "server-only";
import { getEffectiveDataset, getParams } from "./data";
import {
  loadOverrides,
  loadOverridesVersion,
  loadStoredDatasetVersion,
  loadColumnConfig,
  loadCopy,
} from "./store";
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
  const [
    data,
    params,
    overrides,
    overridesVersion,
    datasetVersion,
    columnConfig,
    copy,
  ] = await Promise.all([
    getEffectiveDataset(),
    getParams(),
    loadOverrides(),
    loadOverridesVersion(),
    loadStoredDatasetVersion(),
    loadColumnConfig(),
    loadCopy(),
  ]);
  return buildPayloadCore(data, overrides, scope, user, {
    overridesVersion,
    datasetVersion,
    companyModifier: params.companyModifier,
    columnConfig,
    copy,
  });
}
