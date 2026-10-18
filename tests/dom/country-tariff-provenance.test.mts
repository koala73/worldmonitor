import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { CountryBriefController } from '@/components/CountryBriefController';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import type { CountryBriefSource } from '@/services/country-brief-source';
import type { GetTariffTrendsResponse } from '@/generated/client/worldmonitor/trade/v1/service_client';
import { initTestI18n } from './helpers/i18n.mts';

const reads = vi.hoisted(() => ({ attempted: [] as string[] }));
vi.hoisted(() => { globalThis.fetch = async input => { reads.attempted.push(String(input)); throw new Error('Tariff fixtures forbid network reads'); }; });
beforeAll(async () => { await initTestI18n(); });
afterAll(() => { expect(reads.attempted).toEqual([]); });
const effective = { tariffRate: 9.9, sourceName: 'Yale Budget Lab', sourceUrl: 'https://budgetlab.yale.edu/research/state-us-tariffs', observationPeriod: 'December 2025', updatedAt: '2026-03-02' };
const annual = [{ year: 2022, tariffRate: 2.4 }, { year: 2023, tariffRate: 2.9 }];

async function render(effectiveTariffRate: GetTariffTrendsResponse['effectiveTariffRate'] | null = effective, datapoints = annual) {
  const panel = Object.create(CountryDeepDivePanel.prototype) as CountryDeepDivePanel;
  const body = document.createElement('div');
  Reflect.set(panel, 'tariffBody', body);
  Reflect.set(panel, 'currentCode', 'US');
  Reflect.set(panel, 'abortController', new AbortController());
  panel.setSectionFailure = vi.fn();
  const unavailable = async () => { throw new Error('Unrelated section not supplied'); };
  const source = {
    canRequestPremium: () => true,
    military: { getDefenseIndustrialBase: unavailable },
    supply: { getCountryVulnerabilities: unavailable, getCountryProducts: unavailable },
    economic: { getNationalDebt: unavailable }, intelligence: { getCountryRisk: unavailable },
    exposure: unavailable,
    trade: { listComtradeFlows: unavailable, getTariffTrends: async () => ({ datapoints, effectiveTariffRate: effectiveTariffRate ?? undefined }) },
  } as unknown as CountryBriefSource;
  const controller = new CountryBriefController(source, panel);
  Reflect.set(controller, 'snapshot', { countryCode: 'US', revision: 1, sections: {} });
  controller.refreshPremium();
  await vi.waitFor(() => expect(body.textContent).not.toBe(''));
  controller.dispose();
  return body;
}

it('keeps supplied effective provenance separate from annual direction and history through the controller', async () => {
  const body = await render();
  expect(body.textContent).toContain('9.90%');
  expect(body.textContent).toContain('Yale Budget Lab');
  expect(body.textContent).toContain('Observation period: December 2025');
  expect(body.textContent).toContain('Source page updated: 2026-03-02');
  expect(body.querySelector('a')?.getAttribute('href')).toBe(effective.sourceUrl);
  expect(body.textContent).toContain('Rising');
  expect(body.textContent).toContain('2.90%');
  expect(body.textContent).not.toContain('2026-10-06');
});
it('renders supplied zero as a measured rate', async () => { expect((await render({ ...effective, tariffRate: 0 })).textContent).toContain('0.00%'); });
it('does not turn absent metadata into complete provenance', async () => {
  const body = await render({ ...effective, sourceName: '', sourceUrl: '', observationPeriod: '', updatedAt: '' });
  for (const label of ['Source: Not supplied', 'Observation period: Not supplied', 'Source page updated: Not supplied']) expect(body.textContent).toContain(label);
  expect(body.querySelector('a')).toBeNull();
});
it.each(['javascript:alert(1)', 'data:text/html,hostile', 'https://[', '//evil.example'])('does not link unsafe or invalid original URL %s', async sourceUrl => {
  const body = await render({ ...effective, sourceUrl });
  expect(body.querySelector('a')).toBeNull();
  expect(body.textContent).toContain('Yale Budget Lab');
});
it('renders hostile supplied metadata as literal text', async () => {
  const body = await render({ ...effective, sourceName: '<img src=x onerror=alert(1)>', observationPeriod: '<script>bad()</script>', updatedAt: '<b>literal</b>' });
  expect(body.textContent).toContain('<img src=x onerror=alert(1)>');
  expect(body.textContent).toContain('<script>bad()</script>');
  expect(body.querySelector('img,script,b')).toBeNull();
});
it('keeps annual-only rates explicit without inventing effective snapshot metadata', async () => {
  const body = await render(null);
  expect(body.textContent).toContain('Reported annual tariff rate');
  expect(body.textContent).toContain('2.90%');
  expect(body.textContent).toContain('Annual observation: 2023');
  expect(body.textContent).not.toContain('December 2025');
});
it.each([NaN, Infinity, -1])('keeps invalid rate %s unavailable', async tariffRate => { expect((await render({ ...effective, tariffRate })).textContent).toContain('No tariff data available'); });
