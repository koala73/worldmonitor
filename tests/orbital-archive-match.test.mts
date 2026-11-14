import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assembleEvidence, compareBestView, describePointCondition, findArchiveEvidence, groupAcquisitions, type MatchedAcquisition } from '../src/services/orbital/match.ts';
import { parseStacItem, readPointCondition, searchStacArchive } from '../src/services/orbital/archive-stac.ts';
import { hasNoDataAtPoint, pointInCrop, searchGibsDailyMosaics } from '../src/services/orbital/archive-gibs.ts';
import { cropBox } from '../src/services/orbital/crop-url.ts';
import { searchEumetsatGeostationary } from '../src/services/orbital/archive-eumetsat.ts';
import { requestArchive } from '../src/services/orbital/archive-result.ts';
import { loadArchiveImage } from '../src/services/orbital/archive-image.ts';
import { ARCHIVE_RESPONSES, FIXTURE_NOW, FIXTURE_WINDOW, fakeArchiveFetch, fixtureLookup } from './helpers/orbital-archive-fetch.mts';

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
      const crop = new URL(acquisition.imageUrl!);
      assert.equal(crop.hostname, 'planetarycomputer.microsoft.com', 'and keep a crop of their image at the point');
      assert.deepEqual([crop.searchParams.get('collection'), crop.searchParams.get('assets'), crop.searchParams.get('colormap_name')], ['sentinel-1-grd', 'vv', 'gray']);
    }
  });

  it('keeps Sentinel results and names the partial state for Landsat when Planetary Computer fails', async () => {
    const lookup = await fixtureLookup(dubai);
    const evidence = await findArchiveEvidence(lookup, { fetch: fakeArchiveFetch(dubai, { failing: ['planetarycomputer.microsoft.com'] }).fetch });
    assert.equal(evidence.status, 'partial');
    assert.deepEqual(evidence.failures, [{ archive: 'planetary-computer', reason: 'http-status', httpStatus: 503 }]);
    assert.deepEqual(evidence.unansweredProfiles, ['sentinel-2', 'landsat']);
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
    assert.deepEqual(evidence.unansweredProfiles, ['sentinel-2', 'sentinel-1']);
    assert.ok(evidence.acquisitions.some((a) => a.profileId === 'sentinel-2'), 'Planetary Computer still answers for Sentinel-2');
    const s2Passes = evidence.passes.filter((p) => p.profileId === 'sentinel-2' && p.timeMs <= lookup.nowMs);
    assert.ok(s2Passes.length > 0);
    for (const pass of s2Passes) assert.notEqual(pass.tier.kind, 'not-in-archive', 'one mirror answering cannot rule out an image the other may hold');
  });

  it('returns the other archives when one stalls, with the stalled missions unanswered', async () => {
    const lookup = await fixtureLookup(dubai);
    const started = Date.now();
    const evidence = await findArchiveEvidence(lookup, { fetch: fakeArchiveFetch(dubai, { stalled: ['earth-search.aws.element84.com'] }).fetch, timeoutMs: 50 });
    assert.ok(Date.now() - started < 2_000, 'the lookup does not wait on the stalled archive');
    assert.equal(evidence.status, 'partial');
    assert.deepEqual(evidence.failures, [{ archive: 'earth-search', reason: 'timeout' }]);
    assert.deepEqual(evidence.unansweredProfiles, ['sentinel-2', 'sentinel-1']);
    assert.ok(evidence.acquisitions.some((a) => a.profileId === 'sentinel-2' && a.items.every((i) => i.archive === 'planetary-computer')));
    assert.ok(evidence.mosaics.length > 0 && evidence.frames.length > 0);
  });

  it('names a caller cancellation as aborted, not as a timeout', async () => {
    const controller = new AbortController();
    const reply = requestArchive('eumetsat', 'https://view.eumetsat.int/geoserver/wms', {}, {
      fetch: () => new Promise<Response>(() => {}),
      signal: controller.signal,
      timeoutMs: 5_000,
    }, async (response) => response.text());
    controller.abort();
    assert.deepEqual(await reply, { ok: false, failure: { archive: 'eumetsat', reason: 'aborted' } });
  });

  it('leaves no listener on the caller signal after a request completes, without AbortSignal.any', async () => {
    const any = AbortSignal.any;
    (AbortSignal as { any?: unknown }).any = undefined;
    try {
      const controller = new AbortController();
      let listeners = 0;
      const add = controller.signal.addEventListener.bind(controller.signal);
      const remove = controller.signal.removeEventListener.bind(controller.signal);
      controller.signal.addEventListener = ((...args: Parameters<typeof add>) => { listeners++; add(...args); }) as typeof add;
      controller.signal.removeEventListener = ((...args: Parameters<typeof remove>) => { listeners--; remove(...args); }) as typeof remove;
      for (let i = 0; i < 3; i++) {
        const reply = await requestArchive('eumetsat', 'https://view.eumetsat.int/x', {}, { fetch: async () => new Response('ok'), signal: controller.signal }, async (r) => r.text());
        assert.equal(reply.ok, true);
      }
      assert.equal(listeners, 0);
    } finally {
      AbortSignal.any = any;
    }
  });

  it('times out an archive that sends headers but never finishes the body', async () => {
    const stalledBody = new Response(new ReadableStream({ start() {} }), { status: 200 });
    const reply = await requestArchive('nasa-gibs', 'https://gibs.earthdata.nasa.gov/x.xml', {}, { fetch: async () => stalledBody, timeoutMs: 50 }, async (response) => response.text());
    assert.deepEqual(reply, { ok: false, failure: { archive: 'nasa-gibs', reason: 'timeout' } });
  });

  it('keeps answering layers and marks the lookup partial when one layer fails', async () => {
    const lookup = await fixtureLookup(denver);
    const evidence = await findArchiveEvidence(lookup, { fetch: fakeArchiveFetch(denver, { failingPaths: ['GOES-West'] }).fetch });
    assert.deepEqual(evidence.frames.map((f) => [f.source, f.latest !== null]), [['GOES-East', true], ['GOES-West', false]]);
    assert.equal(evidence.status, 'partial');
    assert.deepEqual(evidence.failures, [{ archive: 'nasa-gibs', reason: 'http-status', httpStatus: 503, source: 'GOES-West' }]);
  });

  it('keeps the single EUMETSAT layer as an unavailable row when it fails', async () => {
    const lookup = await fixtureLookup(dubai);
    const evidence = await findArchiveEvidence(lookup, { fetch: fakeArchiveFetch(dubai, { failing: ['view.eumetsat.int'] }).fetch });
    const eumetsat = evidence.frames.filter((f) => f.archive === 'eumetsat');
    assert.ok(eumetsat.length > 0);
    assert.ok(eumetsat.every((f) => f.latest === null));
    assert.ok(evidence.failures.some((f) => f.archive === 'eumetsat'));
  });

  it('keeps every source as an unavailable row when all of its layers fail', async () => {
    const lookup = await fixtureLookup(denver);
    const evidence = await findArchiveEvidence(lookup, { fetch: fakeArchiveFetch(denver, { failingPaths: ['GOES-East', 'GOES-West'] }).fetch });
    assert.deepEqual(evidence.frames.map((f) => [f.source, f.latest !== null]), [['GOES-East', false], ['GOES-West', false]]);
    assert.equal(evidence.status, 'partial');
    assert.deepEqual(evidence.failures.map((f) => f.source), ['GOES-East', 'GOES-West']);
  });

  it('keeps the first day of a window that opens after midnight', async () => {
    const nowMs = Date.parse('2026-11-13T12:00:00Z');
    const result = await searchGibsDailyMosaics({
      point: dubai,
      window: { startMs: Date.parse('2026-11-13T06:00:00Z'), endMs: nowMs },
      nowMs,
      fetch: fakeArchiveFetch(dubai).fetch,
    });
    assert.equal(result.status, 'ok');
    const terra = result.status === 'ok' ? result.items.find((row) => row.source === 'MODIS Terra') : undefined;
    assert.deepEqual(terra?.days.map((d) => d.date), ['2026-11-13']);
    assert.ok(terra?.pointInCrop && Math.abs(terra.pointInCrop.x - 0.5) < 0.01, 'each row says where the point is in its crops');
  });

  it('reads the point pixel in each scene\'s own grid, so a box near a pixel edge cannot land on its neighbour', async () => {
    for (const feature of [...denver['planetary-computer'].features, ...dubai['planetary-computer'].features]) {
      const item = parseStacItem('planetary-computer', feature as never);
      if (!item?.classification) continue;
      const urls: string[] = [];
      await readPointCondition(item, dubai, { fetch: async (url: string) => { urls.push(url); return new Response('{"properties":{"statistics":{"b1":{"majority":4}}}}'); } });
      assert.equal(new URL(urls[0]!).searchParams.get('dst_crs'), `epsg:${(feature.properties as Record<string, unknown>)['proj:epsg']}`, item.itemId);
    }
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

  it('keeps a mosaic source with an empty time domain as a row with no days', async () => {
    const lookup = await fixtureLookup(dubai);
    const evidence = await findArchiveEvidence(lookup, { fetch: fakeArchiveFetch(dubai, { emptyLayers: ['VIIRS_SNPP'] }).fetch });
    const viirs = evidence.mosaics.find((row) => row.source === 'VIIRS Suomi NPP');
    assert.ok(viirs, 'VIIRS Suomi NPP row kept');
    assert.deepEqual(viirs.days, []);
    assert.ok(evidence.mosaics.find((row) => row.source === 'MODIS Terra')!.days.length > 0);
  });

  it('says a scene-wide cloud read did not check the spot', () => {
    assert.equal(describePointCondition({ condition: 'unknown', cloudCoverPct: 12.4 }), '12% cloud across the scene, this spot not checked');
    assert.equal(describePointCondition({ condition: 'unknown', cloudCoverPct: null }), 'this spot not checked for cloud');
  });

  it('marks the lookup partial when the point classification read fails', async () => {
    const lookup = await fixtureLookup(dubai);
    const evidence = await findArchiveEvidence(lookup, { fetch: fakeArchiveFetch(dubai, { scl: 9, failingPaths: ['/item/statistics'] }).fetch });
    assert.equal(evidence.acquisitions.find((a) => a.platform === 'sentinel-2b')!.condition, 'unknown');
    assert.equal(evidence.status, 'partial');
    assert.ok(evidence.failures.length > 0 && evidence.failures.every((f) => f.archive === 'planetary-computer' && f.reason === 'http-status'));
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

  it('gives the newest weather frame the two previous advertised frames to fall back on', async () => {
    const goes = (await findArchiveEvidence(await fixtureLookup(denver), { fetch: fakeArchiveFetch(denver).fetch })).frames;
    const meteosat = await searchEumetsatGeostationary({
      point: dubai, window: FIXTURE_WINDOW, nowMs: FIXTURE_NOW, visibleNoradIds: new Set([54743]), fetch: fakeArchiveFetch(dubai).fetch,
    });
    assert.equal(meteosat.status, 'ok');
    const frames = [...goes, ...(meteosat.status === 'ok' ? meteosat.items : [])];
    assert.deepEqual(frames.map((f) => f.source).sort(), ['GOES-East', 'GOES-West', 'Meteosat-12']);
    for (const frame of frames) {
      const latest = frame.latest!;
      const step = frame.cadenceMinutes! * 60_000;
      const expected = [1, 2].map((n) => new Date(Date.parse(latest.time) - n * step).toISOString().replace('.000Z', 'Z'));
      assert.deepEqual(latest.fallbacks.map((f) => f.time), expected, frame.source);
      for (const fallback of latest.fallbacks) {
        const url = new URL(fallback.imageUrl);
        assert.equal(url.searchParams.get('TIME') ?? url.searchParams.get('time'), fallback.time);
        assert.equal(url.host, new URL(latest.imageUrl!).host);
      }
    }
  });

  it('loads the first weather frame that serves and decodes, inside one deadline', async () => {
    const png = () => new Response(new Blob([new Uint8Array(8)], { type: 'image/png' }));
    const urls = ['https://view.eumetsat.int/a', 'https://view.eumetsat.int/b', 'https://view.eumetsat.int/c'];
    const replies: Record<string, () => Response> = { [urls[0]!]: () => new Response('busy', { status: 500 }), [urls[1]!]: () => new Response('<xml/>', { headers: { 'Content-Type': 'text/xml' } }), [urls[2]!]: png };
    const loaded = await loadArchiveImage('eumetsat', urls, { fetch: async (url: string) => replies[url]!() });
    assert.equal(loaded.status, 'ok');
    if (loaded.status === 'ok') {
      assert.equal(loaded.image.index, 2);
      assert.match(loaded.image.objectUrl, /^blob:/);
      loaded.image.release();
    }
    const allFail = await loadArchiveImage('eumetsat', urls.slice(0, 1), { fetch: async () => new Response('', { status: 503 }) });
    assert.deepEqual(allFail, { status: 'failed', failure: { archive: 'eumetsat', reason: 'http-status', httpStatus: 503 } });
    const tried: string[] = [];
    const stalled = await loadArchiveImage('eumetsat', urls, { timeoutMs: 30, fetch: (url: string, init?: RequestInit) => { tried.push(url); return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))); } });
    assert.deepEqual(stalled, { status: 'failed', failure: { archive: 'eumetsat', reason: 'timeout' } });
    assert.deepEqual(tried, urls.slice(0, 1), 'a spent deadline is not restarted for the next frame');
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

describe('daily mosaic no-data check', () => {
  const crop = (pixel: (x: number, y: number) => [number, number, number, number], size = 32) => {
    const rgba = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) rgba.set(pixel(x, y), (y * size + x) * 4);
    return rgba;
  };

  it('treats a black or transparent centre as no data at the point', () => {
    assert.equal(hasNoDataAtPoint(crop(() => [0, 0, 0, 255]), 32, 32), true);
    assert.equal(hasNoDataAtPoint(crop(() => [9, 11, 12, 255]), 32, 32), true, 'JPEG noise on black');
    assert.equal(hasNoDataAtPoint(crop(() => [90, 120, 140, 0]), 32, 32), true, 'transparent');
    assert.equal(hasNoDataAtPoint(crop((x) => (x < 16 ? [0, 0, 0, 255] : [80, 90, 70, 255])), 32, 32), false, 'a swath edge through the point keeps the day');
  });

  it('keeps imagery, dark water and a black edge away from the point', () => {
    assert.equal(hasNoDataAtPoint(crop(() => [14, 30, 52, 255]), 32, 32), false, 'dark sea');
    assert.equal(hasNoDataAtPoint(crop((x) => (x < 8 ? [0, 0, 0, 255] : [180, 170, 150, 255])), 32, 32), false);
  });

  it('samples around the point where the crop slid inside the antimeridian or a pole', () => {
    const atEastEdge = pointInCrop({ lat: 0, lon: 179.999 }, cropBox({ lat: 0, lon: 179.999 }));
    assert.ok(atEastEdge.x > 0.95, `the point sits at the east edge, not the centre (x=${atEastEdge.x})`);
    assert.ok(Math.abs(atEastEdge.y - 0.5) < 0.01);
    const atPole = pointInCrop({ lat: 89.999, lon: 10 }, cropBox({ lat: 89.999, lon: 10 }));
    assert.ok(atPole.y < 0.05, `the point sits at the north edge (y=${atPole.y})`);
    const palm = pointInCrop({ lat: 25.112, lon: 55.139 }, cropBox({ lat: 25.112, lon: 55.139 }));
    assert.ok(Math.abs(palm.x - 0.5) < 0.01 && Math.abs(palm.y - 0.5) < 0.01, 'away from the edges the point is the centre');

    const swathEndsWestOfPoint = crop((x) => (x < 24 ? [80, 90, 70, 255] : [0, 0, 0, 255]));
    assert.equal(hasNoDataAtPoint(swathEndsWestOfPoint, 32, 32), false, 'the crop centre has data');
    assert.equal(hasNoDataAtPoint(swathEndsWestOfPoint, 32, 32, atEastEdge), true, 'the point at the east edge has none');
    const swathEndsEastOfCentre = crop((x) => (x < 24 ? [0, 0, 0, 255] : [80, 90, 70, 255]));
    assert.equal(hasNoDataAtPoint(swathEndsEastOfCentre, 32, 32), true);
    assert.equal(hasNoDataAtPoint(swathEndsEastOfCentre, 32, 32, atEastEdge), false, 'a day with data at the point is kept');
  });
});
