import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assembleEvidence, compareBestView, describePointCondition, findArchiveEvidence, groupAcquisitions, type MatchedAcquisition } from '../src/services/orbital/match.ts';
import { parseStacItem, searchStacArchive } from '../src/services/orbital/archive-stac.ts';
import { ARCHIVE_RESPONSES, fakeArchiveFetch, fixtureLookup } from './helpers/orbital-archive-fetch.mts';

const { denver, dubai } = ARCHIVE_RESPONSES.points;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const confirmed = (passes: Array<{ tier: { kind: string } }>) => passes.filter((pass) => pass.tier.kind === 'confirmed-image');

describe('archive acquisitions attached to computed passes', () => {
  it('counts one acquisition, matched to one confirmed pass, when the archives return it as overlapping tiles', async () => {
    const lookup = await fixtureLookup(denver);
    const { fetch } = fakeArchiveFetch(denver);
    const evidence = await findArchiveEvidence(lookup, { fetch });
    const tiles = [...denver['earth-search'].features, ...denver['planetary-computer'].features].filter((f) => f.id.includes('S2C') && f.id.includes('20261111'));
    assert.ok(tiles.length >= 4, `the archives return ${tiles.length} tiles for the 11 November Sentinel-2C acquisition`);

    const acquisitions = evidence.acquisitions.filter((a) => a.platform === 'sentinel-2c' && day(a.startMs) === '2026-11-11');
    assert.equal(acquisitions.length, 1);
    const [acquisition] = acquisitions;
    assert.equal(acquisition!.items.length, tiles.length);
    assert.ok(acquisition!.pass, 'matched to a computed pass');
    const passes = evidence.passes.filter((p) => p.name === 'SENTINEL-2C' && day(p.timeMs) === '2026-11-11');
    assert.equal(confirmed(passes).length, 1, 'one pass carries the image');
    assert.equal(confirmed(passes)[0]!.timeMs, acquisition!.pass!.timeMs);
    assert.equal(evidence.status, 'complete');
  });

  it('lists every recorded acquisition and confirms no pass the archives do not hold', async () => {
    for (const point of [denver, dubai]) {
      const lookup = await fixtureLookup(point);
      const evidence = await findArchiveEvidence(lookup, { fetch: fakeArchiveFetch(point).fetch });
      const unmatched = evidence.acquisitions.filter((a) => !a.pass);
      assert.deepEqual(unmatched.map((a) => a.key), [], 'every acquisition finds its pass');
      const linked = new Set(evidence.acquisitions.map((a) => `${a.pass!.noradId}:${a.pass!.timeMs}`));
      for (const pass of confirmed(evidence.passes)) assert.ok(linked.has(`${pass.noradId}:${pass.timeMs}`), `${pass.name} ${pass.time} has an archive item`);
    }
  });

  it('counts a Landsat scene present at two processing levels once', async () => {
    const level2 = dubai['planetary-computer'].features.find((f) => f.id === 'LC09_L2SP_160043_20261103_02_T1')!;
    const otherLevel = { ...level2, id: 'LC09_L2SR_160043_20261103_02_T1' };
    const lookup = await fixtureLookup(dubai);
    const evidence = await findArchiveEvidence(lookup, { fetch: fakeArchiveFetch(dubai, { extraPlanetaryComputer: [otherLevel] }).fetch });
    const landsat = evidence.acquisitions.filter((a) => a.profileId === 'landsat');
    assert.equal(landsat.length, 1);
    assert.deepEqual(landsat[0]!.items.map((i) => i.itemId).sort(), ['LC09_L2SP_160042_20261103_02_T1', 'LC09_L2SP_160043_20261103_02_T1', 'LC09_L2SR_160043_20261103_02_T1']);
    assert.ok(landsat[0]!.pass, 'matched to the Landsat 9 pass');
    assert.equal(confirmed(evidence.passes.filter((p) => p.profileId === 'landsat')).length, 1);
  });

  it('keeps an acquisition with no pass inside the tolerance as an unmatched image', async () => {
    const lookup = await fixtureLookup(dubai);
    const items = dubai['earth-search'].features.flatMap((f) => parseStacItem('earth-search', f as never) ?? []);
    const withoutRadarPasses = { ...lookup, passes: lookup.passes.filter((p) => p.profileId !== 'sentinel-1') };
    const evidence = assembleEvidence({ lookup: withoutRadarPasses, stac: [{ status: 'ok', archive: 'earth-search', items }] });
    const radar = evidence.acquisitions.filter((a) => a.profileId === 'sentinel-1');
    assert.ok(radar.length >= 2, 'radar acquisitions stay listed');
    for (const acquisition of radar) {
      assert.equal(acquisition.pass, null);
      assert.ok(acquisition.imageUrl, 'and keep their image');
    }
  });

  it('keeps Sentinel results and names the partial state for Landsat when Planetary Computer fails', async () => {
    const lookup = await fixtureLookup(dubai);
    const evidence = await findArchiveEvidence(lookup, { fetch: fakeArchiveFetch(dubai, { failing: ['planetarycomputer.microsoft.com'] }).fetch });
    assert.equal(evidence.status, 'partial');
    assert.deepEqual(evidence.failures, [{ archive: 'planetary-computer', reason: 'http-status', httpStatus: 503 }]);
    assert.deepEqual(evidence.unansweredProfiles, ['landsat']);
    assert.ok(evidence.acquisitions.some((a) => a.profileId === 'sentinel-2'));
    assert.ok(evidence.acquisitions.some((a) => a.profileId === 'sentinel-1'));
    assert.equal(evidence.acquisitions.filter((a) => a.profileId === 'landsat').length, 0);
    const landsatImaging = evidence.passes.filter((p) => p.profileId === 'landsat' && p.inFootprint && p.sunElevationDeg >= 5);
    assert.ok(landsatImaging.length > 0);
    for (const pass of landsatImaging) assert.equal(pass.tier.kind, 'likely-imaged', 'silence from a failed archive is not "not in archive"');
  });

  it('names a network failure without the request URL', async () => {
    const lookup = await fixtureLookup(dubai);
    const evidence = await findArchiveEvidence(lookup, { fetch: fakeArchiveFetch(dubai, { unreachable: ['earth-search.aws.element84.com'] }).fetch });
    assert.deepEqual(evidence.failures, [{ archive: 'earth-search', reason: 'network' }]);
    assert.deepEqual(evidence.unansweredProfiles, ['sentinel-1']);
    assert.ok(evidence.acquisitions.some((a) => a.profileId === 'sentinel-2'), 'Planetary Computer still answers for Sentinel-2');
  });

  it('reads "cloud at this spot" for a cloudy point in a mostly clear scene', async () => {
    const lookup = await fixtureLookup(dubai);
    const evidence = await findArchiveEvidence(lookup, { fetch: fakeArchiveFetch(dubai, { scl: 9 }).fetch });
    const scene = evidence.acquisitions.find((a) => a.platform === 'sentinel-2b')!;
    assert.ok(scene.cloudCoverPct !== null && scene.cloudCoverPct < 5, `scene cloud ${scene.cloudCoverPct}%`);
    assert.equal(scene.condition, 'cloud');
    assert.equal(describePointCondition(scene), 'cloud at this spot');
    const clear = await findArchiveEvidence(lookup, { fetch: fakeArchiveFetch(dubai, { scl: 4 }).fetch });
    assert.equal(describePointCondition(clear.acquisitions.find((a) => a.platform === 'sentinel-2b')!), 'clear at this spot');
  });

  it('shows daily mosaics in their own row and upgrades no pass to a confirmed image with them', async () => {
    const lookup = await fixtureLookup(dubai);
    const evidence = await findArchiveEvidence(lookup, { fetch: fakeArchiveFetch(dubai).fetch });
    const terra = evidence.mosaics.find((row) => row.source === 'MODIS Terra');
    assert.ok(terra && terra.days.length > 0, 'MODIS Terra mosaic row');
    assert.ok(terra.days.every((d) => d.imageUrl?.startsWith('https://gibs.earthdata.nasa.gov/')));
    const modis = evidence.passes.filter((p) => p.profileId === 'modis');
    assert.ok(modis.some((p) => p.tier.kind === 'daily-mosaic'));
    assert.equal(confirmed(modis).length, 0);
    const withoutMosaics = assembleEvidence({ lookup, stac: [] });
    assert.deepEqual(confirmed(evidence.passes).filter((p) => !['sentinel-2', 'sentinel-1', 'landsat'].includes(p.profileId)), []);
    assert.equal(confirmed(withoutMosaics.passes).length, 0, 'no archive answer, no confirmed image');
  });

  it('lists geostationary frames separately for the satellites that see the point', async () => {
    const lookup = await fixtureLookup(denver);
    const evidence = await findArchiveEvidence(lookup, { fetch: fakeArchiveFetch(denver).fetch });
    assert.deepEqual(evidence.frames.map((f) => f.source).sort(), ['GOES-East', 'GOES-West']);
    for (const frame of evidence.frames) assert.equal(frame.latest?.time, '2026-11-13T11:50:00Z');
    assert.ok(evidence.acquisitions.every((a) => ['sentinel-2', 'sentinel-1', 'landsat'].includes(a.profileId)));
  });
});

