/**
 * Decision layer for dashboard-tab WebMCP tools.
 *
 * PanelLayoutManager still owns live snapshots, persistence, and the visible
 * tab bar. This module answers whether a list/select/create/rename/delete
 * request is allowed and what the caller should apply, so agents and the UI
 * share the same name limits, last-tab guard, and stable denial reasons.
 */

import type { ExportGateLockReason, TabCapVerdict } from './gates/export-resolver';
import {
  DASHBOARD_TAB_NAME_MAX_LENGTH,
  isDashboardTabId,
  type PanelTab,
  type TabsState,
} from './tab-store';

export {
  DASHBOARD_TAB_ID_PATTERN,
  DASHBOARD_TAB_ID_RE,
  DASHBOARD_TAB_NAME_MAX_LENGTH,
  isDashboardTabId,
} from './tab-store';

export type DashboardTabActionType = 'list' | 'select' | 'create' | 'rename' | 'delete';

export type DashboardTabDenialReason =
  | 'malformed_arguments'
  | 'invalid_name'
  | 'tab_not_found'
  | 'tab_cap'
  | 'last_tab'
  | 'confirmation_required'
  | 'tabs_unavailable'
  | 'persist_failed'
  | 'app_destroyed';

export type DashboardTabAction =
  | { type: 'list'; cursor?: string }
  | { type: 'select'; tabId: string }
  | { type: 'create'; name?: string }
  | { type: 'rename'; tabId: string; name: string }
  | { type: 'delete'; tabId: string; confirm: boolean };

export interface DashboardTabDescriptor {
  id: string;
  name: string;
  active: boolean;
  canDelete: boolean;
}

export interface DashboardTabListSnapshot {
  activeTabId: string;
  tabs: DashboardTabDescriptor[];
  tabCount: number;
  tabsTruncated: boolean;
  /** Inclusive start tab id for the next page when `tabsTruncated` is true. */
  nextCursor?: string;
  canCreate: boolean;
  cap: number | null;
  createBlockReason?: ExportGateLockReason;
}

export interface DashboardTabMutationResult {
  ok: boolean;
  status: 'applied' | 'denied' | 'invalid';
  actionType: Exclude<DashboardTabActionType, 'list'> | 'list';
  reason?: DashboardTabDenialReason;
  message: string;
  tabId?: string;
  name?: string;
  activeTabId?: string;
  unchanged?: boolean;
  alreadyExisted?: boolean;
  persisted?: boolean;
  tabCount?: number;
  canCreate?: boolean;
  cap?: number | null;
  lockReason?: ExportGateLockReason;
}

export type DashboardTabActionResult = DashboardTabListSnapshot | DashboardTabMutationResult;

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

function tabCapDenial(cap: Extract<TabCapVerdict, { allowed: false }>): {
  ok: false;
  reason: DashboardTabDenialReason;
  message: string;
  lockReason: ExportGateLockReason;
} {
  return {
    ok: false,
    reason: 'tab_cap',
    message: 'Dashboard tab limit reached for this account.',
    lockReason: cap.reason,
  };
}

export const DASHBOARD_TAB_UNAVAILABLE_RESULT: DashboardTabMutationResult = {
  ok: false,
  status: 'denied',
  actionType: 'list',
  reason: 'tabs_unavailable',
  message: 'Dashboard tabs are not available.',
};

export function isDashboardTabListSnapshot(
  value: DashboardTabActionResult,
): value is DashboardTabListSnapshot {
  return 'tabs' in value && Array.isArray(value.tabs) && !('actionType' in value);
}

export function normalizeDashboardTabName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.length > DASHBOARD_TAB_NAME_MAX_LENGTH || CONTROL_CHARS.test(name)) {
    return null;
  }
  return name;
}

export function describeDashboardTabs(
  state: TabsState,
  cap: TabCapVerdict,
): DashboardTabListSnapshot {
  const canDelete = state.tabs.length > 1;
  const tabs = state.tabs.map((tab) => ({
    id: tab.id,
    name: tab.name,
    active: tab.id === state.activeTabId,
    canDelete,
  }));
  const snapshot: DashboardTabListSnapshot = {
    activeTabId: state.activeTabId,
    tabs,
    tabCount: tabs.length,
    tabsTruncated: false,
    canCreate: cap.allowed,
    cap: cap.cap,
  };
  if (!cap.allowed) snapshot.createBlockReason = cap.reason;
  return snapshot;
}

export function resolveSelectDashboardTab(
  state: TabsState,
  tabId: unknown,
):
  | { ok: true; unchanged: boolean; tab: PanelTab }
  | { ok: false; reason: DashboardTabDenialReason; message: string } {
  if (!isDashboardTabId(tabId)) {
    return {
      ok: false,
      reason: 'malformed_arguments',
      message: 'tabId must be a stable dashboard tab ID.',
    };
  }
  const tab = state.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) {
    return { ok: false, reason: 'tab_not_found', message: 'That dashboard tab is not available.' };
  }
  return { ok: true, unchanged: tab.id === state.activeTabId, tab };
}

