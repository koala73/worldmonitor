import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMapUrlState,
  buildMapUrl,
  readDashboardSearchQuery,
  DASHBOARD_SEARCH_QUERY_MAX_CHARS,
  withMapCentreOf,
  withUrlFragment,
  withoutVariantScopedUrlState,
  buildOrbitalShareFragment,
  parseOrbitalShareFragment,
  withoutOrbitalShareFragment,
} from '../src/utils/urlState.ts';
import { redactSensitiveUrl, scrubSentryCredentials } from '../shared/sensitive-url-params.ts';
import { LAYER_REGISTRY } from '../src/config/map-layer-definitions.ts';

const EMPTY_LAYERS = {
  conflicts: false, bases: false, cables: false, pipelines: false,
  hotspots: false, ais: false, nuclear: false, irradiators: false,
  sanctions: false, weather: false, economic: false, waterways: false,
  outages: false, cyberThreats: false, datacenters: false, protests: false,
  flights: false, military: false, natural: false, spaceports: false,
  minerals: false, fires: false, ucdpEvents: false, displacement: false,
  climate: false, startupHubs: false, cloudRegions: false,
  accelerators: false, techHQs: false, techEvents: false,
  tradeRoutes: false, iranAttacks: false, gpsJamming: false,
};

// The URL layer list was a hand-kept copy that fell behind the registry, so a
// `?layers=diseaseOutbreaks` link loaded with the layer off and the URL sync
// rewrote it to `layers=none`. Every registered layer must survive a round trip.
describe('every registered map layer survives the URL', () => {
  const keys = Object.keys(LAYER_REGISTRY) as Array<keyof typeof LAYER_REGISTRY>;

  it('parses each layer from ?layers=', () => {
    const dropped = keys.filter((key) => parseMapUrlState(`?layers=${key}`, EMPTY_LAYERS).layers?.[key] !== true);
    assert.deepEqual(dropped, []);
  });

  it('writes each enabled layer back to the URL', () => {
    const dropped = keys.filter((key) => {
      const url = buildMapUrl('https://worldmonitor.app/dashboard', {
        view: 'global', zoom: 2, center: { lat: 0, lon: 0 }, timeRange: '24h',
        layers: { ...EMPTY_LAYERS, [key]: true },
      });
      return !(new URL(url).searchParams.get('layers') ?? '').split(',').includes(key);
    });
    assert.deepEqual(dropped, []);
  });
});

describe('parseMapUrlState expanded param', () => {
  it('parses legacy root dashboard deep links with disabled layers', () => {
    const state = parseMapUrlState(
      '?lat=24.5564&lon=11.9743&zoom=2.65&view=global&timeRange=7d&layers=none',
      EMPTY_LAYERS,
    );
    assert.equal(state.lat, 24.5564);
    assert.equal(state.lon, 11.9743);
    assert.equal(state.zoom, 2.65);
    assert.equal(state.view, 'global');
    assert.equal(state.timeRange, '7d');
    assert.ok(state.layers);
    assert.ok(Object.values(state.layers).every((enabled) => enabled === false));
  });

  it('parses expanded=1 as true', () => {
    const state = parseMapUrlState('?country=IR&expanded=1', EMPTY_LAYERS);
    assert.equal(state.country, 'IR');
    assert.equal(state.expanded, true);
  });

  it('parses missing expanded as undefined', () => {
    const state = parseMapUrlState('?country=IR', EMPTY_LAYERS);
    assert.equal(state.country, 'IR');
    assert.equal(state.expanded, undefined);
  });

  it('ignores expanded=0', () => {
    const state = parseMapUrlState('?country=IR&expanded=0', EMPTY_LAYERS);
    assert.equal(state.expanded, undefined);
  });
});

describe('parseMapUrlState coordinates at zero', () => {
  it('preserves zero latitude and longitude from a deep link', () => {
    const state = parseMapUrlState('?lat=0&lon=0&zoom=4', EMPTY_LAYERS);
    assert.equal(state.lat, 0);
    assert.equal(state.lon, 0);
    assert.equal(state.zoom, 4);
  });

  it('ignores blank and non-numeric coordinates', () => {
    const state = parseMapUrlState('?lat=%20&lon=nope', EMPTY_LAYERS);
    assert.equal(state.lat, undefined);
    assert.equal(state.lon, undefined);
  });
});

