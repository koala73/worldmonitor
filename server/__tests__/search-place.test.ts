import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { cache, limiter } = vi.hoisted(() => ({
  cache: new Map<string, unknown>(),
  limiter: vi.fn(async (_scope: string, _limit: number, _window: string, _identifier: string) => ({ allowed: true, degraded: false })),
}));
vi.mock('../_shared/rate-limit', () => ({ checkScopedRateLimit: limiter }));
vi.mock('../_shared/redis', () => ({
  getCachedJson: vi.fn(async (key: string) => cache.get(key) ?? null),
  setCachedJson: vi.fn(async (key: string, value: unknown) => { cache.set(key, value); }),
}));

import { normalizePlaceQuery, placeSearchCacheKey, searchPlace } from '../worldmonitor/infrastructure/v1/search-place';
import { setCachedJson } from '../_shared/redis';

const ctx = { request: new Request('https://worldmonitor.test') } as Parameters<typeof searchPlace>[0];
const rotterdam = [
  { lat: '51.9244', lon: '4.4777', display_name: 'Rotterdam, South Holland, Netherlands', addresstype: 'city', type: 'administrative' },
  { lat: 'not-a-number', lon: '4', display_name: 'Broken row' },
  { lat: '91', lon: '4', display_name: 'Off the globe' },
];

beforeEach(() => {
  cache.clear();
  limiter.mockResolvedValue({ allowed: true, degraded: false });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(rotterdam)));
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('place-name search', () => {
  it('asks Nominatim search once for a name and returns valid places only', async () => {
    const result = await searchPlace(ctx, { q: '  Rotterdam ' });
    expect(result).toEqual({ places: [{ name: 'Rotterdam, South Holland, Netherlands', lat: 51.9244, lon: 4.4777, kind: 'city' }], error: '' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    const requested = new URL(String(url));
    expect(requested.origin + requested.pathname).toBe('https://nominatim.openstreetmap.org/search');
    expect(requested.searchParams.get('q')).toBe('rotterdam');
    expect(requested.searchParams.get('limit')).toBe('5');
    expect((init as RequestInit).headers).toMatchObject({ 'User-Agent': expect.stringContaining('WorldMonitor') });
  });

  it('serves a repeat of the same name, in any case or spacing, from cache', async () => {
    await searchPlace(ctx, { q: 'Rotterdam' });
    const again = await searchPlace(ctx, { q: 'ROTTERDAM   ' });
    expect(again.places).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cache.has(placeSearchCacheKey(normalizePlaceQuery('rotterdam')))).toBe(true);
  });

  it('spends the shared one-per-second Nominatim bucket on a cache miss', async () => {
    await searchPlace(ctx, { q: 'Rotterdam' });
    expect(limiter).toHaveBeenCalledWith('reverse-geocode', 1, '1 s', 'global');
  });

  it('fails closed without calling Nominatim when the rate limiter is degraded or exhausted', async () => {
    limiter.mockResolvedValueOnce({ allowed: true, degraded: true });
    await expect(searchPlace(ctx, { q: 'Rotterdam' })).rejects.toMatchObject({ statusCode: 503 });
    limiter.mockResolvedValueOnce({ allowed: false, degraded: false });
    await expect(searchPlace(ctx, { q: 'Rotterdam' })).rejects.toMatchObject({ statusCode: 429 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a one-character name before any lookup', async () => {
    await expect(searchPlace(ctx, { q: ' x ' })).rejects.toMatchObject({ name: 'ValidationError', violations: [{ field: 'q' }] });
    expect(limiter).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports an upstream failure without caching it', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('busy', { status: 503 }));
    expect(await searchPlace(ctx, { q: 'Rotterdam' })).toEqual({ places: [], error: 'Place search failed' });
    expect(setCachedJson).not.toHaveBeenCalled();
  });
});
