/**
 * Types for the data that crosses the server → client boundary.
 * Types only — no runtime code, safe to import anywhere.
 */
import type { Employee, Overrides } from "./schema";
import type { NumericField } from "./access-types";

export interface UserInfo {
  name: string;
  email: string;
  /** human-readable scope label shown in the header */
  scopeLabel: string;
}

/** One row as a read-only user receives it: only permitted fields present. */
export interface ScopedRow {
  id: string;
  name: string;
  st: "VIC" | "NSW" | "SHARED";
  pos: string;
  dept: string;
  mgr: string;
  cat: string;
  sm: 0 | 1;
  locked: boolean;
  /** whether the row participates in any pool (drives the DA '—' rendering) */
  inPool: boolean;
  pkg?: number;
  bp?: number;
  ipm?: number;
  bipm?: number;
  calc?: number;
  f25?: number;
  da?: number;
  yoy?: number;
  final?: number;
}

export interface StatePoolCard {
  title: string;
  stateBonuses: number;
  utilPct: number;
  scale: number;
  scaleLabel: string;
}

export interface ReadonlyPayload {
  mode: "readonly";
  user: UserInfo;
  rows: ScopedRow[];
  visibleFields: NumericField[];
  showStateColumn: boolean;
  poolCards: StatePoolCard[];
  cats: string[];
  depts: string[];
  mgrs: string[];
}

export interface EditorPayload {
  mode: "editor";
  user: UserInfo;
  employees: Employee[];
  overrides: Overrides;
  /** optimistic-concurrency token; saves carrying a stale value get 409 */
  overridesVersion: number;
  caps: { vCap: number; nCap: number; gCap: number };
  cats: string[];
  depts: string[];
  mgrs: string[];
}

export type DashboardPayload = ReadonlyPayload | EditorPayload;
