import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FoodPricesCard } from '@/components/FoodPricesCard';
import { initTestI18n } from './helpers/i18n.mts';
import type { FoodPriceSource } from '@/generated/client/worldmonitor/economic/v1/service_client';

const row = { item: '<img src=x onerror=alert(1)>', market: 'Market', marketType: 'retail', origin: '', unit: 'kg', currency: 'PHP', price: 55, date: '2026-10-29', wowAvailable: false, wowPct: 0, previousDate: '', previousPrice: 0 };
const source = (overrides: Partial<FoodPriceSource> = {}): FoodPriceSource => ({
  id: 'da', name: 'DA', country: 'Philippines', countryCode: 'PH', url: 'https://www.da.gov.ph/price-monitoring/', cadence: 'daily', contextOnly: false,
  fetchedAt: '2026-10-29T12:00:00Z', latestReportDate: '2026-10-29', status: 'current', prices: [row], contexts: [], ...overrides,
});
let host: HTMLElement;
beforeAll(initTestI18n);
beforeEach(() => { host = document.createElement('div'); document.body.replaceChildren(host); });

describe('official food prices card', () => {
  it('shows missing baseline rather than a zero change and inserts source strings as text', () => {
    new FoodPricesCard(host).update([source()]);
    expect(host.textContent).toContain('Prior week unavailable');
    expect(host.textContent).toContain(row.item);
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).not.toContain('0.0%');
    expect(host.textContent).toContain('55 PHP');
    expect(host.textContent).toContain('2026-10-29');
  });
  it('switches countries and markets without mixing retail and wholesale prices', () => {
    new FoodPricesCard(host).update([source(), source({ id: 'cbsl', country: 'Sri Lanka', prices: [
      { ...row, item: 'Beans', price: 500, currency: 'LKR', marketType: 'wholesale', wowAvailable: true, wowPct: 10, previousDate: '2026-10-22', previousPrice: 454.55 },
      { ...row, item: 'Beans retail', price: 550, currency: 'LKR' },
    ] })]);
    const country = host.querySelector('select')!;
    country.value = 'cbsl'; country.dispatchEvent(new Event('change'));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Country');
    expect(host.textContent).toContain('500 LKR');
    expect(host.textContent).not.toContain('550 LKR');
    expect(host.textContent).toContain('+10.0%');
    const market = host.querySelectorAll('select')[1]!;
    market.selectedIndex = 1; market.dispatchEvent(new Event('change'));
    expect(host.textContent).toContain('550 LKR');
    expect(host.textContent).not.toContain('500 LKR');
  });
  it('shows stale source dates, unavailable slots, and monthly context without weekly percentages', () => {
    new FoodPricesCard(host).update([source({ status: 'stale' }), source({ id: 'onagri', name: 'ONAGRI', country: 'Tunisia', contextOnly: true, latestReportDate: '2026-07-01', prices: [{ ...row, item: 'Figs', wowAvailable: true, wowPct: 99 }] }),
      source({ id: 'giews', name: 'GIEWS', contextOnly: true, prices: [], contexts: [{ country: 'Malaysia', countryCode: 'MYS', referenceDate: '', status: 'unavailable', fetchedAt: '', title: 'Country brief', url: 'javascript:alert(1)' }] })]);
    expect(host.textContent).toContain('Older data');
    expect(host.querySelector('details')?.textContent).toContain('2026-07-01');
    expect(host.querySelector('details')?.textContent).not.toContain('99.0%');
    expect(host.querySelector('details a')?.hasAttribute('href')).toBe(false);
    expect(host.textContent).toContain('Unavailable');
  });
  it('can retry after transport failure and recover', () => {
    const card = new FoodPricesCard(host);
    card.showError(() => card.update([source()]));
    host.querySelector('button')!.click();
    expect(host.textContent).toContain('55 PHP');
  });
});

it('keeps the context disclosure and keyboard focus through updates', () => {
  const card = new FoodPricesCard(host);
  const sources = [source(), source({ id: 'cbsl', country: 'Sri Lanka' })];
  card.update(sources);
  host.querySelector('details')!.open = true;
  const country = host.querySelector('select')!;
  country.focus();
  card.update(sources);
  expect(host.querySelector('details')!.open).toBe(true);
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Country');
  const select = host.querySelector('select')!;
  select.value = 'cbsl'; select.dispatchEvent(new Event('change'));
  expect(host.querySelector('details')!.open).toBe(true);
});

it('preserves the three-decimal precision of Tunisian dinar prices', () => {
  new FoodPricesCard(host).update([source({ id: 'onagri', country: 'Tunisia', contextOnly: true, prices: [{ ...row, price: 0.574, currency: 'TND' }] })]);
  expect(host.textContent).toContain('0.574 TND');
});

it('restores focus to the Tunisia table rather than the weekly table after refresh', () => {
  const card = new FoodPricesCard(host);
  const sources = [source(), source({ id: 'onagri', country: 'Tunisia', contextOnly: true })];
  card.update(sources);
  host.querySelector('details')!.open = true;
  host.querySelector<HTMLElement>('details [role="region"]')!.focus();
  card.update(sources);
  expect(document.activeElement).toBe(host.querySelector('details [role="region"]'));
  expect(host.querySelector('details')!.open).toBe(true);
});
