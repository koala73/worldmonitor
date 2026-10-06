import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import { CountryBriefController } from '@/components/CountryBriefController';
import type { CountryBriefPanel } from '@/components/CountryBriefPanel';
import type { CountryBriefSource } from '@/services/country-brief-source';
import type { CountryProduct, CountryProductsResponse } from '@/services/supply-chain';
import { initTestI18n } from './helpers/i18n.mts';

const reads = vi.hoisted(() => ({ attempted: [] as string[] }));
vi.hoisted(() => { globalThis.fetch = async input => { reads.attempted.push(String(input)); throw new Error('Products fixtures forbid network reads'); }; });
beforeAll(async () => { await initTestI18n(); });
afterAll(() => { expect(reads.attempted).toEqual([]); });
function product(overrides: Partial<CountryProduct> = {}): CountryProduct {
  return { hs4: '8703', description: 'Synthetic vehicles', totalValue: 0, year: 2024, topExporters: [], denominatorBasis: 'reported_world', partnerBasis: 'share_threshold', ...overrides };
}
function response(products: CountryProduct[] = [product()]): CountryProductsResponse {
  return { iso2: 'CA', products, fetchedAt: '2026-10-06T00:00:00Z', evidence: { state: 'observed', source: 'synthetic-comtrade', requestedHs4s: [], missingHs4s: [], recoveredHs4s: [], lastAttemptAt: '', lastAttemptState: 'observed' } };
}
function fixture() {
  const panel = Object.create(CountryDeepDivePanel.prototype) as CountryDeepDivePanel;
  const body = document.createElement('div');
  Reflect.set(panel, 'productImportsBody', body);
  Reflect.set(panel, 'currentCode', 'CA');
  Reflect.set(panel, 'abortController', new AbortController());
  Reflect.set(panel, 'source', { chokepoints: async () => ({ chokepoints: [] }) });
  return { panel, body };
}
it('retains supplied year and zero total without exporters', () => {
  const { panel, body } = fixture(); panel.updateProductImports(response());
  expect(body.textContent).toContain('2024'); expect(body.textContent).toContain('$0'); expect(body.textContent).toContain('No exporter data');
});
it.each(['cache_unavailable', 'missing', 'no_records'])('controller carries empty response evidence %s to the actual panel', async state => {
  const { panel, body } = fixture(), value = response([]); value.evidence!.state = state;
  const source = { canRequestPremium: () => true, supply: { getCountryProducts: async () => value } } as unknown as CountryBriefSource;
  const controller = new CountryBriefController(source, panel as unknown as CountryBriefPanel);
  Reflect.set(controller, 'snapshot', { countryCode: 'CA', revision: 0, sections: {} });
  const read = Reflect.get(controller, 'read').bind(controller);
  const pending: Promise<unknown>[] = [];
  Reflect.set(controller, 'read', (id: string, ...args: unknown[]) => { if (id !== 'products') return Promise.resolve(null); const task = read(id, ...args); pending.push(task); return task; });
  controller.refreshPremium(); await Promise.all(pending);
  expect(body.textContent).toContain(state); expect(body.textContent).toContain('synthetic-comtrade'); controller.dispose();
});
it('renders response evidence as literal text and clears it on replacement', () => {
  const { panel, body } = fixture(), value = response();
  value.evidence!.source = '<img src=x onerror=alert(1)>'; value.evidence!.state = '<script>state</script>';
  panel.updateProductImports(value); expect(body.textContent).toContain(value.evidence!.source); expect(body.textContent).toContain(value.evidence!.state);
  expect(body.querySelector('img,script')).toBeNull();
  panel.updateProductImports(response()); expect(body.textContent).not.toContain('onerror'); expect(body.textContent).toContain('observed');
});
it.each([{ count: 9, share: 0.11, expectedShare: '11%' }, { count: 0, share: 0, expectedShare: '0%' }])('preserves measured omitted suppliers count=$count share=$share', ({ count, share, expectedShare }) => {
  const { panel, body } = fixture(); panel.updateProductImports(response([product({ omittedPartnerCount: count, omittedPartnerShare: share })]));
  expect(body.textContent).toContain('Omitted suppliers: '+count); expect(body.textContent).toContain('Omitted share: '+expectedShare);
});
it('leading five keeps omitted coverage unmeasured', () => {
  const { panel, body } = fixture(); panel.updateProductImports(response([product({ partnerBasis: 'leading_5' })]));
  expect(body.textContent).toContain('Leading five'); expect(body.textContent).toContain('Omitted suppliers: unavailable'); expect(body.textContent).not.toContain('Omitted suppliers: 0');
});
it('selected product refreshes its own year and omitted coverage', () => {
  const { panel, body } = fixture(); panel.updateProductImports(response([product({ omittedPartnerCount: 9, omittedPartnerShare: 0.11 }), product({ hs4: '3004', description: 'Synthetic medicines', year: 2023, omittedPartnerCount: 0, omittedPartnerShare: 0 })]));
  const input = body.querySelector<HTMLInputElement>('input')!; input.value = ''; input.dispatchEvent(new Event('input'));
  body.querySelectorAll<HTMLButtonElement>('button')[1]!.click();
  expect(body.textContent).toContain('2023'); expect(body.textContent).not.toContain('2024'); expect(body.textContent).toContain('Omitted suppliers: 0'); expect(body.textContent).not.toContain('Omitted suppliers: 9'); expect(body.textContent).toContain('synthetic-comtrade');
});
it('missing evidence and later unavailable response remove old fields', () => {
  const { panel, body } = fixture(); const value = response(); delete value.evidence;
  panel.updateProductImports(value); expect(body.textContent).toContain('Cache state: unavailable'); expect(body.textContent).toContain('Cache source: unavailable');
  panel.updateProductImports(null); expect(body.textContent).toBe('No data available'); expect(body.textContent).not.toContain('2024');
});
it('retains supplied zero supplier amount and share', () => {
  const { panel, body } = fixture(); panel.updateProductImports(response([product({ topExporters: [{ partnerCode: 840, partnerIso2: 'US', share: 0, value: 0 }] })]));
  expect(body.querySelector('.cdp-product-share')?.textContent).toContain('0%'); expect(body.querySelector('.cdp-product-val')?.textContent).toBe('$0');
});
it('preserves actual Unknown and Safe route labels beside supplier evidence', async () => {
  const { panel, body } = fixture();
  Reflect.set(panel, 'source', { chokepoints: async () => ({ chokepoints: [{ id: 'hormuz_strait', disruptionScore: 0 }] }) });
  panel.updateProductImports(response([product({ topExporters: [
    { partnerCode: 840, partnerIso2: 'US', share: 0.4, value: 400 },
    { partnerCode: 826, partnerIso2: 'GB', share: 0.3, value: 300 },
  ] })]));
  await vi.waitFor(() => { expect(body.querySelector('.cdp-risk-unknown')?.textContent).toBe('Unknown'); expect(body.querySelector('.cdp-risk-safe')?.textContent).toBe('Safe'); });
  expect(body.textContent).toContain('1 supplier(s) verified safe. 1 supplier(s) have no modeled route data.');
});
