import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils', () => ({ rssProxyUrl: (url: string) => url }));
vi.mock('@/services/runtime', () => ({ isDesktopRuntime: () => false }));
vi.mock('@/services/runtime-config', () => ({ getSecretState: () => ({ present: false }) }));
vi.mock('@/services/entitlements', () => ({ isEntitled: () => false }));

describe('self-hosted source policy', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('preserves hosted source defaults and the free source limit', async () => {
    vi.stubEnv('VITE_SELF_HOSTED', '0');
    const { FREE_MAX_SOURCES } = await import('@/config/panels');
    const { computeDefaultDisabledSources } = await import('@/config/feeds');
    expect(FREE_MAX_SOURCES).toBe(80);
    expect(computeDefaultDisabledSources().length).toBeGreaterThan(0);
  });

  it('enables public feeds without applying the hosted count limit locally', async () => {
    vi.stubEnv('VITE_SELF_HOSTED', '1');
    const { FREE_MAX_SOURCES, isPanelEntitled } = await import('@/config/panels');
    const { computeDefaultDisabledSources } = await import('@/config/feeds');
    expect(FREE_MAX_SOURCES).toBe(Number.MAX_SAFE_INTEGER);
    expect(computeDefaultDisabledSources()).toEqual([]);
    expect(isPanelEntitled('stock-analysis', { name: 'Stock analysis', enabled: true, priority: 1, premium: true })).toBe(false);
  });
});
