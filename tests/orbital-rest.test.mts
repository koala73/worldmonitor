import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { computePointPasses, parsePoint, pointPassesCacheKey } from '../server/worldmonitor/orbital/v1/get-point-passes.ts';
import { ORBITAL_ROLLUP_MAX_AGE_MS, ORBITAL_SITES_SCHEMA, toCountryEvidence } from '../server/worldmonitor/orbital/v1/get-country-imagery-evidence.ts';
import { toCatalogResponse } from '../server/worldmonitor/orbital/v1/list-imaging-satellites.ts';
import { orbitalHandler } from '../server/worldmonitor/orbital/v1/handler.ts';
import { createOrbitalServiceRoutes } from '../src/generated/server/worldmonitor/orbital/v1/service_server.ts';
import { toOrbitalCatalog } from '../src/services/orbital/catalog-shape.ts';
import { findArchiveEvidence } from '../src/services/orbital/match.ts';
import { runPassJob } from '../src/services/orbital/pass-job.ts';
import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths.ts';
import { getRequiredTier } from '../server/_shared/entitlement-check.ts';
import { ROLLUP_MAX_AGE_MS, SITES_SCHEMA, evaluateSites, planPublication } from '../scripts/_orbital-sites.mjs';
import { WATCHED_SITES } from '../scripts/shared/orbital-watched-sites.generated.mjs';
import { ARCHIVE_RESPONSES, fakeArchiveFetch, FIXTURE_NOW } from './helpers/orbital-archive-fetch.mts';

const HOUR = 3_600_000;
const { records } = JSON.parse(readFileSync(new URL('./fixtures/orbital/celestrak-gp-2026-11-13.json', import.meta.url), 'utf8'));
const storedCatalog = {
  source: 'celestrak',
  fetchedAt: FIXTURE_NOW - HOUR,
  satellites: records.map((r: Record<string, unknown>) => ({ noradId: Number(r.NORAD_CAT_ID), name: r.OBJECT_NAME, profileId: '', elements: r })),
  ring: [],
};
const passKey = (p: { noradId: number; timeMs: number }) => `${p.noradId}:${p.timeMs}`;
const POINTS = [ARCHIVE_RESPONSES.points.denver, ARCHIVE_RESPONSES.points.dubai];

/** The browser lookup: the catalog as the RPC serves it over the wire, the worker's pass job, then browser-direct archive matching. */
async function browserLookup(point: { lat: number; lon: number }, window: { startMs: number; endMs: number }, fetch: ReturnType<typeof fakeArchiveFetch>['fetch']) {
  const wire = JSON.parse(JSON.stringify(toCatalogResponse(storedCatalog, FIXTURE_NOW)));
  const catalog = toOrbitalCatalog(wire);
  const job = await runPassJob({ point, window, nowMs: FIXTURE_NOW, satellites: catalog.satellites });
  const lookup = { point, window, nowMs: FIXTURE_NOW, catalog, passes: job!.passes, satellites: job!.satellites, computedOn: 'main-thread' as const };
  return { job: job!, evidence: await findArchiveEvidence(lookup, { fetch }) };
}

const route = (path: string) => createOrbitalServiceRoutes(orbitalHandler).find((r) => r.path === path)!.handler;