describe('archive searches', () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it('follows next-page links so a long answer is not cut short', async () => {
    const features = denver['earth-search'].features;
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = async (_url: string, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      if (body.next) return json({ features: features.slice(10), links: [] });
      return json({ features: features.slice(0, 10), links: [{ rel: 'next', method: 'POST', href: 'https://earth-search.aws.element84.com/v1/search', body: { ...body, next: 'page-2' } }] });
    };
    const result = await searchStacArchive('earth-search', { point: denver, window: { startMs: Date.parse('2026-11-03T00:00:00Z'), endMs: Date.parse('2026-11-13T12:00:00Z') }, fetch });
    assert.equal(result.status, 'ok');
    assert.equal(bodies.length, 2);
    assert.equal(result.status === 'ok' && result.items.length, features.length);
  });

  it('does not follow a next-page link to another host', async () => {
    let calls = 0;
    const fetch = async () => {
      calls++;
      return json({ features: denver['earth-search'].features.slice(0, 1), links: [{ rel: 'next', method: 'GET', href: 'https://elsewhere.example.com/search?page=2' }] });
    };
    const result = await searchStacArchive('earth-search', { point: denver, window: { startMs: 0, endMs: Date.parse('2026-11-13T12:00:00Z') }, fetch });
    assert.equal(calls, 1);
    assert.equal(result.status === 'ok' && result.items.length, 1);
  });

  it('keeps a Sentinel-2 datatake that starts before the window but senses the point inside it', async () => {
    const tile = dubai['planetary-computer'].features.find((f) => f.id === 'S2B_MSIL2A_20261108T065109_R020_T40RCN_20261108T103534')!;
    const item = parseStacItem('planetary-computer', tile as never)!;
    const datatakeStart = Date.parse(tile.properties.datetime);
    const window = { startMs: datatakeStart + 5 * 60_000, endMs: datatakeStart + 2 * 86_400_000 };
    assert.ok(item.endMs > window.startMs, 'the strip reaches the point after the window opens');
    let requested = '';
    const fetch = async (_url: string, init: RequestInit = {}) => {
      requested = JSON.parse(String(init.body)).datetime;
      return json({ features: [tile], links: [] });
    };
    const result = await searchStacArchive('planetary-computer', { point: dubai, window, fetch });
    assert.ok(Date.parse(requested.split('/')[0]!) <= datatakeStart, `the search reaches back to the datatake start (${requested})`);
    assert.equal(result.status === 'ok' && result.items.length, 1);
    const later = await searchStacArchive('planetary-computer', { point: dubai, window: { startMs: item.endMs + 1, endMs: item.endMs + 86_400_000 }, fetch });
    assert.equal(later.status === 'ok' && later.items.length, 0, 'an item sensed before the window is left out');
  });
});

