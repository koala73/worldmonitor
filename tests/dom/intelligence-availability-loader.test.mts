import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchSecurityAdvisories: vi.fn(),
  fetchSatelliteTLEs: vi.fn(),
}));

vi.mock('@/services/security-advisories', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/security-advisories')>(),
  fetchSecurityAdvisories: mocks.fetchSecurityAdvisories,
}));
vi.mock('@/services/satellites', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/satellites')>(),
  fetchSatelliteTLEs: mocks.fetchSatelliteTLEs,
}));

const { DataLoaderManager } = await import('@/app/data-loader');

const advisory = {
  title: 'Travel update', link: 'https://example.com/advice', pubDate: new Date('2026-09-15T00:00:00Z'),
  source: 'FCDO', sourceCountry: 'UK', level: 'caution' as const,
};

function fakeLoader() {
  const panelCalls: Array<[string, string, unknown[]]> = [];
  const setSatellites = vi.fn();
  const loader = {
    ctx: { intelligenceCache: {} as Record<string, unknown>, map: { setSatellites } },
    cachedSatRecs: [{ stale: true }] as unknown[],
    satellitePropagationCleanup: null,
    callPanel: (key: string, method: string, ...args: unknown[]) => { panelCalls.push([key, method, args]); },
    stopSatellitePropagation: vi.fn(),
  };
  return { loader, panelCalls, setSatellites };
}

beforeEach(() => {
  mocks.fetchSecurityAdvisories.mockReset();
  mocks.fetchSatelliteTLEs.mockReset();
});

describe('loadSecurityAdvisories availability', () => {
  const load = (loader: object) => DataLoaderManager.prototype.loadSecurityAdvisories.call(loader as never);

  it('shows retained advisories under an error header when the read failed', async () => {
    const { loader, panelCalls } = fakeLoader();
    mocks.fetchSecurityAdvisories.mockResolvedValue({ ok: false, advisories: [advisory] });
    await load(loader);
    expect(panelCalls).toEqual([
      ['security-advisories', 'setData', [[advisory]]],
      ['security-advisories', 'setErrorState', [true]],
    ]);
    expect(loader.ctx.intelligenceCache.advisories).toEqual([advisory]);
  });

  it('shows the full error view when the read failed with nothing retained', async () => {
    const { loader, panelCalls } = fakeLoader();
    loader.ctx.intelligenceCache.advisories = [advisory];
    mocks.fetchSecurityAdvisories.mockResolvedValue({ ok: false, advisories: [] });
    await load(loader);
    expect(panelCalls.map(([, method]) => method)).toEqual(['setData', 'showError']);
    expect(loader.ctx.intelligenceCache.advisories).toEqual([]);
  });

  it('applies a confirmed-empty success without an error state', async () => {
    const { loader, panelCalls } = fakeLoader();
    mocks.fetchSecurityAdvisories.mockResolvedValue({ ok: true, advisories: [] });
    await load(loader);
    expect(panelCalls).toEqual([['security-advisories', 'setData', [[]]]]);
  });
});

describe('loadSatellites availability', () => {
  const load = (loader: object) => DataLoaderManager.prototype.loadSatellites.call(loader as never);

  it.each([['confirmed empty', []], ['unavailable or expired', null]])('clears the layer on %s', async (_label, data) => {
    const { loader, setSatellites } = fakeLoader();
    mocks.fetchSatelliteTLEs.mockResolvedValue(data);
    await load(loader);
    expect(setSatellites).toHaveBeenCalledWith([]);
    expect(loader.cachedSatRecs).toEqual([]);
  });
});
