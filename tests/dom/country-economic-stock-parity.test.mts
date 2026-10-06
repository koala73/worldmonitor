import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import { CountryIntelManager } from '@/app/country-intel';
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