describe('point passes over REST', () => {
  it('assigns every pass the tier the browser lookup assigns for the same catalog and archive answers', async () => {
    for (const fixture of POINTS) {
      const point = { lat: fixture.lat, lon: fixture.lon };
      const rest = await computePointPasses(point, storedCatalog, FIXTURE_NOW, { fetch: fakeArchiveFetch(fixture).fetch });
      const { job, evidence } = await browserLookup(point, { startMs: rest.windowStartMs, endMs: rest.windowEndMs }, fakeArchiveFetch(fixture).fetch);
      const browserTiers = new Map(evidence.passes.filter((p) => p.inFootprint).map((p) => [passKey(p), p.tier.kind]));
      assert.ok(rest.passes.length > 0);
      assert.deepEqual(new Map(rest.passes.map((p) => [passKey(p), p.tier])), browserTiers);
      assert.deepEqual(rest.passes.map(passKey), job.passes.filter((p) => p.inFootprint).map(passKey), 'the same passes the pure pass job computes');
      assert.equal(rest.outOfFootprintPasses, job.passes.length - rest.passes.length);
      assert.equal(rest.archiveStatus, 'complete');
      assert.equal(rest.stale, false);
    }
  });

  it('returns a matched pass with the confirmed tier and its image reference', async () => {
    const fixture = ARCHIVE_RESPONSES.points.denver;
    const rest = await computePointPasses({ lat: fixture.lat, lon: fixture.lon }, storedCatalog, FIXTURE_NOW, { fetch: fakeArchiveFetch(fixture).fetch });
    const confirmed = rest.passes.filter((p) => p.tier === 'confirmed-image');
    assert.ok(confirmed.length > 0);
    for (const pass of confirmed) {
      const acquisition = rest.acquisitions.find((a) => a.key === pass.acquisitionKey);
      assert.ok(acquisition, `${pass.name} names its acquisition`);
      assert.equal(acquisition!.passNoradId, pass.noradId);
      assert.match(acquisition!.imageUrl, /^https:\/\//);
      assert.ok(acquisition!.itemIds.length > 0);
    }
  });

  it('keeps geometry tiers and names the failed sources when the archives fail', async () => {
    const fixture = ARCHIVE_RESPONSES.points.denver;
    const failing = ['earth-search.aws.element84.com', 'planetarycomputer.microsoft.com'];
    const rest = await computePointPasses({ lat: fixture.lat, lon: fixture.lon }, storedCatalog, FIXTURE_NOW, { fetch: fakeArchiveFetch(fixture, { failing }).fetch });
    const { job } = await browserLookup({ lat: fixture.lat, lon: fixture.lon }, { startMs: rest.windowStartMs, endMs: rest.windowEndMs }, fakeArchiveFetch(fixture).fetch);
    assert.equal(rest.archiveStatus, 'partial');
    assert.deepEqual(rest.failedSources.map((f) => f.archive).sort(), ['earth-search', 'planetary-computer']);
    assert.deepEqual(rest.failedSources.map((f) => f.httpStatus), [503, 503]);
    assert.deepEqual(rest.acquisitions, []);
    const geometry = new Map(job.passes.filter((p) => p.inFootprint).map((p) => [passKey(p), p.tier.kind]));
    assert.deepEqual(new Map(rest.passes.map((p) => [passKey(p), p.tier])), geometry);
    assert.ok(!rest.passes.some((p) => p.tier === 'confirmed-image'));
  });

  it('computes and caches on the 0.01-degree cell and names the point used', async () => {
    const a = parsePoint(new Request('https://api.worldmonitor.app/api/orbital/v1/get-point-passes?lat=39.7392&lon=-104.9903'));
    const b = parsePoint(new Request('https://api.worldmonitor.app/api/orbital/v1/get-point-passes?lat=39.7449&lon=-104.9851'));
    assert.deepEqual(a, { lat: 39.74, lon: -104.99 });
    assert.deepEqual(b, a);
    assert.equal(pointPassesCacheKey(a), pointPassesCacheKey(b));
    const fixture = ARCHIVE_RESPONSES.points.denver;
    const [first, second] = await Promise.all([a, b].map((p) => computePointPasses(p, storedCatalog, FIXTURE_NOW, { fetch: fakeArchiveFetch(fixture).fetch })));
    assert.deepEqual(first, second);
    assert.deepEqual(first!.point, { lat: 39.74, lon: -104.99 });
  });

  it('reports a missing catalog as stale with no passes', async () => {
    const fixture = ARCHIVE_RESPONSES.points.denver;
    const rest = await computePointPasses({ lat: 1, lon: 1 }, null, FIXTURE_NOW, { fetch: fakeArchiveFetch(fixture).fetch });
    assert.equal(rest.stale, true);
    assert.deepEqual(rest.passes, []);
  });

  it('answers invalid caller input with 400, never 500', async () => {
    const handler = route('/api/orbital/v1/get-point-passes');
    for (const query of ['lat=91&lon=0', 'lat=-90.5&lon=0', 'lat=0&lon=180.01', 'lat=abc&lon=0', 'lat=0', 'lon=0', 'lat=&lon=0', 'lat=Infinity&lon=0']) {
      const res = await handler(new Request(`https://api.worldmonitor.app/api/orbital/v1/get-point-passes?${query}`));
      assert.equal(res.status, 400, query);
      assert.ok(Array.isArray((await res.json()).violations), query);
    }
    const country = route('/api/orbital/v1/get-country-imagery-evidence');
    for (const query of ['', 'country_code=ukr', 'country_code=UKR', 'country_code=U1']) {
      assert.equal((await country(new Request(`https://api.worldmonitor.app/api/orbital/v1/get-country-imagery-evidence?${query}`))).status, 400, query);
    }
  });

  it('requires a Pro entitlement on both routes', () => {
    for (const path of ['/api/orbital/v1/get-point-passes', '/api/orbital/v1/get-country-imagery-evidence']) {
      assert.ok(PREMIUM_RPC_PATHS.has(path), `${path} needs a key or a Pro session`);
      assert.equal(getRequiredTier(path), 1, `${path} refuses a signed-in free account`);
    }
    assert.ok(!PREMIUM_RPC_PATHS.has('/api/orbital/v1/list-imaging-satellites'), 'the free lookup catalog stays public');
  });
});

const NOW = Date.parse('2026-11-13T12:00:00Z');
const site = WATCHED_SITES.find((s: { surface: string }) => s.surface === 'land')!;
const confirmedFlag = (siteId: string, state = 'confirmed') => ({
  schema: 1,
  siteId,
  wording: 'imagery statistics changed',
  footprint: { lat: 0, lon: 0, halfSizeDeg: 0.01 },
  state,
  tracks: {
    's1:42:descending:IW': {
      state,
      confirmedBy: state === 'confirmed' ? { itemId: 'S1A_IW_GRDH_confirming', datetime: '2026-11-11T05:00:00Z' } : null,
    },
  },
  events: [],
  backfilledAt: null,
  updatedAt: NOW - HOUR,
});

async function publish(shadow: boolean, state = 'confirmed') {
  const evaluation = await evaluateSites({
    sites: [site],
    catalog: { satellites: [], fetchedAt: NOW },
    previousRecords: new Map(),
    cursor: null,
    searchArchive: async () => [],
    nowMs: NOW,
    deadlineMs: Infinity,
    change: { shadow, previousFlags: new Map(), score: async () => confirmedFlag(site.id, state), summary: () => ({ shadow }) },
  });
  return planPublication({ sites: [site], registryVersion: 'test', previousIndex: null, previousRecords: new Map(), evaluation, nowMs: NOW });
}

describe('country imagery evidence over REST', () => {
  it('reads the rollup with the seeder schema and freshness limit', () => {
    assert.equal(ORBITAL_SITES_SCHEMA, SITES_SCHEMA);
    assert.equal(ORBITAL_ROLLUP_MAX_AGE_MS, ROLLUP_MAX_AGE_MS);
  });

  it('returns a confirmed flag with its confirming scene', async () => {
    const plan = await publish(false);
    const evidence = toCountryEvidence(site.countryCode, plan.index, plan.rollupWrites[0], NOW);
    assert.equal(evidence.stale, false);
    assert.equal(evidence.siteCount, 1);
    assert.equal(evidence.confirmedFlagCount, 1);
    assert.deepEqual(evidence.sites[0]!.confirmedFlag, {
      wording: 'imagery statistics changed',
      itemId: 'S1A_IW_GRDH_confirming',
      datetime: '2026-11-11T05:00:00Z',
      geometryKey: 's1:42:descending:IW',
      updatedAt: NOW - HOUR,
    });
  });

  it('returns no flag that is only raised', async () => {
    const plan = await publish(false, 'raised');
    const evidence = toCountryEvidence(site.countryCode, plan.index, plan.rollupWrites[0], NOW);
    assert.equal(evidence.confirmedFlagCount, 0);
    assert.equal(evidence.sites[0]!.confirmedFlag, undefined);
  });

  it('returns no flag while the change signal is in shadow', async () => {
    const plan = await publish(true);
    assert.equal(plan.flagWrites?.length, 1, 'the shadow flag exists, under its own key');
    const evidence = toCountryEvidence(site.countryCode, plan.index, plan.rollupWrites[0], NOW);
    assert.equal(evidence.siteCount, 1);
    assert.equal(evidence.confirmedFlagCount, 0);
    assert.equal(evidence.sites[0]!.confirmedFlag, undefined);
  });

  it('rejects a rollup past its freshness limit or not named by the index', async () => {
    const plan = await publish(false);
    const rollup = plan.rollupWrites[0];
    const late = toCountryEvidence(site.countryCode, plan.index, rollup, rollup.asOf + ROLLUP_MAX_AGE_MS + 1);
    assert.deepEqual({ stale: late.stale, sites: late.sites, siteCount: late.siteCount }, { stale: true, sites: [], siteCount: 1 });
    const other = toCountryEvidence(site.countryCode, plan.index, { ...rollup, revision: 'older' }, NOW);
    assert.equal(other.stale, true);
  });

  it('tells a country with no watched sites from evidence that was never seeded', async () => {
    const plan = await publish(false);
    const none = toCountryEvidence('ZZ', plan.index, null, NOW);
    assert.deepEqual({ stale: none.stale, siteCount: none.siteCount }, { stale: false, siteCount: 0 });
    const unseeded = toCountryEvidence(site.countryCode, null, null, NOW);
    assert.deepEqual({ stale: unseeded.stale, siteCount: unseeded.siteCount }, { stale: true, siteCount: 0 });
  });
});
