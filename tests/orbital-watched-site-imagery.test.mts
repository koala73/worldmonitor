import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { WATCHED_SITE_ID, toWaterExtent, toWatchedSiteImagery } from '../server/worldmonitor/orbital/v1/get-watched-site-imagery.ts';
import { ROLLUP_MAX_AGE_MS, SITES_SCHEMA } from '../shared/orbital/country-rollup.js';
import { orbitalHandler } from '../server/worldmonitor/orbital/v1/handler.ts';
import { createOrbitalServiceRoutes } from '../src/generated/server/worldmonitor/orbital/v1/service_server.ts';
import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths.ts';
import { getRequiredTier } from '../server/_shared/entitlement-check.ts';
import { WATCHED_SITES } from '../scripts/shared/orbital-watched-sites.generated.mjs';
import { fromSiteRecord } from '../src/services/orbital/object-imagery.ts';

const PATH = '/api/orbital/v1/get-watched-site-imagery';
const NOW = Date.parse('2026-11-14T12:00:00Z');
const route = createOrbitalServiceRoutes(orbitalHandler).find((r) => r.path === PATH)!.handler;

const record = (overrides: Record<string, unknown> = {}) => ({
  schema: SITES_SCHEMA,
  siteId: 'port:jebel_ali',
  name: 'Jebel Ali',
  lat: 25.01,
  lon: 55.06,
  countryCode: 'AE',
  surface: 'land',
  origins: [{ list: 'port', id: 'jebel_ali' }],
  evaluatedAt: NOW - 3_600_000,
  lastObservation: { itemId: 'S2B_MSIL2A_20261112T065109_R020_T40RCN', collection: 'sentinel-2-l2a', profileId: 'sentinel-2', platform: 'Sentinel-2B', datetime: '2026-11-12T06:51:09.000Z', cloudCover: 3.2 },
  nextWindows: [
    { noradId: 1, name: 'SENTINEL-2A', profileId: 'sentinel-2', time: '2026-11-14T06:00:00.000Z' },
    { noradId: 2, name: 'LANDSAT 9', profileId: 'landsat', time: '2026-11-15T06:40:00.000Z' },
  ],
  coverage: { revisitDays: 2 },
  operators: ['ESA'],
  flag: { state: 'confirmed', wording: 'Visible change', confirmed: { itemId: 'x', datetime: 'y', geometryKey: 'z' } },
  ...overrides,
});

describe('watched-site imagery read (KTD16)', () => {
  it('accepts every registry id and rejects anything shaped like a point', () => {
    for (const site of WATCHED_SITES as Array<{ id: string }>) assert.match(site.id, WATCHED_SITE_ID, site.id);
    for (const bad of ['', '25.01,55.06', 'lat=25.01&lon=55.06', 'port:', 'user:jebel_ali', 'port:Jebel Ali', 'port:jebel ali', `port:${'a'.repeat(97)}`]) {
      assert.doesNotMatch(bad, WATCHED_SITE_ID, bad);
    }
  });

  it('answers invalid site ids with 400', async () => {
    for (const query of ['', 'site_id=25.01,55.06', 'lat=25&lon=55', 'site_id=port%3A']) {
      const res = await route(new Request(`https://api.worldmonitor.app${PATH}?${query}`));
      assert.equal(res.status, 400, query);
    }
  });

  it('returns the newest image and the next future pass, and nothing the free tier does not get', () => {
    const res = toWatchedSiteImagery('port:jebel_ali', record(), NOW);
    assert.deepEqual(res, {
      siteId: 'port:jebel_ali',
      name: 'Jebel Ali',
      lat: 25.01,
      lon: 55.06,
      evaluatedAt: NOW - 3_600_000,
      stale: false,
      latestImage: { itemId: 'S2B_MSIL2A_20261112T065109_R020_T40RCN', collection: 'sentinel-2-l2a', profileId: 'sentinel-2', datetime: '2026-11-12T06:51:09.000Z', cloudCoverPct: 3.2 },
      nextPass: { satellite: 'LANDSAT 9', profileId: 'landsat', time: '2026-11-15T06:40:00.000Z' },
    });
    const keys = JSON.stringify(res);
    for (const pro of ['flag', 'Flag', 'operators', 'coverage', 'acquisitions', 'recentPasses']) assert.ok(!keys.includes(pro), pro);
  });

  it('reports a missing, foreign, old-schema or stale record as stale with no imagery', () => {
    const stale = [
      toWatchedSiteImagery('port:jebel_ali', null, NOW),
      toWatchedSiteImagery('port:jebel_ali', record({ siteId: 'port:other' }), NOW),
      toWatchedSiteImagery('port:jebel_ali', record({ schema: SITES_SCHEMA + 1 }), NOW),
      toWatchedSiteImagery('port:jebel_ali', record({ evaluatedAt: NOW - ROLLUP_MAX_AGE_MS - 1 }), NOW),
    ];
    for (const res of stale) {
      assert.equal(res.stale, true);
      assert.equal(res.latestImage, undefined);
      assert.equal(res.nextPass, undefined);
    }
  });

  it('is free for map objects while the per-point and per-country APIs stay Pro', () => {
    assert.ok(!PREMIUM_RPC_PATHS.has(PATH));
    assert.equal(getRequiredTier(PATH), null);
    for (const pro of ['/api/orbital/v1/get-point-passes', '/api/orbital/v1/get-country-imagery-evidence']) {
      assert.ok(PREMIUM_RPC_PATHS.has(pro), pro);
      assert.equal(getRequiredTier(pro), 1, pro);
    }
  });
});

