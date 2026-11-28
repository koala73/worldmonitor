/**
 * Build-time switches that keep a self-hosted dashboard from loading
 * third-party origins in the browser (#11477). Each switch defaults to the
 * hosted behaviour; setting it suppresses the load.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/after-paint', () => ({
  scheduleAfterFirstPaint: (fn: () => void) => fn(),
}));

const UMAMI_SCRIPT_SRC = 'https://abacus.worldmonitor.app/script.js';
const CDN_OVERRIDES_URL = 'https://maps.worldmonitor.app/country-boundary-overrides.geojson';
const BUNDLED_OVERRIDES_URL = '/data/country-boundary-overrides.geojson';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function appendedScriptSources(): Promise<string[]> {
  const append = vi.spyOn(document.head, 'appendChild').mockImplementation((node) => node);
  const { initAnalytics } = await import('@/services/analytics');
  initAnalytics();
  return append.mock.calls
    .map(([node]) => node)
    .filter((node): node is HTMLScriptElement => node instanceof HTMLScriptElement)
    .map((script) => script.src);
}

describe('VITE_ANALYTICS_ENABLED', () => {
  it('loads the Umami script when unset', async () => {
    expect(await appendedScriptSources()).toContain(UMAMI_SCRIPT_SRC);
  });

  it('never loads the Umami script when set to false', async () => {
    vi.stubEnv('VITE_ANALYTICS_ENABLED', 'false');
    expect(await appendedScriptSources()).not.toContain(UMAMI_SCRIPT_SRC);
  });
});

describe('VITE_LIVE_MEDIA_PANELS_ENABLED', () => {
  const LIVE_MEDIA_DEFAULTS: Array<[string, string]> = [
    ['full', 'live-news'],
    ['full', 'live-webcams'],
    ['tech', 'live-news'],
    ['tech', 'live-webcams'],
    ['finance', 'live-news'],
    ['finance', 'live-webcams'],
    ['commodity', 'live-news'],
    ['energy', 'live-news'],
  ];

  it('enables the live media panels by default when unset', async () => {
    const panels = await import('@/config/panels');
    for (const [variant, key] of LIVE_MEDIA_DEFAULTS) {
      expect(panels.getInitialPanelSettingsForVariant(variant)[key]?.enabled, `${variant}/${key}`).toBe(true);
    }
  });

  it('ships every live media panel disabled when set to false', async () => {
    vi.stubEnv('VITE_LIVE_MEDIA_PANELS_ENABLED', 'false');
    const panels = await import('@/config/panels');
    for (const [variant, key] of LIVE_MEDIA_DEFAULTS) {
      expect(panels.getInitialPanelSettingsForVariant(variant)[key]?.enabled, `${variant}/${key}`).toBe(false);
    }
    expect(panels.getInitialPanelSettingsForVariant('full').map?.enabled).toBe(true);
  });
});

describe('VITE_COUNTRY_OVERRIDES_URL', () => {
  async function requestedUrls(): Promise<string[]> {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const { preloadCountryGeometry } = await import('@/services/country-geometry');
    await preloadCountryGeometry();
    return urls;
  }

  it('fetches overrides from the CDN when unset', async () => {
    expect(await requestedUrls()).toContain(CDN_OVERRIDES_URL);
  });

  it('keeps the CDN default when a build arg passes an empty value', async () => {
    vi.stubEnv('VITE_COUNTRY_OVERRIDES_URL', '');
    expect(await requestedUrls()).toContain(CDN_OVERRIDES_URL);
  });

  it('fetches the bundled same-origin copy instead of the CDN when set', async () => {
    vi.stubEnv('VITE_COUNTRY_OVERRIDES_URL', BUNDLED_OVERRIDES_URL);
    const urls = await requestedUrls();
    expect(urls).toContain(BUNDLED_OVERRIDES_URL);
    expect(urls).not.toContain(CDN_OVERRIDES_URL);
  });
});
