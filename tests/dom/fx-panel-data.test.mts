/**
 * `getFxPanelData` source-independence and degraded reporting (#6199).
 *
 * The mappers and the panel are covered elsewhere; the seam BETWEEN them was
 * not. This is where the three reads are composed, where one dead source must
 * not blank its siblings, and where `degraded` is derived — including the one
 * asymmetry worth pinning: only the ECB path carries a real failure signal
 * (`unavailable`), while the two `ensureHydrated` keys report an outage and a
 * cache miss identically.
 *
 * Lives under tests/dom/ for the harness, not the DOM: `@/services/economic`
 * transitively imports `@/services/i18n`, which uses `import.meta.glob` and is
 * therefore unreachable from the `tsx --test` suite. No DOM is touched here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockEnsureHydrated, mockGetEcbFxRates } = vi.hoisted(() => ({
  mockEnsureHydrated: vi.fn(),
  mockGetEcbFxRates: vi.fn(),
}));

vi.mock('@/services/bootstrap', () => ({
  ensureHydrated: mockEnsureHydrated,
  getHydratedData: vi.fn(() => undefined),
}));

vi.mock('@/services/generated-rpc-clients', () => ({
  EconomicServiceClient: class {
    getEcbFxRates = mockGetEcbFxRates;
  },
}));

/**
 * Re-import per test. `getEcbFxRatesData` sits behind a module-level circuit
 * breaker with a 4h cache and `shouldCache: rates.length > 0`, so a single
 * successful ECB read in one test would be replayed into every later test and
 * silently defeat the unavailable/throwing cases. (That caching is correct in
 * production — a brief ECB outage should be masked by the cache — which is
 * exactly why it has to be reset here rather than worked around.)
 */
async function loadService() {
  vi.resetModules();
  return (await import('@/services/economic')).getFxPanelData;
}

const YOY = {
  rates: [
    { countryCode: 'AR', currency: 'ARS', yoyChange: -38.4, drawdown24m: -41, asOf: '2026-08-01' },
  ],
};
const USD = { USD: 1, JPY: 0.0067 };
const ECB_OK = { rates: [{ pair: 'EURUSD', rate: 1.148, change1d: 0.12 }], updatedAt: '', seededAt: '1', unavailable: false };
/** What getEcbFxRatesData resolves to when the RPC fails — it never rejects. */
const ECB_UNAVAILABLE = { rates: [], updatedAt: '', seededAt: '0', unavailable: true };

function hydrate(map: Record<string, unknown>) {
  mockEnsureHydrated.mockImplementation((key: string) => Promise.resolve(map[key]));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getFxPanelData', () => {
  it('returns all three sources with nothing degraded when every read succeeds', async () => {
    hydrate({ fxYoy: YOY, sharedFxRates: USD });
    mockGetEcbFxRates.mockResolvedValue(ECB_OK);

    const getFxPanelData = await loadService();
    const data = await getFxPanelData();
    expect(data.stress).toHaveLength(1);
    expect(data.usd).toHaveLength(1);   // USD itself is dropped
    expect(data.eur).toHaveLength(1);
    expect(data.degraded).toEqual([]);
  });

  it('keeps the surviving sources when fxYoy is dead', async () => {
    // The whole point of settling them independently: a dead Yahoo seed must
    // not blank the ECB rates.
    hydrate({ fxYoy: undefined, sharedFxRates: USD });
    mockGetEcbFxRates.mockResolvedValue(ECB_OK);

    const getFxPanelData = await loadService();
    const data = await getFxPanelData();
    expect(data.stress).toEqual([]);
    expect(data.usd).toHaveLength(1);
    expect(data.eur).toHaveLength(1);
    expect(data.degraded).toEqual(['stress']);
  });

  it('treats an unavailable ECB response as degraded, not as an empty feed', async () => {
    // This is the one source with a REAL failure signal. It must not be read as
    // "the ECB published no rates today".
    hydrate({ fxYoy: YOY, sharedFxRates: USD });
    mockGetEcbFxRates.mockResolvedValue(ECB_UNAVAILABLE);

    const getFxPanelData = await loadService();
    const data = await getFxPanelData();
    expect(data.eur).toEqual([]);
    expect(data.degraded).toEqual(['eur']);
    expect(data.stress).toHaveLength(1);
  });

  it('does not let a throwing ECB read take down the sibling sources', async () => {
    // getEcbFxRatesData catches internally today, so this asserts the guarantee
    // survives even if that ever stops being true.
    hydrate({ fxYoy: YOY, sharedFxRates: USD });
    mockGetEcbFxRates.mockRejectedValue(new Error('rpc exploded'));

    const getFxPanelData = await loadService();
    const data = await getFxPanelData();
    expect(data.stress).toHaveLength(1);
    expect(data.usd).toHaveLength(1);
    expect(data.degraded).toEqual(['eur']);
  });

  it('reports every dead source when they all fail, not just the first', async () => {
    hydrate({ fxYoy: undefined, sharedFxRates: undefined });
    mockGetEcbFxRates.mockResolvedValue(ECB_UNAVAILABLE);

    const getFxPanelData = await loadService();
    const data = await getFxPanelData();
    expect(data.degraded).toEqual(['stress', 'usd', 'eur']);
  });

  it('reads both on-demand keys by name', async () => {
    // A typo'd key would silently return undefined and read as an outage.
    hydrate({ fxYoy: YOY, sharedFxRates: USD });
    mockGetEcbFxRates.mockResolvedValue(ECB_OK);

    const getFxPanelData = await loadService();
    await getFxPanelData();
    const keys = mockEnsureHydrated.mock.calls.map((c) => c[0]);
    expect(keys).toContain('fxYoy');
    expect(keys).toContain('sharedFxRates');
  });
});
