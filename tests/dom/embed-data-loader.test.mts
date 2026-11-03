import { afterEach, describe, expect, it, vi } from 'vitest';

import { EmbedDataLoader, type EmbedMapSurface } from '@/embed/embed-data-loader';
import {
  EmbedMapFrameUnavailableError,
  fetchEmbedMapFrame,
  mintEmbedGrant,
  type EmbedGrant,
  type EmbedGrantResult,
} from '@/embed/embed-fetch';
import type { MapLayers } from '@/types';
import { classifyPublicEmbedFrameRequest } from '../../shared/embed-map-frame';
import {
  EMBED_FREE_REFRESH_MS,
  EMBED_KEYED_REFRESH_MS,
  type EmbedLayerId,
} from '../../shared/embed-panels';
import type { EmbedMapFrameResponse } from '../../shared/embed-map-frame';

const NOW = 1_700_000_000_000;

interface RecordedMap extends EmbedMapSurface {
  conflicts: unknown[][];
  earthquakes: unknown[][];
  naturalEvents: unknown[][];
  protests: unknown[][];
  weather: unknown[][];
  ready: Map<string, boolean>;
  loading: string[];
  layers: MapLayers;
  bypassEntitlementSanitization: boolean;
}

function recordingMap(): RecordedMap {
  const map: RecordedMap = {
    conflicts: [],
    earthquakes: [],
    naturalEvents: [],
    protests: [],
    weather: [],
    ready: new Map(),
    loading: [],
    layers: {} as MapLayers,
    bypassEntitlementSanitization: false,
    supportsLiveConflictEvents: () => true,
    setConflictEvents: (events) => { map.conflicts.push(events); },
    setEarthquakes: (events) => { map.earthquakes.push(events); },
    setNaturalEvents: (events) => { map.naturalEvents.push(events); },
    setProtests: (events) => { map.protests.push(events); },
    setWeatherAlerts: (alerts) => { map.weather.push(alerts); },
    setLayerLoading: (layer, loading) => { map.loading.push(`${String(layer)}:${loading}`); },
    setLayerReady: (layer, ready) => { map.ready.set(String(layer), ready); },
    getState: () => ({ layers: map.layers }),
    setLayers: (layers, options) => {
      map.layers = layers;
      map.bypassEntitlementSanitization = options?.bypassEntitlementSanitization === true;
    },
  };
  return map;
}

function frame(overrides: Partial<EmbedMapFrameResponse> = {}): EmbedMapFrameResponse {
  return {
    tier: 'free',
    refreshMs: EMBED_FREE_REFRESH_MS,
    generatedAt: NOW,
    layers: { conflicts: 'ok', earthquakes: 'ok', weather: 'ok' },
    data: {
      conflicts: [{ id: 'c1' }],
      earthquakes: [{ id: 'q1' }],
      naturalEvents: [],
      weatherAlerts: [],
    },
    ...overrides,
  };
}

function grant(expiresAt: number): EmbedGrant {
  return { token: 'wmg_test', expiresAt };
}

/**
 * A wire-shaped unrest event. The loader runs the real `toSocialUnrestEvent`
 * adapter on this payload, so a thin `{ id }` stub would throw inside the
 * mapper rather than exercise the loader.
 */
function protestEvent() {
  return {
    id: 'p1',
    title: 'Protest',
    summary: '',
    eventType: 'UNREST_EVENT_TYPE_PROTEST',
    city: '',
    country: 'FR',
    region: '',
    location: { latitude: 48.85, longitude: 2.35 },
    occurredAt: NOW,
    severity: 'SEVERITY_LEVEL_LOW',
    fatalities: 0,
    sources: [],
    sourceUrls: [],
    sourceType: 'UNREST_SOURCE_TYPE_ACLED',
    tags: [],
    actors: [],
    confidence: 'CONFIDENCE_LEVEL_HIGH',
  };
}

