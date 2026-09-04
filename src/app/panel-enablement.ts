import type { PanelConfig } from '@/types';
import { getEffectivePanelConfig, userSetPanelEnabled } from '@/config/panels';
import {
  evaluateSetPanelEnabled,
  type SetPanelEnabledResult,
} from '@/config/panel-enablement';

/** Matches SearchSelectionDispatcher's deferred-panel presentation wait. */
export const PANEL_LIVE_WAIT_TIMEOUT_MS = 30_000;

export interface SetPanelEnabledContext {
  panelSettings: Record<string, PanelConfig>;
  panels?: Record<string, unknown>;
  unifiedSettings?: { refreshPanelToggles?: () => void } | null;
}

export interface SetPanelEnabledDeps {
  variant: string;
  isPro: boolean;
  persist: (settings: Record<string, PanelConfig>) => boolean | void;
  applyPanelSettings: () => void;
  trackToggle: (panelId: string, enabled: boolean) => void;
  showCapToast?: () => void;
  isPanelAllowed?: (panelId: string, config: PanelConfig) => boolean;
}

/**
 * Apply a user-equivalent panel enable/disable. Policy stays in
 * `evaluateSetPanelEnabled`; this helper only persists when that decision
 * says the visible settings store must change.
 */
export function applySetPanelEnabled(
  ctx: SetPanelEnabledContext,
  panelId: unknown,
  enabled: unknown,
  deps: SetPanelEnabledDeps,
): SetPanelEnabledResult {
  const decision = evaluateSetPanelEnabled({
    panelId,
    enabled,
    panelSettings: ctx.panelSettings,
    variant: deps.variant,
    isPro: deps.isPro,
    isPanelAllowed: deps.isPanelAllowed,
  });

  if (!decision.ok) {
    if (decision.reason === 'panel_cap_exceeded') deps.showCapToast?.();
    return decision;
  }
  if (!decision.changed || typeof panelId !== 'string' || typeof enabled !== 'boolean') {
    return decision;
  }

  const currentConfig = ctx.panelSettings[panelId];
  const nextConfig = currentConfig
    ? { ...currentConfig }
    : { ...getEffectivePanelConfig(panelId, deps.variant), enabled: false };
  userSetPanelEnabled(nextConfig, enabled);
  const nextSettings = { ...ctx.panelSettings, [panelId]: nextConfig };
  if (deps.persist(nextSettings) === false) {
    return {
      ok: false,
      status: 'denied',
      panelId,
      requestedEnabled: enabled,
      effectiveEnabled: currentConfig?.enabled === true,
      changed: false,
      reason: 'persist_failed',
      message: 'Dashboard panel change could not be saved.',
    };
  }
  ctx.panelSettings[panelId] = nextConfig;
  deps.trackToggle(panelId, enabled);
  deps.applyPanelSettings();
  ctx.unifiedSettings?.refreshPanelToggles?.();
  if (enabled) {
    const panel = ctx.panels?.[panelId];
    if (
      panel
      && typeof panel === 'object'
      && 'fetchData' in panel
      && typeof (panel as { fetchData: unknown }).fetchData === 'function'
    ) {
      try {
        void Promise.resolve((panel as { fetchData: () => unknown }).fetchData()).catch(() => {});
      } catch {
        // Persist already committed; a data refresh must not fail the tool.
      }
    }
  }
  return decision;
}

export function isCatalogPanelLive(
  panelId: string,
  panels?: Record<string, unknown> | null,
): boolean {
  const instance = panels?.[panelId] as { getElement?: () => { isConnected?: boolean } | null } | undefined;
  // Registry presence is not enough: deferred load can assign ctx.panels[id]
  // before mountPanelElement() connects the node. open_dashboard_panel then
  // calls show() on a disconnected element.
  if (instance?.getElement?.()?.isConnected === true) return true;
  if (typeof document === 'undefined') return false;
  const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(panelId)
    : panelId.replace(/["\\]/g, '\\$&');
  const node = document.querySelector(`[data-panel="${escaped}"]:not([data-deferred-panel])`);
  return Boolean(node?.isConnected);
}

function observeDocumentMutations(onChange: () => void): () => void {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') {
    return () => {};
  }
  const root = document.body ?? document.documentElement;
  if (!root) return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}

/**
 * Wait until a just-enabled catalog panel is addressable by `open_dashboard_panel`.
 * Timeout still resolves so a successful persist is not rewritten as a denial.
 */
export async function waitUntilPanelLive(options: {
  isLive: () => boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  observe?: (onChange: () => void) => () => void;
}): Promise<'live' | 'timeout'> {
  const signal = options.signal;
  if (signal?.aborted) {
    signal.throwIfAborted();
    throw new DOMException('Tool execution was aborted.', 'AbortError');
  }
  if (options.isLive()) return 'live';

  const timeoutMs = options.timeoutMs ?? PANEL_LIVE_WAIT_TIMEOUT_MS;
  const startObserve = options.observe ?? observeDocumentMutations;

  return new Promise<'live' | 'timeout'>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop = (): void => {};
    const finish = (outcome: 'live' | 'timeout'): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', handleAbort);
      stop();
      resolve(outcome);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', handleAbort);
      stop();
      reject(error);
    };
    const handleAbort = (): void => {
      try {
        if (!signal?.aborted) return;
        signal.throwIfAborted();
        fail(new DOMException('Tool execution was aborted.', 'AbortError'));
      } catch (error) {
        fail(error);
      }
    };
    const check = (): void => {
      if (options.isLive()) finish('live');
    };
    stop = startObserve(check);
    signal?.addEventListener('abort', handleAbort, { once: true });
    timer = setTimeout(() => finish(options.isLive() ? 'live' : 'timeout'), timeoutMs);
    check();
    if (signal?.aborted) handleAbort();
  });
}