export function resolveCreateDashboardTab(
  state: TabsState,
  cap: TabCapVerdict,
  requestedName: unknown,
):
  | { ok: true; unchanged: boolean; alreadyExisted: true; tab: PanelTab }
  | { ok: true; unchanged: false; name: string }
  | { ok: false; reason: DashboardTabDenialReason; message: string; lockReason?: ExportGateLockReason } {
  if (requestedName !== undefined) {
    const name = normalizeDashboardTabName(requestedName);
    if (!name) {
      return {
        ok: false,
        reason: 'invalid_name',
        message: `Tab names must be 1–${DASHBOARD_TAB_NAME_MAX_LENGTH} visible characters.`,
      };
    }
    const existing = state.tabs.find((tab) => tab.name === name);
    if (existing) {
      return {
        ok: true,
        unchanged: existing.id === state.activeTabId,
        alreadyExisted: true,
        tab: existing,
      };
    }
    if (!cap.allowed) {
      return tabCapDenial(cap);
    }
    return { ok: true, unchanged: false, name };
  }
  if (!cap.allowed) {
    return tabCapDenial(cap);
  }
  return { ok: true, unchanged: false, name: '' };
}

export function resolveRenameDashboardTab(
  state: TabsState,
  tabId: unknown,
  requestedName: unknown,
):
  | { ok: true; unchanged: boolean; tab: PanelTab; name: string }
  | { ok: false; reason: DashboardTabDenialReason; message: string } {
  if (!isDashboardTabId(tabId)) {
    return {
      ok: false,
      reason: 'malformed_arguments',
      message: 'tabId must be a stable dashboard tab ID.',
    };
  }
  const name = normalizeDashboardTabName(requestedName);
  if (!name) {
    return {
      ok: false,
      reason: 'invalid_name',
      message: `Tab names must be 1–${DASHBOARD_TAB_NAME_MAX_LENGTH} visible characters.`,
    };
  }
  const tab = state.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) {
    return { ok: false, reason: 'tab_not_found', message: 'That dashboard tab is not available.' };
  }
  return { ok: true, unchanged: tab.name === name, tab, name };
}

export function resolveDeleteDashboardTab(
  state: TabsState,
  tabId: unknown,
  confirm: unknown,
):
  | { ok: true; tab: PanelTab; wasActive: boolean; index: number; fallbackId: string }
  | { ok: false; reason: DashboardTabDenialReason; message: string } {
  if (confirm !== true) {
    return {
      ok: false,
      reason: 'confirmation_required',
      message: 'Deleting a dashboard tab requires confirm=true.',
    };
  }
  if (!isDashboardTabId(tabId)) {
    return {
      ok: false,
      reason: 'malformed_arguments',
      message: 'tabId must be a stable dashboard tab ID.',
    };
  }
  if (state.tabs.length <= 1) {
    return {
      ok: false,
      reason: 'last_tab',
      message: 'The last required dashboard tab cannot be deleted.',
    };
  }
  const index = state.tabs.findIndex((candidate) => candidate.id === tabId);
  if (index === -1) {
    return { ok: false, reason: 'tab_not_found', message: 'That dashboard tab is not available.' };
  }
  const tab = state.tabs[index]!;
  const fallback = state.tabs[index === 0 ? 1 : index - 1]!;
  return {
    ok: true,
    tab,
    wasActive: state.activeTabId === tab.id,
    index,
    fallbackId: fallback.id,
  };
}

export function mutationDenied(
  actionType: DashboardTabMutationResult['actionType'],
  reason: DashboardTabDenialReason,
  message: string,
  extra: Partial<DashboardTabMutationResult> = {},
): DashboardTabMutationResult {
  return {
    ok: false,
    status: reason === 'malformed_arguments' || reason === 'invalid_name' ? 'invalid' : 'denied',
    actionType,
    reason,
    message,
    ...extra,
  };
}

export function mutationApplied(
  actionType: Exclude<DashboardTabActionType, 'list'>,
  fields: Omit<DashboardTabMutationResult, 'ok' | 'status' | 'actionType'>,
): DashboardTabMutationResult {
  return {
    ok: true,
    status: 'applied',
    actionType,
    persisted: true,
    ...fields,
  };
}

export const TABS_PERSIST_FAILED_MESSAGE = 'Dashboard tab change could not be saved.';

export function applyPersistReceipt(
  receipt: { persisted: boolean },
  applied: DashboardTabMutationResult,
): DashboardTabMutationResult {
  if (receipt.persisted) {
    return { ...applied, persisted: true };
  }
  return {
    ...applied,
    ok: false,
    status: 'denied',
    reason: 'persist_failed',
    persisted: false,
    message: TABS_PERSIST_FAILED_MESSAGE,
  };
}
