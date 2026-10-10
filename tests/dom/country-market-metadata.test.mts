import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CountryBriefController } from '@/components/CountryBriefController';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import type { CountryBriefSource } from '@/services/country-brief-source';
import type { PredictionMarket } from '@/services/prediction';
import * as prediction from '@/services/prediction';
import * as imfCountryData from '@/services/imf-country-data';
import * as bootstrap from '@/services/bootstrap';
import { PredictionServiceClient } from '@/generated/client/worldmonitor/prediction/v1/service_client';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => { await initTestI18n(); });


const originalClock = Date.parse('2026-10-09T07:41:45.410Z');
const rpcRows = [
  { id: 'KXCHINA-27-T4', title: 'China controlled contract A', yesPrice: 0.6849, volume: 500, url: 'https://kalshi.com/markets/kxchina', closesAt: 0, category: 'country:CN', source: 'MARKET_SOURCE_KALSHI' },
  { id: 'KXCHINA-28-T4', title: 'China controlled contract B', yesPrice: 0.31, volume: 90, url: 'https://kalshi.com/markets/kxchina', closesAt: 0, category: 'country:CN', source: 'MARKET_SOURCE_KALSHI' },
];
function fixture() {
  const body = document.createElement('div');
  const card = document.createElement('section');
  card.append(body);
  const panel = Object.create(CountryDeepDivePanel.prototype) as CountryDeepDivePanel;
  Reflect.set(panel, 'marketsBody', body);
  Reflect.set(panel, 'currentCode', 'CN');
  Reflect.set(panel, 'abortController', new AbortController());
  Reflect.set(panel, 'sections', [{ id: 'markets', title: 'Prediction markets', body, card }]);
  const never = () => new Promise(() => {});
  const list = vi.fn().mockResolvedValue({ markets: rpcRows, fetchedAt: originalClock, dataAvailable: true });
  const intelligence = { getCountryFacts: never, getCountryEnergyProfile: never, getCountryPortActivity: never };
  const source = { mode: 'host', canRequestPremium: () => false, fetch: never, market: { getCountryStockIndex: never }, intelligence, prediction: { listPredictionMarkets: list } } as unknown as CountryBriefSource;
  const controller = new CountryBriefController(source, panel);
  return { body, panel, controller, list };
}
async function load(fixtureState: ReturnType<typeof fixture>) {
  fixtureState.controller.hydrate('CN', 'China');
  await Promise.resolve();
  await Promise.resolve();
}
function footer(fixtureState: ReturnType<typeof fixture>) { return fixtureState.body.querySelector('.cdp-section-source')?.textContent; }

