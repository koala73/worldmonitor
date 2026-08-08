import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMapUrlState, buildMapUrl } from '../src/utils/urlState.ts';

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
