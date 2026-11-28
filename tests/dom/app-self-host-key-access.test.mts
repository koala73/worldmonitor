/**
 * A self-host desktop-key verdict that lands after boot must re-run the free
 * panel cap and premium panel gating without a reload (plan 2026-11-04-001,
 * U5). Both re-evaluate on auth and entitlement changes; the verdict reaches
 * them through `subscribeWidgetAccess`, which App and PanelLayoutManager must
 * therefore observe too.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services')>()),
  openStorageForBoot: vi.fn(async () => true),
}));
vi.mock('@/services/wm-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/wm-session')>()),
  ensureWmSession: vi.fn(async () => true),
  installWmSessionFetchInterceptor: vi.fn(),
}));
vi.mock('@/services/bootstrap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/bootstrap')>()),
  fetchBootstrapData: vi.fn(async () => undefined),
}));
vi.mock('@/services/auth-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/auth-state')>()),
  initAuthState: vi.fn(async () => undefined),
}));
vi.mock('@/services/sign-up-resume', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/sign-up-resume')>()),
  installSignUpResume: vi.fn(),
}));
vi.mock('@/utils/cloud-prefs-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/cloud-prefs-sync')>()),
  install: vi.fn(),
}));
vi.mock('@/services/followed-countries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/followed-countries')>()),
  installFollowedCountriesAuthListener: vi.fn(),
}));

import { App } from '@/App';
import { PanelLayoutManager } from '@/app/panel-layout';
import { DataLoaderManager } from '@/app/data-loader';
import {
  _resetSelfHostKeyForTests,
  refreshSelfHostKey,
} from '@/services/self-host-key';

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

function verdictFetch(status: string): typeof fetch {
  return (async () => new Response(
    JSON.stringify({ enabled: true, status, stale: false, verifiedAt: NOW }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )) as typeof fetch;
}

/** Point the verdict service at a scripted route and deliver one verdict. */
async function deliverVerdict(status: string): Promise<void> {
  _resetSelfHostKeyForTests({
    fetch: verdictFetch(status),
    now: () => NOW,
    setInterval: () => 1,
    clearInterval: () => {},
    canRun: () => true,
  });
  await refreshSelfHostKey();
}

afterEach(() => {
  _resetSelfHostKeyForTests({ canRun: () => false });
  document.body.replaceChildren();
});

describe('self-host key verdict after boot', () => {
  it('App re-runs the free-tier reconcile and the premium loaders, and destroy unsubscribes', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network disabled in test'));
    // Boot reads no verdict: the service stays quiet until the test drives it.
    _resetSelfHostKeyForTests({ canRun: () => false });
    const container = document.createElement('div');
    container.id = 'app';
    document.body.appendChild(container);
    const app = new App('app');

    const reconcile = vi.spyOn(
      App.prototype as unknown as { reconcileTierOwnedPreferences: () => boolean },
      'reconcileTierOwnedPreferences',
    ).mockReturnValue(true);
    vi.spyOn(
      App.prototype as unknown as { enforceFreeTierLimits: () => boolean },
      'enforceFreeTierLimits',
    ).mockReturnValue(false);
    vi.spyOn(
      App.prototype as unknown as { connectCorrelationAssessments: () => void },
      'connectCorrelationAssessments',
    ).mockImplementation(() => {});
    const loaderNames = Object.getOwnPropertyNames(DataLoaderManager.prototype)
      .filter((name) => /^(load|clear)[A-Z]/.test(name));
    const loaders = Object.fromEntries(loaderNames.map((name) => [
      name,
      vi.spyOn(DataLoaderManager.prototype as unknown as Record<string, () => unknown>, name)
        .mockImplementation(() => undefined),
    ]));

    // Stop init right after the access subscriptions are registered.
    const stop = new Error('stop before layout');
    vi.spyOn(PanelLayoutManager.prototype, 'init').mockImplementation(async () => { throw stop; });
    await expect(app.init(null)).rejects.toBe(stop);

    reconcile.mockClear();
    await deliverVerdict('active');
    expect(reconcile).toHaveBeenCalled();
    expect(loaders.loadTradePolicy).toHaveBeenCalledTimes(1);

    reconcile.mockClear();
    await deliverVerdict('invalid');
    expect(reconcile).toHaveBeenCalled();
    expect(loaders.clearGlobalTenders).toHaveBeenCalled();

    app.destroy();
    reconcile.mockClear();
    await deliverVerdict('active');
    expect(reconcile, 'destroy removes the subscription').not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('PanelLayoutManager re-runs premium panel gating on a verdict change', async () => {
    _resetSelfHostKeyForTests({ canRun: () => false });
    const container = document.createElement('div');
    const layout = Object.create(PanelLayoutManager.prototype) as PanelLayoutManager;
    Reflect.set(layout, 'ctx', { container, panels: {}, isDestroyed: false, isDesktopApp: false });
    Reflect.set(layout, 'proActivationController', { init() {}, destroy() {} });
    Reflect.set(layout, 'passkeyOfferController', { init() {}, destroy() {} });
    vi.spyOn(
      PanelLayoutManager.prototype as unknown as { renderLayout: () => Promise<void> },
      'renderLayout',
    ).mockResolvedValue(undefined);
    vi.spyOn(
      PanelLayoutManager.prototype as unknown as { reconcileCheckoutReturnFocus: () => Promise<void> },
      'reconcileCheckoutReturnFocus',
    ).mockResolvedValue(undefined);
    const gating = vi.spyOn(
      PanelLayoutManager.prototype as unknown as { updatePanelGating: () => void },
      'updatePanelGating',
    ).mockImplementation(() => {});

    await layout.init();
    gating.mockClear();
    await deliverVerdict('active');
    expect(gating).toHaveBeenCalledTimes(1);

    const unsubscribe = Reflect.get(layout, 'unsubscribeWidgetAccess') as (() => void) | null;
    expect(typeof unsubscribe).toBe('function');
    unsubscribe?.();
    gating.mockClear();
    await deliverVerdict('invalid');
    expect(gating).not.toHaveBeenCalled();
  });
});
