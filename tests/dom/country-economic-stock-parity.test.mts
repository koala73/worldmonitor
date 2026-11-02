import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import { CountryIntelManager } from '@/app/country-intel';
import { CountryBriefController } from '@/components/CountryBriefController';
import type { CountryBriefSource } from '@/services/country-brief-source';
import { buildImfEconomicIndicators } from '@/services/imf-country-data';
import type { StockIndexData } from '@/components/CountryBriefPanel';
import { initTestI18n } from './helpers/i18n.mts';

const reads = vi.hoisted(() => ({ attempted: [] as string[] }));
vi.hoisted(() => {
  globalThis.fetch = async input => {
    reads.attempted.push(String(input));
    throw new Error('Economic parity fixtures forbid network reads');
  };
});
beforeAll(async () => { await initTestI18n(); });
afterAll(() => { expect(reads.attempted).toEqual([]); });

const stock: StockIndexData = { available: true, code: 'CA', symbol: '^GSPTSE', indexName: 'TSX Composite', price: '35518.6', weekChangePercent: '0.08', currency: 'CAD' };
const bundle = { growth: { realGdpGrowthPct: 1.5, gdpPerCapitaUsd: 60300 }, macro: { inflationPct: 2.5, primaryBalancePct: -2.4 }, labor: { unemploymentPct: 6.5 }, external: null, fetchedAt: 0 };

function panelFixture() {
  const panel = Object.create(CountryDeepDivePanel.prototype) as CountryDeepDivePanel;
  const body = document.createElement('div');
  Reflect.set(panel, 'economicBody', body);
  Reflect.set(panel, 'economicIndicators', []);
  return { panel, body };
}
function imfRows() {
  return buildImfEconomicIndicators(bundle as Parameters<typeof buildImfEconomicIndicators>[0]);
}
function websiteRows(data: StockIndexData) {
  const manager = Object.create(CountryIntelManager.prototype);
  return Reflect.get(manager, 'buildEconomicIndicators').call(manager, 'CA', null, data, bundle);
}
function renderedRows(body: HTMLElement) {
  return [...body.querySelectorAll('.cdp-economic-item')].map(row => row.textContent);
}

it.each(['stock-first', 'imf-first'])('keeps metric disclosures through %s composition and repeat stock', order => {
  const data = { ...bundle, growth: { ...bundle.growth, periods: { realGdpGrowthPct: 2026 } }, macro: { ...bundle.macro, periods: { inflationPct: 2025, primaryBalancePct: 2024 } }, labor: { ...bundle.labor, periods: { unemploymentPct: 2020 } } };
  const rows = buildImfEconomicIndicators(data as Parameters<typeof buildImfEconomicIndicators>[0]);
  const { panel, body } = panelFixture();
  if (order === 'stock-first') panel.updateStock(stock);
  panel.updateEconomicIndicators(rows);
  panel.updateStock(stock);
  panel.updateStock(stock);
  expect([...body.querySelectorAll('.cdp-economic-source')].map(row => row.textContent)).toEqual([
    'Market Service', ...[2026, 2025, 2020, 2024].map(year => `IMF WEO · Year ${year} · IMF release not supplied`),
  ]);
  expect(body.querySelectorAll('.cdp-economic-item')).toHaveLength(6);
});

it('preserves populated CII prefix priority with a six-row cap', () => {
  const manager = Object.create(CountryIntelManager.prototype);
  const score = { score: 71, level: 'high', trend: 'stable' };
  const rows = Reflect.get(manager, 'buildEconomicIndicators').call(manager, 'CA', score, stock, bundle);
  expect(rows.map((row: { label: string }) => row.label)).toEqual(['Stock Index', 'Weekly Momentum', 'Instability Regime', 'Real GDP Growth', 'CPI Inflation', 'Unemployment']);
  expect(rows.some((row: { label: string }) => row.label === 'Primary Balance')).toBe(false);
});

it('preserves country periods through the actual host controller projection', async () => {
  const { panel, body } = panelFixture();
  Reflect.set(panel, 'currentCode', 'CA');
  Reflect.set(panel, 'abortController', new AbortController());
  panel.setSectionFailure = vi.fn();
  panel.setSectionCoverage = vi.fn();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const country = { inflationPct: 0, year: 2099, periods: { inflationPct: 2025 } };
  const source = {
    mode: 'host', canRequestPremium: () => false,
    market: { getCountryStockIndex: async () => ({ available: false }) },
    intelligence: { getCountryFacts: async () => ({}) },
    prediction: { listPredictionMarkets: async () => ({ dataAvailable: false }) },
    fetch: async (input: string) => new Response(JSON.stringify(input.includes('imfMacro') ? { data: { imfMacro: { countries: { CA: country } } }, missing: ['imfGrowth', 'imfLabor', 'imfExternal'] } : { data: {} })),
  } as unknown as CountryBriefSource;
  const controller = new CountryBriefController(source, panel);
  try {
    const projected = await controller.hydrate('CA', 'Canada').imfPromise;
    expect(projected?.macro?.periods).toEqual({ inflationPct: 2025 });
    expect(body.textContent).toContain('+0.0%');
    expect(body.textContent).toContain('IMF WEO · Year 2025 · IMF release not supplied');
  } finally { controller.dispose(); warning.mockRestore(); }
});

