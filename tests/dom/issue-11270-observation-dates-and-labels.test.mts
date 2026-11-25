/**
 * #11270 panel copy: the FSI and Gulf panels show when their numbers were
 * observed, the Momentum card shows the Mayer Multiple it names, and the debt
 * clock names its ratio change for what it is.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const { hydrated, mockGetNationalDebtData } = vi.hoisted(() => ({
  hydrated: new Map<string, unknown>(),
  mockGetNationalDebtData: vi.fn(),
}));

vi.mock('@/services/bootstrap', () => ({
  getHydratedData: (key: string) => hydrated.get(key),
}));

vi.mock('@/services/economic', () => ({
  getNationalDebtData: mockGetNationalDebtData,
}));

vi.mock('@/services/generated-rpc-clients', () => {
  const pending = () => new Promise<never>(() => {});
  return {
    MarketServiceClient: class { getFearGreedIndex = pending; listGulfQuotes = pending; },
    EconomicServiceClient: class { getEuFsi = async () => ({ unavailable: true }); getMacroSignals = pending; },
  };
});

import { FSIPanel } from '@/components/FSIPanel';
import { GulfEconomiesPanel } from '@/components/GulfEconomiesPanel';
import { MacroSignalsPanel } from '@/components/MacroSignalsPanel';
import { NationalDebtPanel } from '@/components/NationalDebtPanel';

const utcDate = (ms: number, opts: Intl.DateTimeFormatOptions) =>
  new Date(ms).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  hydrated.clear();
  document.body.innerHTML = '';
});

function mount<T extends { getElement(): HTMLElement }>(panel: T): T {
  document.body.appendChild(panel.getElement());
  return panel;
}

describe('#11270 FSI panel', () => {
  it('dates the US FSI reading with its oldest input observation', async () => {
    hydrated.set('fearGreedIndex', {
      unavailable: false,
      headerMetrics: {
        fsi: { value: 1.42, label: 'Low Stress', hygPrice: 80.1, tltPrice: 88.4, asOf: Date.UTC(2026, 10, 21) },
        vix: { value: 16.2 },
        hySpread: { value: 3.1 },
      },
    });
    const panel = mount(new FSIPanel());
    await panel.fetchData();
    await settle();
    expect(panel.getElement().querySelector('.fsi-us-as-of')?.textContent).toBe(`As of ${utcDate(Date.UTC(2026, 10, 21), { year: 'numeric', month: 'short', day: 'numeric' })}`);
  });
});

describe('#11270 Gulf economies panel', () => {
  it('shows the observation date beside each quote', async () => {
    hydrated.set('gulfQuotes', {
      rateLimited: false,
      quotes: [
        { symbol: '^TASI.SR', name: 'Tadawul', flag: '', country: 'Saudi Arabia', type: 'index', price: 11873.2, change: 0.4, sparkline: [], priceAt: Date.UTC(2026, 10, 24, 12) },
        { symbol: 'AEDUSD=X', name: 'UAE Dirham', flag: '', country: 'UAE', type: 'currency', price: 0.2723, change: 0, sparkline: [] },
      ],
    });
    const panel = mount(new GulfEconomiesPanel());
    await panel.fetchData();
    await settle();
    const symbols = [...panel.getElement().querySelectorAll('.market-symbol')].map((el) => el.textContent);
    expect(symbols).toEqual([`Saudi Arabia · ${utcDate(Date.UTC(2026, 10, 24, 12), { month: 'short', day: 'numeric' })}`, 'UAE']);
  });
});

describe('#11270 Macro signals Momentum card', () => {
  it('shows the Mayer Multiple value it captions', async () => {
    hydrated.set('macroSignals', {
      timestamp: '2026-11-25T00:00:00Z',
      verdict: 'BUY',
      bullishCount: 4,
      totalCount: 7,
      signals: {
        technicalTrend: { status: 'BULLISH', btcPrice: 98000, sma50: 95000, sma200: 83000, vwap30d: 96000, mayerMultiple: 1.18, sparkline: [] },
        priceMomentum: { status: 'STRONG' },
      },
      meta: { qqqSparkline: [] },
      unavailable: false,
    });
    const panel = mount(new MacroSignalsPanel());
    await panel.fetchData();
    await settle();
    const card = [...panel.getElement().querySelectorAll('.signal-card')]
      .find((el) => el.querySelector('.signal-name')?.textContent === 'Momentum');
    expect(card?.querySelector('.signal-value')?.textContent).toBe('1.18');
    expect(card?.querySelector('.signal-detail')?.textContent).toBe('Mayer Multiple');
  });
});

describe('#11270 National debt clock', () => {
  it('labels annualGrowth as a debt-to-GDP ratio change', async () => {
    mockGetNationalDebtData.mockResolvedValueOnce({
      entries: [{ iso3: 'JPN', debtUsd: 9_800_000_000_000, gdpUsd: 4_900_000_000_000, debtToGdp: 199.4, annualGrowth: -2.6, perSecondRate: 0, perDayRate: 0, baselineTs: String(Date.UTC(2024, 0, 1)), source: 'IMF WEO' }],
      seededAt: '2026-11-25T00:00:00Z',
      unavailable: false,
    });
    const panel = mount(new NationalDebtPanel());
    await panel.refresh();
    await settle();
    const el = panel.getElement();
    expect(el.querySelector('.debt-growth')?.textContent).toBe('-2.6% debt/GDP YoY');
    expect(el.querySelector('[data-sort="growth"]')?.textContent).toBe('Ratio 1Y');
    panel.destroy();
  });
});
