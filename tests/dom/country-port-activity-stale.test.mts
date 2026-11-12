import { beforeAll, describe, expect, it } from 'vitest';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import type { CountryPortActivityData } from '@/components/CountryBriefPanel';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => { await initTestI18n(); });

function data(overrides: Partial<CountryPortActivityData> = {}): CountryPortActivityData {
  return {
    available: true,
    fetchedAt: '2026-10-22T06:00:00.000Z',
    ports: [{
      portId: 'PE-1', portName: 'Callao', lat: -12.05, lon: -77.15,
      tankerCalls30d: 41, trendDeltaPct: 3.2, importTankerDwt: 1_200_000, exportTankerDwt: 300_000, anomalySignal: false,
    }],
    ...overrides,
  };
}

function render(input: CountryPortActivityData): HTMLElement {
  const body = document.createElement('div');
  const panel = Object.create(CountryDeepDivePanel.prototype) as CountryDeepDivePanel;
  Reflect.set(panel, 'maritimeBody', body);
  panel.updateMaritimeActivity(input);
  return body;
}

describe('country maritime activity staleness', () => {
  it('renders current data with its date and no stale note', () => {
    const body = render(data({ stale: false }));
    expect(body.querySelector('.cdp-maritime-port')?.textContent).toBe('Callao');
    expect(body.querySelector('.cdp-section-source')?.textContent).toBe('Source: IMF PortWatch · as of 2026-10-22');
    expect(body.querySelector('.cdp-maritime-stale')).toBeNull();
  });

  // 2026-11-01: IMF PortWatch rejected refreshes for ten countries; the API
  // now serves their last data for up to 30 days and flags it stale.
  it('keeps the table and says plainly that the figures are out of date', () => {
    const body = render(data({ stale: true }));
    expect(body.querySelector('.cdp-maritime-port')?.textContent).toBe('Callao');
    expect(body.querySelector('.cdp-maritime-stale')?.textContent)
      .toBe('Out of date: IMF PortWatch has not updated this country for over a week. These are the latest figures available.');
    expect(body.querySelector('.cdp-section-source')?.textContent).toBe('Source: IMF PortWatch · as of 2026-10-22');
  });

  it('shows the empty state when nothing is available', () => {
    const body = render({ available: false, ports: [], fetchedAt: '', stale: false });
    expect(body.textContent).toContain('No maritime activity data available for this country.');
    expect(body.querySelector('.cdp-maritime-stale')).toBeNull();
  });
});
