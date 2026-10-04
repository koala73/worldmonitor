import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Replace only the transport under the real aviation service: the panel, the
// service wrappers, their circuit breakers and the generated client all run.
const transport = vi.hoisted(() => ({
  premiumFetch: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
}));
vi.mock('@/services/premium-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/premium-fetch')>()),
  premiumFetch: transport.premiumFetch,
}));

import { fetchGoogleDates, fetchGoogleFlights } from '@/services/aviation';
import { AirlineIntelPanel } from '@/components/AirlineIntelPanel';
import { initTestI18n } from './helpers/i18n.mts';

const HOSTILE = '<img src=x onerror="window.__pwned=1">';
const GOOGLE_PATH = /\/api\/aviation\/v1\/search-google-(flights|dates)/;

function googleCalls(): string[] {
  return transport.premiumFetch.mock.calls.map(([input]) => String(input)).filter((url) => GOOGLE_PATH.test(url));
}

async function mountPanel(): Promise<{ panel: AirlineIntelPanel; root: HTMLElement; content: HTMLElement }> {
  const panel = new AirlineIntelPanel();
  const root = panel.getElement();
  document.body.appendChild(root);
  panel.notifyConnected();
  const content = root.querySelector<HTMLElement>('.airline-intel-content')!;
  // Let the connect-time ops load settle so the loading view is gone.
  await vi.waitFor(() => expect(content.querySelector('.panel-loading')).toBeNull());
  return { panel, root, content };
}

function openPricesTab(root: HTMLElement, content: HTMLElement): void {
  root.querySelector<HTMLElement>('.panel-tab[data-tab="prices"]')!.click();
  expect(content.querySelector('[data-price-mode="search"]')).not.toBeNull();
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  document.body.replaceChildren();
  transport.premiumFetch.mockReset();
  transport.premiumFetch.mockImplementation(async () => Response.json({}));
});

describe('AirlineIntelPanel prices tab', () => {
  it('never fetches prices on tab switch, mode switch or refresh, only on an explicit search', async () => {
    const { panel, root, content } = await mountPanel();

    openPricesTab(root, content);
    content.querySelector<HTMLElement>('[data-price-mode="dates"]')!.click();
    content.querySelector<HTMLElement>('[data-price-mode="search"]')!.click();
    const refreshBtn = [...root.querySelectorAll<HTMLElement>('.icon-btn')].find((b) => b.textContent === '\u21BB');
    refreshBtn!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(content.querySelector('#priceSearchBtn')).not.toBeNull();
    expect(googleCalls()).toEqual([]);

    // Positive control: the harness does observe a Google Flights request.
    content.querySelector<HTMLElement>('#priceSearchBtn')!.click();
    await vi.waitFor(() => expect(googleCalls()).toHaveLength(1));
    expect(googleCalls()[0]).toContain('search-google-flights');
    panel.destroy();
  });

  it('renders server-supplied flight legs as text, not markup', async () => {
    transport.premiumFetch.mockImplementation(async (input) => {
      if (!String(input).includes('search-google-flights')) return Response.json({});
      return Response.json({
        flights: [{
          legs: [{
            airlineCode: HOSTILE, flightNumber: HOSTILE, departureAirport: HOSTILE, arrivalAirport: 'LHR',
            departureDatetime: '2026-10-05T08:00', arrivalDatetime: '2026-10-05T12:00', durationMinutes: 240,
          }],
          price: 321, durationMinutes: 240, stops: 0,
        }],
        degraded: false, error: '',
      });
    });
    const { panel, root, content } = await mountPanel();
    openPricesTab(root, content);
    content.querySelector<HTMLElement>('#priceSearchBtn')!.click();

    await vi.waitFor(() => expect(content.querySelector('.gf-leg')).not.toBeNull());
    expect(content.querySelector('.gf-leg img')).toBeNull();
    expect(content.querySelector('.gf-airline')!.textContent).toBe(`${HOSTILE} ${HOSTILE}`);
    panel.destroy();
  });

  it('renders server-supplied dates and a degraded error string as text, not markup', async () => {
    let datesBody: unknown = {
      dates: [{ date: HOSTILE, returnDate: HOSTILE, price: 99 }],
      degraded: false, error: '',
    };
    transport.premiumFetch.mockImplementation(async (input) => {
      if (!String(input).includes('search-google-dates')) return Response.json({});
      return Response.json(datesBody);
    });
    const { panel, root, content } = await mountPanel();
    openPricesTab(root, content);
    content.querySelector<HTMLElement>('[data-price-mode="dates"]')!.click();
    const today = new Date();
    const iso = (offsetDays: number) => new Date(today.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
    const fill = (start: string, end: string) => {
      content.querySelector<HTMLInputElement>('#datesStartInput')!.value = start;
      content.querySelector<HTMLInputElement>('#datesEndInput')!.value = end;
    };

    fill(iso(2), iso(12));
    content.querySelector<HTMLElement>('#datesSearchBtn')!.click();
    await vi.waitFor(() => expect(content.querySelector('.dp-row')).not.toBeNull());
    expect(content.querySelector('.dp-row img')).toBeNull();
    expect(content.querySelector('.dp-date')!.textContent).toBe(HOSTILE);
    expect(content.querySelector('.dp-return')!.textContent).toBe(HOSTILE);

    // A different range misses the 5-minute dates cache, so the error body is served.
    datesBody = { dates: [], degraded: true, error: HOSTILE };
    fill(iso(3), iso(13));
    content.querySelector<HTMLElement>('#datesSearchBtn')!.click();
    await vi.waitFor(() => expect(content.querySelector('.gf-degraded')).not.toBeNull());
    expect(content.querySelector('.no-data img')).toBeNull();
    expect(content.querySelector('.no-data')!.textContent).toBe(HOSTILE);
    panel.destroy();
  });
});

// Kept last: each failure counts toward its breaker's cooldown.
describe('Google Flights service wrappers', () => {
  it('fetchGoogleFlights returns the empty degraded fallback when the request fails', async () => {
    transport.premiumFetch.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(fetchGoogleFlights({ origin: 'IST', destination: 'LHR', departureDate: '2026-11-01' }))
      .resolves.toEqual({ flights: [], degraded: true, error: 'Request failed' });
    expect(googleCalls()).toHaveLength(1);
  });

  it('fetchGoogleDates returns the empty degraded fallback when the request fails', async () => {
    transport.premiumFetch.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(fetchGoogleDates({ origin: 'IST', destination: 'LHR', startDate: '2026-11-01', endDate: '2026-11-20' }))
      .resolves.toEqual({ dates: [], degraded: true, error: 'Request failed' });
    expect(googleCalls()).toHaveLength(1);
  });
});
