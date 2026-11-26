/**
 * The contract both ends of dashboard-tab sync (#11141) agree on: the stored
 * per-tab record, the tab id and name rules, and the per-account caps.
 *
 * The server validates against this (convex/lib/dashboardTabRecord.ts); the
 * browser captures and applies it (src/services/tab-sync-merge.ts).
 */

/** Matches the dashboard tab rename input (`maxLength` on the visible control). */
export const DASHBOARD_TAB_NAME_MAX_LENGTH = 40;

/**
 * Stable tab IDs from `generateTabId()`. `Date.now().toString(36)` and the
 * random suffix are lowercase base36.
 */
export const DASHBOARD_TAB_ID_PATTERN = '^tab-[a-z0-9]+-[a-z0-9]+$';

/** Live tabs one account may store per variant. */
export const MAX_SYNCED_DASHBOARD_TABS = 50;
/** Delete markers kept per account and variant; the oldest is evicted past this. */
export const MAX_DASHBOARD_TAB_TOMBSTONES = 100;
/** Changes one sync call may carry. */
export const MAX_DASHBOARD_TAB_CHANGES_PER_CALL = 60;

/** One panel in a synced tab: grid order is array order. */
export interface DashboardTabRecordPanel {
  key: string;
  on: boolean;
  bottom?: boolean;
}

/**
 * A dashboard tab as the server stores it. Panel display names, font scale and
 * priority are device-local and deliberately absent.
 */
export interface DashboardTabRecord {
  name: string;
  panels: DashboardTabRecordPanel[];
  scope?: { countries: string[]; neighbours?: boolean; start?: string; end?: string };
  panelFilters?: Array<{ key: string; value: string }>;
  team?: { id: string; version: number };
}

/** One stored row as `listDashboardTabs` returns it. */
export interface DashboardTabRow {
  tabId: string;
  version: number;
  deleted: boolean;
  record?: DashboardTabRecord;
  createdAt: number;
  updatedAt: number;
}

/** One change in a `syncDashboardTabs` call. `record: null` deletes the tab. */
export interface DashboardTabChange {
  tabId: string;
  baseVersion?: number;
  record: DashboardTabRecord | null;
}

export type DashboardTabChangeResult =
  | { tabId: string; ok: true; version: number }
  | { tabId: string; ok: false; reason: 'CONFLICT'; row: DashboardTabRow | null }
  | { tabId: string; ok: false; reason: 'TAB_LIMIT'; limit: number };

export type SyncDashboardTabsResult =
  | { ok: true; results: DashboardTabChangeResult[] }
  | { ok: false; reason: 'WRONG_ACCOUNT' }
  | { ok: false; reason: 'RATE_LIMITED'; limit: number; reset: number };