describe('embed map frame request', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function captureUrl(): { urls: string[]; headers: Record<string, string>[] } {
    const urls: string[] = [];
    const headers: Record<string, string>[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      headers.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify(frame()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    return { urls, headers };
  }

  it('emits a keyless URL the edge will shared-cache', async () => {
    // Builder and validator are the same module, so this proves the URL the
    // client actually sends is the one that gets a shared entry — the failure
    // mode is silent: a near-miss still renders, just never from cache.
    const { urls, headers } = captureUrl();
    await fetchEmbedMapFrame(['weather', 'conflicts'], null);

    expect(urls[0]).toContain('?layers=conflicts,weather&public=1');
    expect(classifyPublicEmbedFrameRequest(urls[0] as string)).toEqual(['conflicts', 'weather']);
    expect(headers[0]).not.toHaveProperty('X-WorldMonitor-Grant');
  });

  it('drops paid layers from the keyless URL instead of fragmenting the key space', async () => {
    const { urls } = captureUrl();
    await fetchEmbedMapFrame(['conflicts', 'protests', 'cables'], null);

    expect(urls[0]).toContain('?layers=conflicts&public=1');
    expect(classifyPublicEmbedFrameRequest(urls[0] as string)).toEqual(['conflicts']);
  });

  it('sends the grant on a URL that can never be shared-cached', async () => {
    const { urls, headers } = captureUrl();
    await fetchEmbedMapFrame(['conflicts', 'protests'], { token: 'wmg_x', expiresAt: NOW });

    expect(headers[0]).toMatchObject({ 'X-WorldMonitor-Grant': 'wmg_x' });
    expect(urls[0]).not.toContain('public=1');
    expect(
      classifyPublicEmbedFrameRequest(urls[0] as string),
      'a credentialed URL must never match the shared shape',
    ).toBeNull();
  });

  it('keeps rate limits and server failures retryable', async () => {
    vi.stubGlobal('fetch', async () => new Response('', {
      status: 429,
      headers: { 'Retry-After': '7' },
    }));
    await expect(mintEmbedGrant('map', 'wme_test')).resolves.toEqual({
      status: 'unavailable',
      retryAfterMs: 7_000,
    });

    vi.stubGlobal('fetch', async () => new Response('', { status: 500 }));
    await expect(mintEmbedGrant('map', 'wme_test')).resolves.toEqual({
      status: 'unavailable',
      retryAfterMs: 60_000,
    });
  });

  it('surfaces a bounded retry delay for an unavailable map frame', async () => {
    vi.stubGlobal('fetch', async () => new Response('', {
      status: 503,
      headers: { 'Retry-After': '3600' },
    }));

    await expect(fetchEmbedMapFrame(['conflicts'], grant(NOW + 30 * 60_000))).rejects.toMatchObject({
      retryAfterMs: 60_000,
    });
  });
});

describe('embed data loader', () => {
  it('renders the free tier from one request and marks its layers ready', async () => {
    const map = recordingMap();
    const seen: (EmbedGrant | null)[] = [];
    const loader = new EmbedDataLoader(map, ['conflicts', 'earthquakes', 'weather'], {
      fetchFrame: async (_layers, g) => { seen.push(g); return frame(); },
      now: () => NOW,
    });

    await loader.loadOnce();

    expect(seen, 'a keyless frame sends no grant').toEqual([null]);
    expect(map.conflicts).toEqual([[{ id: 'c1' }]]);
    expect(map.ready.get('conflicts')).toBe(true);
    expect(map.ready.get('natural')).toBe(true);
    expect(map.ready.get('weather')).toBe(true);
  });

  it('requests every active layer in one call, not one call per layer', async () => {
    const map = recordingMap();
    let calls = 0;
    let requested: readonly EmbedLayerId[] = [];
    const loader = new EmbedDataLoader(map, ['conflicts', 'weather', 'cables'], {
      fetchFrame: async (layers) => {
        calls += 1;
        requested = layers;
        return frame({ layers: { conflicts: 'ok', weather: 'ok', cables: 'ok' } });
      },
      now: () => NOW,
    });

    await loader.loadOnce();

    expect(calls).toBe(1);
    expect([...requested]).toEqual(['conflicts', 'weather', 'cables']);
  });

  it('withholds conflict events from a renderer that cannot draw them', async () => {
    // The DeckGL and globe renderers return false here. That rule used to be
    // enforced at the fetch step — the embed simply never called the ACLED RPC
    // — and e2e/embed.spec.ts watched the wire for it. The composed endpoint
    // moved it: one request carries every active layer whatever the renderer
    // is, so the only place the rule still lives is applyFrame, and the only
    // place it can be observed is here.
    const map = recordingMap();
    map.supportsLiveConflictEvents = () => false;
    const loader = new EmbedDataLoader(map, ['conflicts', 'earthquakes'], {
      fetchFrame: async () => frame(),
      now: () => NOW,
    });

    await loader.loadOnce();

    expect(map.conflicts, 'a canvas renderer must not receive live conflict events').toHaveLength(0);
    expect(map.earthquakes, 'every other layer still applies').toEqual([[{ id: 'q1' }]]);
  });

  it('disables a rejected layer and clears its cached live data', async () => {
    const map = recordingMap();
    map.layers = { conflicts: true, protests: true } as MapLayers;
    let request = 0;
    const loader = new EmbedDataLoader(map, ['conflicts', 'protests'], {
      fetchFrame: async () => {
        request += 1;
        return request === 1
          ? frame({
            layers: { conflicts: 'ok', protests: 'ok' },
            data: { conflicts: [{ id: 'c1' }], protests: [protestEvent()] },
          })
          : frame({
            layers: { conflicts: 'ok', protests: 'not-entitled' },
            data: { conflicts: [{ id: 'c1' }] },
          });
      },
      now: () => NOW,
    });

    await loader.loadOnce();
    await loader.loadOnce();

    expect(map.ready.get('conflicts')).toBe(true);
    expect(map.ready.get('protests')).toBe(false);
    expect(map.layers.protests).toBe(false);
    expect(map.bypassEntitlementSanitization).toBe(true);
    expect(map.protests).toHaveLength(2);
    expect(map.protests[map.protests.length - 1]).toEqual([]);
  });

  it('keeps a partial layer on the map and drops an unavailable one', async () => {
    const map = recordingMap();
    const loader = new EmbedDataLoader(map, ['earthquakes', 'weather'], {
      fetchFrame: async () => frame({
        layers: { earthquakes: 'partial', weather: 'unavailable' },
        data: { earthquakes: [{ id: 'q1' }] },
      }),
      now: () => NOW,
    });

    await loader.loadOnce();

    expect(map.ready.get('natural'), 'partial still has data on screen').toBe(true);
    expect(map.ready.get('weather')).toBe(false);
  });

  it('leaves the previous frame up when a poll fails outright', async () => {
    const map = recordingMap();
    let attempt = 0;
    const loader = new EmbedDataLoader(map, ['conflicts'], {
      fetchFrame: async () => {
        attempt += 1;
        if (attempt === 1) return frame({ layers: { conflicts: 'ok' } });
        throw new Error('network down');
      },
      now: () => NOW,
    });

    await loader.loadOnce();
    await loader.loadOnce();

    expect(map.conflicts, 'no second render').toHaveLength(1);
    expect(map.ready.get('conflicts'), 'the layer stays marked ready').toBe(true);
    expect(map.loading[map.loading.length - 1], 'the loading flag still clears').toBe('conflicts:false');
  });

  it('keeps a paid frame and retries a retryable frame failure before the free cadence', async () => {
    vi.useFakeTimers();
    try {
      const map = recordingMap();
      let attempts = 0;
      const loader = new EmbedDataLoader(map, ['conflicts'], {
        fetchFrame: async () => {
          attempts += 1;
          if (attempts === 1) return frame({ tier: 'keyed', refreshMs: EMBED_KEYED_REFRESH_MS });
          if (attempts === 2) throw new EmbedMapFrameUnavailableError(10_000);
          return frame({ tier: 'keyed', refreshMs: EMBED_KEYED_REFRESH_MS });
        },
        now: () => NOW,
      });

      await loader.upgrade(grant(NOW + 30 * 60_000));
      await loader.loadOnce();
      expect(attempts).toBe(2);
      expect(map.ready.get('conflicts')).toBe(true);

      await vi.advanceTimersByTimeAsync(9_999);
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(3);
      loader.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('upgrades in place: the grant reaches the next request and unlocks the paid layer', async () => {
    const map = recordingMap();
    const seen: (EmbedGrant | null)[] = [];
    const loader = new EmbedDataLoader(map, ['conflicts', 'protests'], {
      fetchFrame: async (_layers, g) => {
        seen.push(g);
        return g
          ? frame({
            tier: 'keyed',
            refreshMs: EMBED_KEYED_REFRESH_MS,
            layers: { conflicts: 'ok', protests: 'ok' },
            data: { conflicts: [], protests: [protestEvent()] },
          })
          : frame({ layers: { conflicts: 'ok', protests: 'not-entitled' }, data: { conflicts: [] } });
      },
      now: () => NOW,
    });

    await loader.loadOnce();
    expect(map.ready.get('protests')).toBe(false);

    await loader.upgrade(grant(NOW + 30 * 60_000));
    loader.destroy();

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeNull();
    expect(seen[1]?.token).toBe('wmg_test');
    expect(map.ready.get('protests'), 'the paid layer appears after the upgrade').toBe(true);
    expect(map.protests[map.protests.length - 1]).toHaveLength(1);
  });

  it('takes its cadence from the response rather than a client constant', async () => {
    const map = recordingMap();
    const cadences: number[] = [];
    const loader = new EmbedDataLoader(map, ['conflicts'], {
      fetchFrame: async (_layers, g) => {
        const next = g
          ? frame({ tier: 'keyed', refreshMs: EMBED_KEYED_REFRESH_MS, layers: { conflicts: 'ok' } })
          : frame({ layers: { conflicts: 'ok' } });
        cadences.push(next.refreshMs);
        return next;
      },
      now: () => NOW,
    });

    await loader.loadOnce();
    await loader.upgrade(grant(NOW + 30 * 60_000));
    loader.destroy();

    expect(EMBED_FREE_REFRESH_MS).not.toBe(EMBED_KEYED_REFRESH_MS);
    expect(cadences).toEqual([EMBED_FREE_REFRESH_MS, EMBED_KEYED_REFRESH_MS]);
  });

  it('retries an unavailable initial grant exchange after its advertised delay', async () => {
    vi.useFakeTimers();
    try {
      const map = recordingMap();
      let renewals = 0;
      const loader = new EmbedDataLoader(map, ['conflicts'], {
        fetchFrame: async () => frame({ layers: { conflicts: 'ok' } }),
        renewGrant: async (): Promise<EmbedGrantResult> => {
          renewals += 1;
          return renewals === 1
            ? { status: 'unavailable', retryAfterMs: 10_000 }
            : { status: 'granted', grant: grant(NOW + 30 * 60_000) };
        },
        now: () => NOW,
      });

      await loader.requestGrant();
      expect(renewals).toBe(1);
      expect(loader.currentGrant()).toBeNull();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(renewals).toBe(2);
      expect(loader.currentGrant()?.token).toBe('wmg_test');
      loader.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  describe('grant renewal', () => {
    it('re-mints before expiry and polls with the fresh grant', async () => {
      const map = recordingMap();
      const seen: (EmbedGrant | null)[] = [];
      let renewals = 0;
      const loader = new EmbedDataLoader(map, ['conflicts'], {
        fetchFrame: async (_layers, g) => { seen.push(g); return frame({ layers: { conflicts: 'ok' } }); },
        renewGrant: async (): Promise<EmbedGrantResult> => {
          renewals += 1;
          return { status: 'granted', grant: { token: 'wmg_fresh', expiresAt: NOW + 30 * 60_000 } };
        },
        now: () => NOW,
      });

      // Expires in 30s — inside the renewal skew.
      await loader.upgrade(grant(NOW + 30_000));
      loader.destroy();
      await loader.loadOnce();

      expect(renewals).toBe(1);
      expect(seen[seen.length - 1]?.token).toBe('wmg_fresh');
    });

    it('holds the last frame rather than downgrading when renewal is unavailable', async () => {
      const map = recordingMap();
      let polls = 0;
      let clock = NOW;
      const loader = new EmbedDataLoader(map, ['conflicts', 'protests'], {
        fetchFrame: async () => {
          polls += 1;
          return frame({
            tier: 'keyed',
            layers: { conflicts: 'ok', protests: 'ok' },
            data: { conflicts: [], protests: [protestEvent()] },
          });
        },
        renewGrant: async (): Promise<EmbedGrantResult> => ({ status: 'unavailable', retryAfterMs: 60_000 }),
        now: () => clock,
      });

      // A paid frame is on screen and rendering all fourteen layers.
      await loader.upgrade(grant(NOW + 30 * 60_000));
      loader.destroy();
      expect(map.ready.get('protests')).toBe(true);
      const pollsWhileEntitled = polls;

      // The grant lapses and the billing lookup cannot be reached.
      clock = NOW + 31 * 60_000;
      await loader.loadOnce();

      expect(polls, 'the poll is skipped, not downgraded').toBe(pollsWhileEntitled);
      expect(
        map.ready.get('protests'),
        'the paid layer stays on screen through a transient billing outage',
      ).toBe(true);
    });

    it('does not renew again before an unavailable response permits it', async () => {
      const map = recordingMap();
      let clock = NOW;
      let renewals = 0;
      const loader = new EmbedDataLoader(map, ['conflicts'], {
        fetchFrame: async () => frame({ layers: { conflicts: 'ok' } }),
        renewGrant: async (): Promise<EmbedGrantResult> => {
          renewals += 1;
          return renewals === 1
            ? { status: 'unavailable', retryAfterMs: 10_000 }
            : { status: 'granted', grant: grant(NOW + 30 * 60_000) };
        },
        now: () => clock,
      });

      await loader.upgrade(grant(NOW + 30_000));
      clock = NOW + 9_999;
      await loader.loadOnce();
      expect(renewals).toBe(1);

      clock = NOW + 10_000;
      await loader.loadOnce();
      expect(renewals).toBe(2);
    });

    it('falls back to the free tier when renewal is terminally denied', async () => {
      const map = recordingMap();
      const seen: (EmbedGrant | null)[] = [];
      const loader = new EmbedDataLoader(map, ['conflicts', 'protests'], {
        fetchFrame: async (_layers, g) => {
          seen.push(g);
          return g
            ? frame({ tier: 'keyed', layers: { conflicts: 'ok', protests: 'ok' }, data: { conflicts: [], protests: [] } })
            : frame({ layers: { conflicts: 'ok', protests: 'not-entitled' }, data: { conflicts: [] } });
        },
        renewGrant: async (): Promise<EmbedGrantResult> => ({ status: 'denied' }),
        now: () => NOW,
      });

      await loader.upgrade(grant(NOW - 1));
      loader.destroy();
      await loader.loadOnce();

      expect(seen[seen.length - 1], 'a lapsed account polls as keyless').toBeNull();
      expect(loader.currentGrant()).toBeNull();
      expect(map.ready.get('protests')).toBe(false);
    });

    it('does not re-mint a grant that is still comfortably valid', async () => {
      const map = recordingMap();
      let renewals = 0;
      const loader = new EmbedDataLoader(map, ['conflicts'], {
        fetchFrame: async () => frame({ layers: { conflicts: 'ok' } }),
        renewGrant: async (): Promise<EmbedGrantResult> => {
          renewals += 1;
          return { status: 'granted', grant: grant(NOW + 30 * 60_000) };
        },
        now: () => NOW,
      });

      await loader.upgrade(grant(NOW + 25 * 60_000));
      loader.destroy();
      await loader.loadOnce();

      expect(renewals).toBe(0);
    });
  });
});