it('renders the same six economic rows as the website from supplied stock and IMF data', () => {
  const shared = panelFixture();
  shared.panel.updateEconomicIndicators(imfRows());
  shared.panel.updateStock(stock);
  const website = panelFixture();
  website.panel.updateEconomicIndicators(websiteRows(stock));
  expect(renderedRows(shared.body)).toEqual(renderedRows(website.body));
  expect(shared.body.textContent).toContain('Weekly Momentum');
  expect(shared.body.textContent).toContain('+0.08%');
  expect(shared.body.textContent).toContain('TSX Composite: 35518.6 CAD');
  expect(shared.body.textContent).not.toContain('GDP / Capita');
});

it.each(['0.08', '-1.25', '0'])('preserves the website sign, precision and trend for weekly change %s', weekChangePercent => {
  const data = { ...stock, weekChangePercent };
  const shared = panelFixture();
  shared.panel.updateStock(data);
  const website = panelFixture();
  website.panel.updateEconomicIndicators(websiteRows(data).slice(0, 2));
  expect(shared.body.innerHTML).toBe(website.body.innerHTML);
});

it('replaces both market rows on repeated stock updates', () => {
  const { panel, body } = panelFixture();
  panel.updateEconomicIndicators(imfRows());
  panel.updateStock(stock);
  panel.updateStock({ ...stock, weekChangePercent: '-1.25', price: '35000.0' });
  expect(body.querySelectorAll('.cdp-economic-item')).toHaveLength(6);
  expect(body.textContent?.match(/Stock Index/g)).toHaveLength(1);
  expect(body.textContent?.match(/Weekly Momentum/g)).toHaveLength(1);
  expect(body.textContent).toContain('-1.25%');
  expect(body.textContent).not.toContain('+0.08%');
  expect(body.textContent).toContain('Primary Balance');
});

it('preserves parity when the controller reapplies stock after IMF arrives', () => {
  const { panel, body } = panelFixture();
  panel.updateStock(stock);
  panel.updateEconomicIndicators(imfRows());
  panel.updateStock(stock);
  const website = panelFixture();
  website.panel.updateEconomicIndicators(websiteRows(stock));
  expect(renderedRows(body)).toEqual(renderedRows(website.body));
});

it.each(['', 'unknown', 'NaN', '0.08oops', '0.08%', '   '])('does not fabricate weekly momentum for invalid input %s', weekChangePercent => {
  const { panel, body } = panelFixture();
  panel.updateEconomicIndicators(imfRows());
  panel.updateStock(stock);
  panel.updateStock({ ...stock, weekChangePercent });
  expect(body.textContent).not.toContain('Weekly Momentum');
  expect(body.textContent).not.toContain('NaN%');
  expect(body.textContent).toContain('Stock Index');
});

it('retains the existing unavailable-stock behavior', () => {
  const { panel, body } = panelFixture();
  panel.updateEconomicIndicators(imfRows());
  const before = body.innerHTML;
  panel.updateStock({ ...stock, available: false });
  expect(body.innerHTML).toBe(before);
});

it.each([['+0.08', '+0.08%'], ['+0', '+0%'], ['-0', '+0%'], ['  +0.0800  ', '+0.0800%']])('formats the valid signed value %s once while preserving precision', (weekChangePercent, expected) => {
  const { panel, body } = panelFixture();
  panel.updateStock({ ...stock, weekChangePercent });
  expect(body.querySelectorAll('.cdp-economic-value')[1]?.textContent).toBe(expected);
});

it.each([['-1e-400', '-1e-400%'], ['-.001e-400', '-.001e-400%'], ['+1e-400', '+1e-400%'], ['-0e-400', '+0e-400%']])('preserves the supplied sign of nonzero decimal text %s when numeric parsing underflows', (weekChangePercent, expected) => {
  const { panel, body } = panelFixture();
  panel.updateStock({ ...stock, weekChangePercent });
  expect(body.querySelectorAll('.cdp-economic-value')[1]?.textContent).toBe(expected);
});
