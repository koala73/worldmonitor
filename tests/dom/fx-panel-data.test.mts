/**
 * `getFxPanelData` source-independence and degraded reporting (#6199, #6231).
 *
 * The mappers and the panel are covered elsewhere; the seam BETWEEN them was
 * not. This is where the four reads are composed, where one dead source must
 * not blank its siblings, and where `degraded` is derived — including the one
 * asymmetry worth pinning: only the ECB path carries a real failure signal
 * (`unavailable`), while the three `ensureHydrated` keys report an outage and
 * a cache miss identically.
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

// #6677: the FIRST dynamic import of the economic module graph pays for the
// whole graph's transform (1.2MB of generated clients plus the i18n locale
// glob), and that wall time is billed to whichever test runs it — under load
// it lands ~10ms over the 5000ms vitest default and reddens this file as a
// false positive. Subsequent resetModules() imports take ~35ms because they
// reuse the transform cache and only re-execute. Importing the graph once at
// module scope moves the transform cost into the file's import phase, which
// vitest does not bill to any testTimeout. The vi.mock calls above still
// apply to every later re-import, so the reset semantics are unchanged.
await import('@/services/economic');

const YOY = {
  rates: [
    { countryCode: 'AR', currency: 'ARS', yoyChange: -38.4, drawdown24m: -41, asOf: '2026-08-01' },
  ],
};
const USD = { USD: 1, JPY: 0.0067 };
const ECB_OK = { rates: [{ pair: 'EURUSD', rate: 1.148, change1d: 0.12 }], updatedAt: '', seededAt: '1', unavailable: false };
/** What getEcbFxRatesData resolves to when the RPC fails — it never rejects. */
const ECB_UNAVAILABLE = { rates: [], updatedAt: '', seededAt: '0', unavailable: true };
/** The map shape scripts/seed-cbr-rates.mjs:363 publishes (RUB per 1 unit). */
const RUB = {
  quoteCurrency: 'RUB',
  rateUnit: 'RUB per 1 unit of the listed currency',
  effectiveDate: '2026-08-05',
  rates: {
    USD: { rate: 81.1291, valuePerNominal: 81.1291, nominal: 1, name: '', numCode: '840', id: '', change1d: 0.32 },
    JPY: { rate: 0.515171, valuePerNominal: 51.5171, nominal: 100, name: '', numCode: '392', id: '', change1d: 0.0012 },
  },
  keyRate: { rate: 14, observedAt: '2026-08-04', previousRate: 14, changedAt: '2026-07-24', change: 0 },
  updatedAt: '2026-08-05T06:30:00.000Z',
  seededAt: 1,
};

function hydrate(map: Record<string, unknown>) {
  mockEnsureHydrated.mockImplementation((key: string) => Promise.resolve(map[key]));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getFxPanelData', () => {
  it('returns all four sources with nothing degraded when every read succeeds', async () => {
    hydrate({ fxYoy: YOY, sharedFxRates: USD, cbrRates: RUB });
    mockGetEcbFxRates.mockResolvedValue(ECB_OK);

    const getFxPanelData = await loadService();
    const data = await getFxPanelData();
    expect(data.stress).toHaveLength(1);
    expect(data.usd).toHaveLength(1);   // USD itself is dropped
    expect(data.eur).toHaveLength(1);
    expect(data.rub).toHaveLength(2);   // USD + JPY
    expect(data.degraded).toEqual([]);
  });

  it('keeps the surviving sources when fxYoy is dead', async () => {
    // The whole point of settling them independently: a dead Yahoo seed must
    // not blank the ECB rates or the CBR table.
    hydrate({ fxYoy: undefined, sharedFxRates: USD, cbrRates: RUB });
    mockGetEcbFxRates.mockResolvedValue(ECB_OK);

    const getFxPanelData = await loadService();
    const data = await getFxPanelData();
    expect(data.stress).toEqual([]);
    expect(data.usd).toHaveLength(1);
    expect(data.eur).toHaveLength(1);
    expect(data.rub).toHaveLength(2);
    expect(data.degraded).toEqual(['stress']);
  });

  it('treats an unavailable ECB response as degraded, not as an empty feed', async () => {
    // This is the one source with a REAL failure signal. It must not be read as
    // "the ECB published no rates today".
    hydrate({ fxYoy: YOY, sharedFxRates: USD, cbrRates: RUB });
    mockGetEcbFxRates.mockResolvedValue(ECB_UNAVAILABLE);

    const getFxPanelData = await loadService();
    const data = await getFxPanelData();
    expect(data.eur).toEqual([]);
    expect(data.rub).toHaveLength(2);
    expect(data.degraded).toEqual(['eur']);
    expect(data.stress).toHaveLength(1);
  });

  it('does not let a throwing ECB read take down the sibling sources', async () => {
    // getEcbFxRatesData catches internally today, so this asserts the guarantee
    // survives even if that ever stops being true.
    hydrate({ fxYoy: YOY, sharedFxRates: USD, cbrRates: RUB });
    mockGetEcbFxRates.mockRejectedValue(new Error('rpc exploded'));

    const getFxPanelData = await loadService();
    const data = await getFxPanelData();
    expect(data.stress).toHaveLength(1);
    expect(data.usd).toHaveLength(1);
    expect(data.rub).toHaveLength(2);
    expect(data.degraded).toEqual(['eur']);
  });

  it('keeps the surviving sources when the CBR table is dead', async () => {
    // CBR is the newest arrival; a dead cbrRates key must not blank stress,
    // USD or EUR — the panel's reason to exist predates this tab.
    hydrate({ fxYoy: YOY, sharedFxRates: USD, cbrRates: undefined });
    mockGetEcbFxRates.mockResolvedValue(ECB_OK);

    const getFxPanelData = await loadService();
    const data = await getFxPanelData();
    expect(data.rub).toEqual([]);
    expect(data.degraded).toEqual(['rub']);
    expect(data.stress).toHaveLength(1);
    expect(data.usd).toHaveLength(1);
    expect(data.eur).toHaveLength(1);
  });

  it('reports every dead source when they all fail, not just the first', async () => {
    hydrate({ fxYoy: undefined, sharedFxRates: undefined, cbrRates: undefined });
    mockGetEcbFxRates.mockResolvedValue(ECB_UNAVAILABLE);

    const getFxPanelData = await loadService();
    const data = await getFxPanelData();
    expect(data.degraded).toEqual(['stress', 'usd', 'eur', 'rub']);
  });

  it('reads all three on-demand keys by name', async () => {
    // A typo'd key would silently return undefined and read as an outage.
    hydrate({ fxYoy: YOY, sharedFxRates: USD, cbrRates: RUB });
    mockGetEcbFxRates.mockResolvedValue(ECB_OK);

    const getFxPanelData = await loadService();
    await getFxPanelData();
    const keys = mockEnsureHydrated.mock.calls.map((c) => c[0]);
    expect(keys).toContain('fxYoy');
    expect(keys).toContain('sharedFxRates');
    expect(keys).toContain('cbrRates');
  });
});