describe('best view', () => {
  const base = { condition: 'clear', resolutionM: 10, sunElevationDeg: 40, endMs: 1_000 } as MatchedAcquisition;
  const rank = (...candidates: MatchedAcquisition[]) => [...candidates].sort(compareBestView);
  it('prefers a clear point, then resolution, then sun elevation, then recency', () => {
    const cloudySharp = { ...base, condition: 'cloud', resolutionM: 10 } as MatchedAcquisition;
    const clearCoarse = { ...base, resolutionM: 30 };
    assert.equal(rank(cloudySharp, clearCoarse)[0], clearCoarse);
    const sharp = { ...base, resolutionM: 10, sunElevationDeg: 20 };
    assert.equal(rank(clearCoarse, sharp)[0], sharp);
    const highSun = { ...base, sunElevationDeg: 60, endMs: 0 };
    assert.equal(rank(base, highSun)[0], highSun);
    const recent = { ...base, endMs: 2_000 };
    assert.equal(rank(base, recent)[0], recent);
  });

  it('picks a clear Planetary Computer crop as the best view at a real point', async () => {
    const lookup = await fixtureLookup(dubai);
    const evidence = await findArchiveEvidence(lookup, { fetch: fakeArchiveFetch(dubai).fetch });
    assert.equal(evidence.bestView?.condition, 'clear');
    assert.match(evidence.bestView?.imageUrl ?? '', /^https:\/\/planetarycomputer\.microsoft\.com\/api\/data\/v1\/item\/bbox\//);
  });

  it('groups nothing across platforms or orbits', () => {
    const items = denver['planetary-computer'].features.flatMap((f) => parseStacItem('planetary-computer', f as never) ?? []);
    const groups = groupAcquisitions(items);
    assert.equal(groups.length, 5, 'five datatakes in the recorded window');
    for (const group of groups) assert.equal(new Set(group.items.map((i) => `${i.platform}:${i.orbit}`)).size, 1);
  });
});

describe('archive search progress', () => {
  it('reports each archive as it settles and holds a mission pending until every archive it uses has answered', async () => {
    const lookup = await fixtureLookup(denver);
    const progress: Array<{ settled: string[]; pendingProfiles: string[] }> = [];
    const evidence = await findArchiveEvidence(lookup, {
      fetch: fakeArchiveFetch(denver).fetch,
      onProgress: ({ settled, pendingProfiles }) => progress.push({ settled, pendingProfiles }),
    });
    assert.equal(progress.length, 5, 'one report per archive search');
    assert.deepEqual(progress.map((p) => p.settled.length), [1, 2, 3, 4, 5]);
    for (const report of progress) {
      const stacSettled = ['earth-search', 'planetary-computer'].filter((id) => report.settled.includes(id));
      if (stacSettled.length < 2) assert.ok(report.pendingProfiles.includes('sentinel-2'), 'Sentinel-2 waits for both of its archives');
    }
    assert.deepEqual(progress.at(-1)!.pendingProfiles, []);
    assert.equal(evidence.status, 'complete');
  });
});
