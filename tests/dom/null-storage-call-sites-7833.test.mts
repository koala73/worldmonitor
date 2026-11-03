/**
 * #7833 — call sites that still crash on a NULL `localStorage`.
 *
 * Android WebView with DOM storage disabled exposes `window.localStorage` as
 * `null`, so an unguarded `localStorage.getItem(…)` is a TypeError rather than
 * a thrown SecurityError. #7832 fixed the sites with production evidence
 * (`WORLDMONITOR-122`); these are the ones a survey found afterwards, including
 * two that LOOK guarded and are not:
 *
 *   - `cloud-prefs-sync.applyCloudBlob` wraps its storage writes in
 *     `try { … } finally { … }`. A `finally` restores the patch-suppression
 *     flag but catches nothing, so the TypeError still propagates.
 *   - `persistent-cache.deleteFromLocalStorageByPrefix` opens with
 *     `if (typeof localStorage === 'undefined') return;`. `typeof null` is
 *     `'object'`, so that gate never fires for the null shape.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Android WebView with DOM storage disabled: the property itself is null. */
function stubNullStorage(): void {
  vi.stubGlobal('localStorage', null);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('cloud-prefs-sync under a null localStorage', () => {
  beforeEach(() => {
    // `ENABLED` is captured from import.meta.env at module load, so the stub
    // has to be in place before the dynamic import below.
    vi.stubEnv('VITE_CLOUD_PREFS_ENABLED', 'true');
  });

  it('reads sync metadata without throwing', async () => {
    const sync = await import('@/utils/cloud-prefs-sync');
    stubNullStorage();

    expect(sync.getSyncVersion()).toBe(0);
    expect(sync.getSyncState()).toBe('signed-out');
    expect(sync.getLastSyncAt()).toBe(0);
  });

  it('reconciles a sign-in without throwing (boot-path ownership sidecars)', async () => {
    const sync = await import('@/utils/cloud-prefs-sync');
    expect(sync.isCloudSyncEnabled()).toBe(true);
    stubNullStorage();

    // onSignIn does its ownership-sidecar reconciliation synchronously before
    // returning the async attempt; the throw we care about is the sync one.
    expect(() => { void sync.onSignIn('user-1', 'full').catch(() => {}); }).not.toThrow();
  });

  it('clears sync metadata on sign-out without throwing', async () => {
    const sync = await import('@/utils/cloud-prefs-sync');
    stubNullStorage();

    expect(() => sync.onSignOut()).not.toThrow();
  });
});

describe('settings export under a null localStorage', () => {
  // NOT "returns an empty export". The caller does
  // `try { exportSettings(); showToast(exportSuccess) } catch { showToast(exportFailed) }`,
  // so returning quietly turns an unreadable store into a green "Exported"
  // toast over a file containing nothing. Failing is the correct outcome; what
  // #7833 owes this path is a legible failure, not a silent one.
  it('fails loudly rather than handing back an empty backup', async () => {
    const { exportSettings } = await import('@/utils/settings-persistence');
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stub');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    stubNullStorage();

    expect(() => exportSettings()).toThrow(/storage/i);
    // The decisive assertion: no file was ever produced, so nothing downstream
    // can mistake this for a successful backup.
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('still exports normally when storage works', async () => {
    const { exportSettings } = await import('@/utils/settings-persistence');
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stub');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    localStorage.setItem('worldmonitor-variant', 'full');
    localStorage.setItem('positive-threshold', '7');
    localStorage.setItem('wm-pinned-webcams', '[null,{}]');

    expect(() => exportSettings()).not.toThrow();
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    const exported = JSON.parse(await blob.text());
    expect(exported.variant).toBe('full');
    expect(exported.data['positive-threshold']).toBe('7');
    expect(exported.data['wm-pinned-webcams']).toBe('[]');
  });
});

describe('persistent-cache prefix invalidation under a null localStorage', () => {
  it('returns without throwing instead of falling through the undefined-only gate', async () => {
    const { __testing__ } = await import('@/services/persistent-cache');
    stubNullStorage();

    expect(() => __testing__.deleteFromLocalStorageByPrefix('news')).not.toThrow();
  });
});

describe('custom widgets under a null localStorage', () => {
  it('degrades the whole load chain to an empty list rather than throwing', async () => {
    // NOTE what this does and does not prove. `loadFromStorage` already
    // catches, so `materializeWidgets` never reaches its PRO side-key read on
    // a broken store — routing that read through safeStorageGet was defence in
    // depth and a guard requirement, NOT a live crash fix. What this pins is
    // the chain-level resilience the module documents ("degrades those failures
    // to [] for dashboard resilience"), which nothing else asserted.
    stubNullStorage();

    const { loadWidgets } = await import('@/services/widget-store');

    expect(() => loadWidgets()).not.toThrow();
    expect(loadWidgets()).toEqual([]);
  });
});
