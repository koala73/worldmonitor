import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NOW = Date.UTC(2026, 10, 13, 12);
const DAY = 86_400_000;
const WINDOW = { startMs: NOW - 7 * DAY, endMs: NOW + 3 * DAY };
const palmJumeirah = { lat: 25.112, lon: 55.139 };

const outageFeed = vi.hoisted(() => ({
  outages: [] as Array<{ id: string; lat: number; lon: number; title: string; country: string; pubDate: Date }>,
  mode: 'live' as 'live' | 'cached' | 'unavailable',
}));

vi.mock('@/services/infrastructure', () => ({
  fetchInternetOutages: async () => outageFeed.outages,
  getOutagesDataState: () => ({ mode: outageFeed.mode, timestamp: null, offline: false }),
}));

vi.mock('@/services/country-geometry', () => ({
  getCountryAtCoordinates: () => ({ code: 'AE', name: 'United Arab Emirates' }),
  nameToCountryCode: (name: string) => ({ 'united arab emirates': 'AE', iran: 'IR' } as Record<string, string>)[name.toLowerCase()] ?? null,
}));

const { loadPointContext } = await import('@/services/orbital/point-context');

const outage = (id: string, country: string) =>
  ({ id, lat: 24.4, lon: 54.4, title: `Internet disruption in ${country}`, country, pubDate: new Date(NOW - DAY) });

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  outageFeed.outages = [];
  outageFeed.mode = 'live';
});

describe('outage feed around a picked point', () => {
  it('keeps a national outage the feed names by country, and drops one in another country', async () => {
    outageFeed.outages = [outage('ae', 'United Arab Emirates'), outage('ir', 'Iran')];
    const { events } = await loadPointContext(palmJumeirah, WINDOW, NOW);
    expect(events.outages.status === 'ok' && events.outages.events.map((e) => e.id)).toEqual(['ae']);
  });

  it('shows a failed outage feed as unavailable rather than as missing history', async () => {
    outageFeed.mode = 'unavailable';
    const { events } = await loadPointContext(palmJumeirah, WINDOW, NOW);
    expect(events.outages).toEqual({ status: 'unavailable' });
  });

  it('treats an empty answer from a healthy outage feed as a quiet week', async () => {
    const { events } = await loadPointContext(palmJumeirah, WINDOW, NOW);
    expect(events.outages.status).toBe('ok');
  });
});