describe('site record to popup imagery', () => {
  it('crops the newest scene at the registry position and keeps the next pass', () => {
    const imagery = fromSiteRecord(toWatchedSiteImagery('port:jebel_ali', record(), NOW), NOW)!;
    assert.equal(imagery.latest?.archive, 'planetary-computer');
    assert.equal(imagery.latest?.candidates.length, 1);
    assert.equal(new URL(imagery.latest!.candidates[0]!).hostname, 'planetarycomputer.microsoft.com');
    assert.deepEqual(imagery.nextPass, { satellite: 'LANDSAT 9', profileId: 'landsat', timeMs: Date.parse('2026-11-15T06:40:00.000Z') });
  });

  it('falls back to the browser lookup when the record is stale', () => {
    assert.equal(fromSiteRecord(toWatchedSiteImagery('port:jebel_ali', null, NOW), NOW), null);
  });

  it('gives a reservoir its newest radar water reading and the same-orbit one before it', () => {
    const reading = (time: string, waterPercent: number, relativeOrbit = 43) => ({ time, waterPercent, waterKm2: waterPercent * 2, platform: 'Sentinel-1A', relativeOrbit });
    const summary = (entry: unknown) => ({ schema: 1, reservoirs: { 'reservoir:kariba': entry } });
    const latest = reading('2026-11-09T03:40:00Z', 62.4);
    const previous = reading('2026-10-28T03:40:00Z', 65.5);
    const wire = ({ time, ...rest }: ReturnType<typeof reading>) => ({ timeMs: Date.parse(time), ...rest });
    assert.deepEqual(toWaterExtent('reservoir:kariba', summary({ areaKm2: 640, latest, sameOrbitPrevious: previous })), {
      latest: wire(latest), sameOrbitPrevious: wire(previous), boxKm2: 640,
    });
    // Other orbits, a later "previous" or a malformed one are not compared.
    for (const bad of [reading('2026-10-28T03:40:00Z', 65.5, 145), reading('2026-11-10T03:40:00Z', 65.5), { time: 'x', waterPercent: 1 }]) {
      assert.equal(toWaterExtent('reservoir:kariba', summary({ areaKm2: 640, latest, sameOrbitPrevious: bad }))?.sameOrbitPrevious, undefined);
    }
    // Readings without a relative orbit cannot be matched to one.
    const unorbited = (time: string) => ({ time, waterPercent: 60, waterKm2: 120 });
    assert.equal(toWaterExtent('reservoir:kariba', summary({ areaKm2: 640, latest: unorbited('2026-11-09T03:40:00Z'), sameOrbitPrevious: unorbited('2026-10-28T03:40:00Z') }))?.sameOrbitPrevious, undefined);
    for (const missing of [null, {}, { reservoirs: {} }, summary(null), summary({ latest: { time: 'x', waterPercent: 1 } }), summary({ latest: { time: latest.time } })]) {
      assert.equal(toWaterExtent('reservoir:kariba', missing), null);
    }
  });
});