describe('readDashboardSearchQuery', () => {
  it('reads a SearchAction term from ?q=', () => {
    assert.equal(readDashboardSearchQuery('?q=hormuz%20strait'), 'hormuz strait');
  });

  it('trims whitespace and ignores empty values', () => {
    assert.equal(readDashboardSearchQuery('?q=%20%20'), null);
    assert.equal(readDashboardSearchQuery('?q='), null);
    assert.equal(readDashboardSearchQuery('?country=IR'), null);
  });

  it('caps oversized pasted queries', () => {
    const oversized = 'a'.repeat(DASHBOARD_SEARCH_QUERY_MAX_CHARS + 25);
    assert.equal(
      readDashboardSearchQuery(`?q=${oversized}`)?.length,
      DASHBOARD_SEARCH_QUERY_MAX_CHARS,
    );
  });
});

describe('parseMapUrlState chokepoint param', () => {
  it('parses a canonical chokepoint id', () => {
    const state = parseMapUrlState('?chokepoint=bab_el_mandeb', EMPTY_LAYERS);
    assert.equal(state.chokepoint, 'bab_el_mandeb');
  });

  it('lowercases the chokepoint id', () => {
    const state = parseMapUrlState('?chokepoint=Hormuz_Strait', EMPTY_LAYERS);
    assert.equal(state.chokepoint, 'hormuz_strait');
  });

  it('rejects malformed or oversized chokepoint ids', () => {
    assert.equal(parseMapUrlState('?chokepoint=', EMPTY_LAYERS).chokepoint, undefined);
    assert.equal(parseMapUrlState('?chokepoint=../etc/passwd', EMPTY_LAYERS).chokepoint, undefined);
    assert.equal(parseMapUrlState(`?chokepoint=${'a'.repeat(60)}`, EMPTY_LAYERS).chokepoint, undefined);
  });

  it('leaves chokepoint undefined when absent', () => {
    assert.equal(parseMapUrlState('?country=IR', EMPTY_LAYERS).chokepoint, undefined);
  });
});

describe('buildMapUrl non-finite centre (#7660)', () => {
  const base = 'https://worldmonitor.app/dashboard';
  const baseState = {
    view: 'global' as const,
    zoom: 2,
    timeRange: '24h' as const,
    layers: EMPTY_LAYERS,
  };

  it('omits lat/lon when the centre is NaN', () => {
    const url = buildMapUrl(base, { ...baseState, center: { lat: NaN, lon: NaN } });
    const params = new URL(url).searchParams;
    assert.equal(params.get('lat'), null);
    assert.equal(params.get('lon'), null);
    assert.ok(!url.includes('NaN'), `url must not contain NaN: ${url}`);
  });

  it('omits lat/lon when only one coordinate is non-finite', () => {
    for (const center of [
      { lat: NaN, lon: 12.5 },
      { lat: 51.5, lon: NaN },
      { lat: Infinity, lon: 0 },
      { lat: 0, lon: -Infinity },
    ]) {
      const url = buildMapUrl(base, { ...baseState, center });
      assert.ok(!url.includes('NaN'), `url must not contain NaN: ${url}`);
      assert.ok(!url.includes('Infinity'), `url must not contain Infinity: ${url}`);
    }
  });

  it('still emits a finite centre', () => {
    const url = buildMapUrl(base, { ...baseState, center: { lat: 51.5074, lon: -0.1278 } });
    const params = new URL(url).searchParams;
    assert.equal(params.get('lat'), '51.5074');
    assert.equal(params.get('lon'), '-0.1278');
  });

  it('round-trips a NaN centre to a parse that yields no coordinates', () => {
    const url = buildMapUrl(base, { ...baseState, center: { lat: NaN, lon: NaN } });
    const state = parseMapUrlState(new URL(url).search, EMPTY_LAYERS);
    assert.equal(state.lat, undefined);
    assert.equal(state.lon, undefined);
  });
});