describe('original public country market metadata', () => {
  it('renders original list clock and text-safe separate contract identity without changing prices or links', async () => {
    const fixtureState = fixture();
    await load(fixtureState);
    expect(footer(fixtureState)).toBe('Market data snapshot: 2026-10-09T07:41:45.410Z. This time applies to the list. Quote times are not supplied.');
    expect(footer(fixtureState)).toContain('This time applies to the list. Quote times are not supplied.');
    expect([...fixtureState.body.querySelectorAll('.cdp-market-contract')].map(node => node.textContent)).toEqual(['Contract: KXCHINA-27-T4', 'Contract: KXCHINA-28-T4']);
    expect([...fixtureState.body.querySelectorAll('.cdp-market-prob')].map(node => node.textContent)).toEqual(['Probability: 68%', 'Probability: 31%']);
    const [firstRow, secondRow] = rpcRows;
    if (!firstRow || !secondRow) throw new Error('expected two rpc fixture rows');
    expect([...fixtureState.body.querySelectorAll('a')].map(node => node.getAttribute('href'))).toEqual([firstRow.url, secondRow.url]);
    const captured = vi.spyOn(fixtureState.panel, 'updateMarkets');
    await load(fixtureState);
    const firstCall = captured.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (!firstCall) throw new Error('expected updateMarkets to be called');
    const firstMarket = firstCall[0][0];
    expect(firstMarket).toBeDefined();
    if (!firstMarket) throw new Error('expected updateMarkets to receive a market');
    expect(firstMarket.yesPrice).toBe(0.6849 * 100);
    expect(firstCall[1]).toEqual({ fetchedAt: originalClock });
  });

  it.each([undefined, 0, -1, NaN, Infinity, 8.64e15 + 1, '1791531705410'])('keeps missing or invalid clock %s unknown and clears the previous clock', async clock => {
    const fixtureState = fixture();
    await load(fixtureState);
    fixtureState.list.mockResolvedValue({ markets: rpcRows, fetchedAt: clock, dataAvailable: true });
    await load(fixtureState);
    expect(footer(fixtureState)).toBe('Snapshot time unavailable. Quote times are not supplied.');
    expect(fixtureState.body.textContent).not.toContain('2026-10-09T07:41:45.410Z');
  });

  it('displays a supplied future snapshot literally without freshness or quote-time claims', async () => {
    const fixtureState = fixture();
    const future = Date.parse('2099-10-09T07:41:45.410Z');
    fixtureState.list.mockResolvedValue({ markets: rpcRows, fetchedAt: future, dataAvailable: true });
    await load(fixtureState);
    expect(footer(fixtureState)).toBe('Market data snapshot: 2099-10-09T07:41:45.410Z. This time applies to the list. Quote times are not supplied.');
    expect(footer(fixtureState)).not.toMatch(/fresh|retrieved|quote observed/i);
  });

  it('uses DOM text for hostile identifiers and marks missing identifiers unknown', async () => {
    const fixtureState = fixture();
    const identity = '<svg/onload=alert(1)>"&';
    fixtureState.list.mockResolvedValue({ markets: [{ ...rpcRows[0], id: identity }, { ...rpcRows[1], id: '' }], fetchedAt: originalClock, dataAvailable: true });
    await load(fixtureState);
    expect(fixtureState.body.querySelector('.cdp-market-contract')?.textContent).toBe(`Contract: ${identity}`);
    expect(fixtureState.body.querySelector('svg')).toBeNull();
    expect(fixtureState.body.textContent).toContain('Contract: Unknown');
  });

  it('retains old metadata on failure and replaces it on subsequent success', async () => {
    const fixtureState = fixture();
    await load(fixtureState);
    fixtureState.list.mockResolvedValue({ markets: [], fetchedAt: originalClock + 1, dataAvailable: false });
    await load(fixtureState);
    expect(footer(fixtureState)).toBe('Market data snapshot: 2026-10-09T07:41:45.410Z. This time applies to the list. Quote times are not supplied.');
    expect(fixtureState.body.querySelectorAll('.cdp-market-item')).toHaveLength(2);
    expect(fixtureState.body.textContent).toContain('Previously loaded observations remain visible.');
    await load(fixtureState);
    expect(fixtureState.body.querySelectorAll('.cdp-refresh-failure')).toHaveLength(1);
    fixtureState.list.mockResolvedValue({ markets: rpcRows, dataAvailable: true });
    await load(fixtureState);
    expect(footer(fixtureState)).toBe('Snapshot time unavailable. Quote times are not supplied.');
    expect(fixtureState.body.querySelector('.cdp-refresh-failure')).toBeNull();
    expect(fixtureState.body.querySelectorAll('.cdp-section-source')).toHaveLength(1);
  });

  it('keeps valid empty data empty with its snapshot and unavailable data unavailable', async () => {
    const fixtureState = fixture();
    fixtureState.list.mockResolvedValue({ markets: [], fetchedAt: originalClock, dataAvailable: true });
    await load(fixtureState);
    expect(fixtureState.body.querySelectorAll('.cdp-market-item')).toHaveLength(0);
    expect(fixtureState.body.textContent).toContain('No active markets for this country.');
    expect(footer(fixtureState)).toBe('Market data snapshot: 2026-10-09T07:41:45.410Z. This time applies to the list. Quote times are not supplied.');
    fixtureState.list.mockResolvedValue({ markets: [], fetchedAt: originalClock, dataAvailable: false });
    await load(fixtureState);
    expect(fixtureState.body.textContent).toContain('This section could not be loaded.');
  });

  it('preserves filtering, original order and the five-row limit', async () => {
    const fixtureState = fixture();
    fixtureState.list.mockResolvedValue({ markets: [{ ...rpcRows[0], id: 'expired', closesAt: 1 }, ...Array.from({ length: 7 }, (_, index) => ({ ...rpcRows[0], id: `original-${index}` }))], fetchedAt: originalClock, dataAvailable: true });
    await load(fixtureState);
    expect([...fixtureState.body.querySelectorAll('.cdp-market-contract')].map(node => node.textContent)).toEqual(Array.from({ length: 5 }, (_, index) => `Contract: original-${index}`));
  });

  it.each(['abort', 'country'] as const)('ignores late metadata after %s changes ownership', async change => {
    const fixtureState = fixture();
    await load(fixtureState);
    let resolveLate!: (value: unknown) => void;
    fixtureState.list.mockImplementation(() => new Promise(resolve => { resolveLate = resolve; }));
    fixtureState.controller.hydrate('CN', 'China');
    if (change === 'abort') fixtureState.controller.dispose();
    else Reflect.set(fixtureState.panel, 'currentCode', 'US');
    resolveLate({ markets: [], fetchedAt: originalClock + 1, dataAvailable: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(footer(fixtureState)).toBe('Market data snapshot: 2026-10-09T07:41:45.410Z. This time applies to the list. Quote times are not supplied.');
    expect(fixtureState.body.querySelectorAll('.cdp-market-item')).toHaveLength(2);
  });

  it('keeps website arrays without a country clock', async () => {
    const fixtureState = fixture();
    const firstRow = rpcRows[0];
    if (!firstRow) throw new Error('expected an rpc fixture row');
    const legacyRows: PredictionMarket[] = [{ id: 'website-original', title: 'Website fixture', yesPrice: 31, url: firstRow.url, source: 'kalshi' }];
    vi.spyOn(prediction, 'fetchCountryMarkets').mockResolvedValue(legacyRows);
    vi.spyOn(imfCountryData, 'getImfCountryBundle').mockImplementation(() => new Promise(() => {}));
    const source = Reflect.get(fixtureState.controller, 'source');
    source.mode = 'website';
    await load(fixtureState);
    expect(footer(fixtureState)).toBe('Snapshot time unavailable. Quote times are not supplied.');
    expect(fixtureState.body.textContent).toContain('Contract: website-original');
    expect(fixtureState.list).not.toHaveBeenCalled();
  });

  it('passes an original website list clock and replaces it with unknown fallback metadata', async () => {
    const fixtureState = fixture();
    const reply = { markets: rpcRows.map(row => ({ ...row, source: 'MARKET_SOURCE_KALSHI' as const })), fetchedAt: originalClock, dataAvailable: true };
    const listMarkets = vi.spyOn(PredictionServiceClient.prototype, 'listPredictionMarkets').mockResolvedValue(reply);
    vi.spyOn(imfCountryData, 'getImfCountryBundle').mockImplementation(() => new Promise(() => {}));
    Reflect.get(fixtureState.controller, 'source').mode = 'website';
    await load(fixtureState);
    await vi.waitFor(() => expect(footer(fixtureState)).toBe('Market data snapshot: 2026-10-09T07:41:45.410Z. This time applies to the list. Quote times are not supplied.'));
    expect(listMarkets).toHaveBeenCalledWith({ category: 'country:CN', query: '', pageSize: 5, cursor: '' });
    listMarkets.mockResolvedValue({ ...reply, fetchedAt: 0 });
    await load(fixtureState);
    await vi.waitFor(() => expect(footer(fixtureState)).toBe('Snapshot time unavailable. Quote times are not supplied.'));
    expect(fixtureState.body.textContent).toContain('Contract: KXCHINA-27-T4');
    expect(fixtureState.list).not.toHaveBeenCalled();
  });

  it.each(['empty', 'expired'] as const)('renders the original website clock for a successful %s list', async selection => {
    const fixtureState = fixture();
    const markets = selection === 'empty' ? [] : rpcRows.map(row => ({ ...row, source: 'MARKET_SOURCE_KALSHI' as const, closesAt: 1 }));
    vi.spyOn(PredictionServiceClient.prototype, 'listPredictionMarkets').mockResolvedValue({ markets, fetchedAt: originalClock, dataAvailable: true });
    vi.spyOn(imfCountryData, 'getImfCountryBundle').mockImplementation(() => new Promise(() => {}));
    Reflect.get(fixtureState.controller, 'source').mode = 'website';
    await load(fixtureState);
    await vi.waitFor(() => expect(footer(fixtureState)).toBe('Market data snapshot: 2026-10-09T07:41:45.410Z. This time applies to the list. Quote times are not supplied.'));
    expect(fixtureState.body.querySelectorAll('.cdp-market-item')).toHaveLength(0);
    expect(fixtureState.body.textContent).toContain('No active markets for this country.');
  });

  it.each(['unavailable', 'rejected'] as const)('clears the prior website clock for %s RPC bootstrap fallback', async failure => {
    const fixtureState = fixture();
    const reply = { markets: rpcRows.map(row => ({ ...row, source: 'MARKET_SOURCE_KALSHI' as const })), fetchedAt: originalClock, dataAvailable: true };
    const listMarkets = vi.spyOn(PredictionServiceClient.prototype, 'listPredictionMarkets').mockResolvedValue(reply);
    vi.spyOn(imfCountryData, 'getImfCountryBundle').mockImplementation(() => new Promise(() => {}));
    const fallback: PredictionMarket = { id: 'bootstrap-original', title: 'Will China host the meeting?', yesPrice: 31, source: 'kalshi' };
    vi.spyOn(bootstrap, 'getHydratedData').mockReturnValue({ geopolitical: [fallback], tech: [], finance: [], fetchedAt: originalClock + 1 });
    Reflect.get(fixtureState.controller, 'source').mode = 'website';
    await load(fixtureState);
    await vi.waitFor(() => expect(footer(fixtureState)).toBe('Market data snapshot: 2026-10-09T07:41:45.410Z. This time applies to the list. Quote times are not supplied.'));
    if (failure === 'rejected') listMarkets.mockRejectedValue(new Error('Controlled RPC failure'));
    else listMarkets.mockResolvedValue({ markets: [], fetchedAt: originalClock + 1, dataAvailable: false });
    await load(fixtureState);
    await vi.waitFor(() => expect(fixtureState.body.textContent).toContain('Contract: bootstrap-original'));
    expect(footer(fixtureState)).toBe('Snapshot time unavailable. Quote times are not supplied.');
  });

  it('ignores a late website metadata callback after disposal', async () => {
    const fixtureState = fixture();
    const reply = { markets: rpcRows.map(row => ({ ...row, source: 'MARKET_SOURCE_KALSHI' as const })), fetchedAt: originalClock, dataAvailable: true };
    const listMarkets = vi.spyOn(PredictionServiceClient.prototype, 'listPredictionMarkets').mockResolvedValue(reply);
    vi.spyOn(imfCountryData, 'getImfCountryBundle').mockImplementation(() => new Promise(() => {}));
    Reflect.get(fixtureState.controller, 'source').mode = 'website';
    await load(fixtureState);
    await vi.waitFor(() => expect(footer(fixtureState)).toBe('Market data snapshot: 2026-10-09T07:41:45.410Z. This time applies to the list. Quote times are not supplied.'));
    const applyMarkets = vi.spyOn(fixtureState.panel, 'updateMarkets');
    const serviceRead = vi.spyOn(prediction, 'fetchCountryMarkets');
    let resolveLate: ((value: typeof reply) => void) | undefined;
    listMarkets.mockImplementation(() => new Promise(resolve => { resolveLate = resolve; }));
    fixtureState.controller.hydrate('CN', 'China');
    await vi.waitFor(() => expect(resolveLate).toBeTypeOf('function'));
    fixtureState.controller.dispose();
    if (!resolveLate) throw new Error('Expected a pending website RPC');
    resolveLate({ ...reply, markets: [], fetchedAt: originalClock + 1 });
    await expect(serviceRead.mock.results[0]?.value).resolves.toEqual([]);
    await Promise.resolve();
    expect(applyMarkets).not.toHaveBeenCalled();
    expect(footer(fixtureState)).toBe('Market data snapshot: 2026-10-09T07:41:45.410Z. This time applies to the list. Quote times are not supplied.');
  });

  it('leaves array-only renderer callers with unknown snapshot metadata', () => {
    const fixtureState = fixture();
    const firstRow = rpcRows[0];
    if (!firstRow) throw new Error('expected an rpc fixture row');
    fixtureState.panel.updateMarkets([{ title: 'Legacy row', yesPrice: 31, source: 'kalshi', url: firstRow.url }] as PredictionMarket[]);
    expect(footer(fixtureState)).toBe('Snapshot time unavailable. Quote times are not supplied.');
    expect(fixtureState.body.textContent).toContain('Contract: Unknown');
  });
});