describe('buildMapUrl expanded param', () => {
  const base = 'https://worldmonitor.app/dashboard';
  const baseState = {
    view: 'global' as const,
    zoom: 2,
    center: { lat: 0, lon: 0 },
    timeRange: '24h' as const,
    layers: EMPTY_LAYERS,
  };

  it('includes expanded=1 when true', () => {
    const url = buildMapUrl(base, { ...baseState, country: 'IR', expanded: true });
    const params = new URL(url).searchParams;
    assert.equal(params.get('country'), 'IR');
    assert.equal(params.get('expanded'), '1');
  });

  it('omits expanded when falsy', () => {
    const url = buildMapUrl(base, { ...baseState, country: 'IR' });
    const params = new URL(url).searchParams;
    assert.equal(params.get('country'), 'IR');
    assert.equal(params.has('expanded'), false);
  });

  it('omits expanded when undefined', () => {
    const url = buildMapUrl(base, { ...baseState, country: 'IR', expanded: undefined });
    const params = new URL(url).searchParams;
    assert.equal(params.has('expanded'), false);
  });

  it('includes chokepoint when present', () => {
    const url = buildMapUrl(base, { ...baseState, chokepoint: 'hormuz_strait' });
    const params = new URL(url).searchParams;
    assert.equal(params.get('chokepoint'), 'hormuz_strait');
  });
});

describe('expanded param round-trip', () => {
  const base = 'https://worldmonitor.app/dashboard';
  const baseState = {
    view: 'global' as const,
    zoom: 2,
    center: { lat: 0, lon: 0 },
    timeRange: '24h' as const,
    layers: EMPTY_LAYERS,
  };

  it('round-trips country=IR&expanded=1', () => {
    const url = buildMapUrl(base, { ...baseState, country: 'IR', expanded: true });
    const parsed = parseMapUrlState(new URL(url).search, EMPTY_LAYERS);
    assert.equal(parsed.country, 'IR');
    assert.equal(parsed.expanded, true);
  });

  it('round-trips country=IR without expanded', () => {
    const url = buildMapUrl(base, { ...baseState, country: 'IR' });
    const parsed = parseMapUrlState(new URL(url).search, EMPTY_LAYERS);
    assert.equal(parsed.country, 'IR');
    assert.equal(parsed.expanded, undefined);
  });

  it('round-trips chokepoint deep links', () => {
    const url = buildMapUrl(base, { ...baseState, chokepoint: 'hormuz_strait' });
    const parsed = parseMapUrlState(new URL(url).search, EMPTY_LAYERS);
    assert.equal(parsed.chokepoint, 'hormuz_strait');
  });
});

describe('withUrlFragment', () => {
  const synced = 'https://www.worldmonitor.app/dashboard?zoom=1.00&view=global&layers=hotspots';

  it('keeps a hash route another surface is routing on', () => {
    assert.equal(withUrlFragment(synced, '#/verify-email-address'), `${synced}#/verify-email-address`);
  });

  it('adds nothing when there is no fragment', () => {
    assert.equal(withUrlFragment(synced, ''), synced);
  });

  it('replaces a fragment already on the synced url', () => {
    assert.equal(withUrlFragment(`${synced}#old`, '#new'), `${synced}#new`);
  });
});

describe('withoutVariantScopedUrlState', () => {
  it('drops the previous variant layer set and keeps the camera and fragment', () => {
    const next = new URL(withoutVariantScopedUrlState(
      'http://localhost:5173/?lat=8.0000&lon=0.0000&zoom=1.00&view=global&timeRange=7d&layers=outages%2Cnatural#signup',
    ));
    assert.equal(next.searchParams.has('layers'), false);
    assert.equal(next.searchParams.get('lat'), '8.0000');
    assert.equal(next.searchParams.get('view'), 'global');
    assert.equal(next.searchParams.get('timeRange'), '7d');
    assert.equal(next.hash, '#signup');
  });
});

describe('satellite pass share link', () => {
  const eiffel = { lat: 48.858_37, lon: 2.294_48 };
  const passAt = Date.UTC(2026, 10, 13, 10, 42, 37);

  it('carries the point at 0.01-degree precision and no finer', () => {
    const fragment = buildOrbitalShareFragment(eiffel);
    assert.equal(fragment, 'orbital=48.86,2.29');
    assert.doesNotMatch(fragment, /\d\.\d{3}/);
    assert.equal(buildOrbitalShareFragment({ lat: -0.001, lon: -179.996 }), 'orbital=0.00,-180.00');
  });

  it('round-trips the point and the selected pass to the minute', () => {
    const fragment = buildOrbitalShareFragment(eiffel, { noradId: 40697, timeMs: passAt });
    assert.equal(fragment, 'orbital=48.86,2.29;40697-202611131042');
    assert.deepEqual(parseOrbitalShareFragment(`#${fragment}`), {
      point: { lat: 48.86, lon: 2.29 },
      pass: { noradId: 40697, minuteMs: Date.UTC(2026, 10, 13, 10, 42) },
      view: 'sheet',
    });
  });

  it('opens the full view when the link asks for it', () => {
    const fragment = buildOrbitalShareFragment(eiffel, null, 'full');
    assert.equal(fragment, 'orbital=48.86,2.29&view=full');
    assert.equal(parseOrbitalShareFragment(`#${fragment}`)?.view, 'full');
    assert.equal(parseOrbitalShareFragment('#orbital=48.86,2.29&view=globe')?.view, 'sheet');
    assert.equal(withoutOrbitalShareFragment(`#tab=1&${fragment}`), 'tab=1');
  });

  it('reads the key beside other fragment params and leaves them in place', () => {
    assert.deepEqual(parseOrbitalShareFragment('#tab=1&orbital=-33.87,151.21')?.point, { lat: -33.87, lon: 151.21 });
    assert.equal(withoutOrbitalShareFragment('#tab=1&orbital=-33.87,151.21'), 'tab=1');
    assert.equal(withoutOrbitalShareFragment('#orbital=1.00,2.00'), '');
    assert.equal(withoutOrbitalShareFragment('#/sign-up/continue'), '/sign-up/continue');
  });

  for (const malformed of [
    '#orbital=91.00,10.00', '#orbital=10.00,181.00', '#orbital=48.8584,2.2945', '#orbital=abc',
    '#orbital=48.86', '#orbital=48.86,2.29;40697-202613131042', '#orbital=48.86,2.29;x-202611131042', '#/sign-up', '',
  ]) {
    it(`ignores ${malformed || 'an empty fragment'}`, () => {
      assert.equal(parseOrbitalShareFragment(malformed), null);
    });
  }

  it('is redacted from analytics URLs and error reports', () => {
    const shared = `https://www.worldmonitor.app/dashboard?view=global#${buildOrbitalShareFragment(eiffel)}`;
    assert.equal(redactSensitiveUrl(shared), 'https://www.worldmonitor.app/dashboard?view=global');
    const event = scrubSentryCredentials({ request: { url: shared }, breadcrumbs: [{ data: { from: shared } }] });
    assert.doesNotMatch(JSON.stringify(event), /48\.86/);
  });
});

describe('withMapCentreOf', () => {
  const shared = 'https://www.worldmonitor.app/?lat=25.1120&lon=55.1390&zoom=11.00&view=global&layers=fires';

  it('keeps the previous centre and zoom and takes every other param from the new URL', () => {
    const next = new URL(withMapCentreOf(shared, 'https://www.worldmonitor.app/?lat=-15.0000&lon=80.0000&zoom=4.00&view=global&layers=none'));
    assert.equal(next.searchParams.get('lat'), '-15.0000');
    assert.equal(next.searchParams.get('lon'), '80.0000');
    assert.equal(next.searchParams.get('zoom'), '4.00');
    assert.equal(next.searchParams.get('layers'), 'fires');
  });

  it('drops the centre when the previous URL had none', () => {
    const next = new URL(withMapCentreOf(shared, '/dashboard#orbital=25.1120,55.1390&view=full'));
    assert.equal(next.search.includes('25.112') || next.search.includes('55.139'), false, next.search);
    assert.equal(next.searchParams.get('layers'), 'fires');
  });
});
