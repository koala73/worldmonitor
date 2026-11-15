import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { redactSensitiveUrl, scrubSentryCredentials } from '../shared/sensitive-url-params.ts';
import { findArchiveEvidence } from '../src/services/orbital/match.ts';
import { parseStacItem, readPointCondition } from '../src/services/orbital/archive-stac.ts';
import { loadArchiveImage } from '../src/services/orbital/archive-image.ts';
import { cropBox, gibsSnapshotUrl, planetaryComputerCropUrl } from '../src/services/orbital/crop-url.ts';
import { searchSceneHistory } from '../src/services/orbital/scene-history.ts';
import { ARCHIVE_RESPONSES, FIXTURE_NOW, fakeArchiveFetch, fixtureLookup } from './helpers/orbital-archive-fetch.mts';

const ARCHIVE_HOSTS = new Set(['earth-search.aws.element84.com', 'planetarycomputer.microsoft.com', 'gibs.earthdata.nasa.gov', 'view.eumetsat.int']);
const EXACT_POINT = { lat: 25.2049, lon: 55.2708 };

/** Numbers within a degree of the point that carry it at better than 0.1 degree. */
function coordinatesIn(text: string): string[] {
  return (text.match(/-?\d+\.\d{2,}/g) ?? []).filter((n) => Math.abs(Number(n) - EXACT_POINT.lat) < 1 || Math.abs(Number(n) - EXACT_POINT.lon) < 1);
}

/** DebugBear rum-1.1.2.js names a cross-origin resource by host and path, keeping only the last segment of a long path. */
function reportedName(url: string): string {
  const { hostname, pathname } = new URL(url);
  return hostname.slice(0, 25) + (pathname.length < 30 ? pathname : `/…/${pathname.split('/').pop()}`);
}

async function lookupRequests() {
  const point = { ...ARCHIVE_RESPONSES.points.dubai, ...EXACT_POINT };
  const { fetch, requests } = fakeArchiveFetch(point);
  const evidence = await findArchiveEvidence(await fixtureLookup(EXACT_POINT), { fetch });
  return { evidence, requests };
}

describe('a free lookup keeps the exact point to the archives', () => {
  it('sends requests only to the archives the browser calls directly', async () => {
    const { requests } = await lookupRequests();
    assert.ok(requests.length > 0);
    for (const { url } of requests) assert.ok(ARCHIVE_HOSTS.has(new URL(url).hostname), `${new URL(url).hostname} is an archive`);
    assert.ok(requests.some(({ url, body }) => coordinatesIn(url + (body ?? '')).length > 0), 'the archives do receive the point');
  });

  it('removes the point from every archive request before Sentry sees it', async () => {
    const { requests, evidence } = await lookupRequests();
    const imageUrls = [...evidence.acquisitions.map((a) => a.imageUrl), ...evidence.mosaics.flatMap((m) => m.days.map((d) => d.imageUrl)), ...evidence.frames.flatMap((f) => [f.latest?.imageUrl, ...(f.latest?.fallbacks ?? []).map((frame) => frame.imageUrl)])]
      .filter((url): url is string => Boolean(url));
    const urls = [...requests.map((r) => r.url), ...imageUrls];
    const event = scrubSentryCredentials({
      breadcrumbs: urls.map((url) => ({ category: 'fetch', type: 'http', data: { method: 'GET', url, status_code: 200 } })),
      spans: urls.map((url) => ({ op: 'http.client', description: `GET ${url}`, data: { url } })),
      exception: { values: [{ type: 'TypeError', value: `Failed to fetch ${urls[0]}` }] },
    });
    assert.deepEqual(coordinatesIn(JSON.stringify(event)), []);
    assert.deepEqual(coordinatesIn(JSON.stringify(evidence.failures)), []);
  });

  it('removes the point from archive URLs before analytics sees them', async () => {
    const { requests, evidence } = await lookupRequests();
    for (const url of [...requests.map((r) => r.url), evidence.bestView!.imageUrl!]) {
      assert.deepEqual(coordinatesIn(redactSensitiveUrl(url)), [], url);
    }
  });

  it('removes the bounding box from a Planetary Computer crop breadcrumb', async () => {
    const { evidence } = await lookupRequests();
    const crop = evidence.bestView!.imageUrl!;
    assert.match(crop, /\/item\/bbox\/55\.\d+,25\.\d+/);
    const crumb = scrubSentryCredentials({ category: 'fetch', data: { method: 'GET', url: crop } });
    const scrubbed = new URL(crumb.data.url);
    assert.match(scrubbed.pathname, /\/item\/bbox\/redacted\/512x512\.png$/);
    assert.equal(scrubbed.searchParams.get('collection'), 'sentinel-2-l2a', 'keeps what the archive item was');
  });

  it('removes the bounding-box parameter from a GIBS breadcrumb', async () => {
    const { evidence } = await lookupRequests();
    const gibs = evidence.mosaics[0]!.days[0]!.imageUrl!;
    assert.ok(new URL(gibs).searchParams.get('BBOX'));
    const crumb = scrubSentryCredentials({ category: 'xhr', data: { method: 'GET', url: gibs } });
    const scrubbed = new URL(crumb.data.url);
    assert.equal(scrubbed.searchParams.get('BBOX'), null);
    assert.equal(scrubbed.searchParams.get('LAYERS'), new URL(gibs).searchParams.get('LAYERS'));
    assert.deepEqual(scrubSentryCredentials({ request: { query_string: [['BBOX', '25.1,55.2,25.3,55.3'], ['TIME', '2026-11-12']] } }).request.query_string, [['TIME', '2026-11-12']]);
  });

  it('keeps the point out of what a RUM collector reports, the largest paint included', async () => {
    const { requests, evidence } = await lookupRequests();
    const images = [
      ...evidence.acquisitions.map((a) => ({ archive: a.imageUrl?.includes('planetarycomputer') ? 'planetary-computer' as const : 'earth-search' as const, urls: [a.imageUrl] })),
      ...evidence.mosaics.flatMap((m) => m.days.map((d) => ({ archive: m.archive, urls: [d.imageUrl] }))),
      ...evidence.frames.map((f) => ({ archive: f.archive, urls: [f.latest?.imageUrl, ...(f.latest?.fallbacks ?? []).map((frame) => frame.imageUrl)] })),
    ].map(({ archive, urls }) => ({ archive, urls: urls.filter((url): url is string => Boolean(url)) })).filter(({ urls }) => urls.length > 0);
    // DebugBear rum-1.1.2.js reports the largest-contentful-paint URL with its whole path and, unless the
    // project turns query params off, its query; data: URLs are cut to 20 characters.
    const lcpReport = (url: string) => {
      if (url.startsWith('data:')) return url.slice(0, 20);
      const [path, query] = url.split('?');
      return `${path}${query ? `?${query}` : ''}`.slice(0, 200);
    };
    // Other cross-origin resources are named by host and path, keeping only the last segment of a long path,
    // except the resource whose URL is the largest paint's, which is reported like the paint.
    const resourceName = (url: string, lcpUrl: string) => {
      if (url === lcpUrl) return lcpReport(url);
      const { hostname, pathname } = new URL(url);
      return hostname.slice(0, 25) + (pathname.length < 30 ? pathname : `/…/${pathname.split('/').pop()}`);
    };
    for (const { url } of requests) assert.deepEqual(coordinatesIn(resourceName(url, '')), [], url);
    const leaking = new Set<string>();
    for (const { archive, urls } of images) {
      const carriesPoint = coordinatesIn(lcpReport(urls[0]!)).length > 0;
      if (carriesPoint) leaking.add(archive);
      const fetched: string[] = [];
      const loaded = await loadArchiveImage(archive, urls, { fetch: async (url: string) => { fetched.push(url); return new Response(new Blob([new Uint8Array(8)], { type: 'image/png' })); } });
      assert.equal(loaded.status, 'ok');
      if (loaded.status !== 'ok') continue;
      const { objectUrl } = loaded.image;
      if (carriesPoint) assert.match(objectUrl, /^blob:/, `${urls[0]} is painted from a blob: URL`);
      else assert.equal(objectUrl, urls[0], 'a scene-wide preview is painted as is');
      assert.deepEqual(coordinatesIn(lcpReport(objectUrl)), [], objectUrl);
      for (const url of fetched) assert.deepEqual(coordinatesIn(resourceName(url, objectUrl)), [], url);
      loaded.image.release();
    }
    assert.deepEqual([...leaking].sort(), ['eumetsat', 'nasa-gibs', 'planetary-computer'], 'every point image URL would leak as the largest paint unloaded');
  });

  it('keeps the point out of the request names of the compare history', async () => {
    const point = { ...ARCHIVE_RESPONSES.points.dubai, ...EXACT_POINT };
    const { fetch, requests } = fakeArchiveFetch(point);
    const history = await searchSceneHistory(EXACT_POINT, 'sentinel-2', FIXTURE_NOW, { fetch });
    const imageUrls = [...(history.status === 'ok' ? history.scenes.map((s) => s.imageUrl) : [])]
      .filter((url): url is string => Boolean(url));
    assert.ok(requests.length > 0);
    assert.ok(imageUrls.length > 0);
    for (const { url } of requests) assert.deepEqual(coordinatesIn(reportedName(url)), [], reportedName(url));
    // The viewer paints these crops from what loadArchiveImage returns, so the largest paint is a blob: URL.
    for (const url of imageUrls) {
      assert.ok(coordinatesIn(url).length > 0, 'a compare crop URL carries the point');
      const loaded = await loadArchiveImage('planetary-computer', [url], { fetch: async () => new Response(new Blob([new Uint8Array(8)], { type: 'image/png' })) });
      assert.equal(loaded.status, 'ok');
      if (loaded.status !== 'ok') continue;
      assert.match(loaded.image.objectUrl, /^blob:/, `${reportedName(url)} is painted from a blob: URL`);
      assert.deepEqual(coordinatesIn(loaded.image.objectUrl), [], loaded.image.objectUrl);
      loaded.image.release();
    }
  });

  it('writes a point near zero in fixed decimals, and scrubs exponent-form coordinates too', async () => {
    const nearZero = { lat: 1e-7, lon: 55.2708 };
    const tile = ARCHIVE_RESPONSES.points.dubai['planetary-computer'].features.find((f) => f.assets?.SCL)!;
    const item = parseStacItem('planetary-computer', tile as never)!;
    const urls: string[] = [];
    const bodies: string[] = [];
    await readPointCondition(item, nearZero, { fetch: async (url: string, init?: RequestInit) => { urls.push(url); bodies.push(String(init?.body)); return new Response('{"properties":{"statistics":{"b1":{"majority":4}}}}'); } });
    const box = cropBox(nearZero, 0.00001);
    urls.push(planetaryComputerCropUrl(item.collection, item.itemId, box)!, gibsSnapshotUrl('MODIS_Terra_CorrectedReflectance_TrueColor', '2026-11-12', box)!);
    for (const body of bodies) assert.doesNotMatch(body, /\d[eE][-+]?\d/, `${body} has no exponent`);
    for (const url of urls) {
      assert.doesNotMatch(decodeURIComponent(url), /\d[eE][-+]?\d/, `${url} has no exponent`);
      const crumb = scrubSentryCredentials({ data: { url } });
      assert.doesNotMatch(crumb.data.url, /55\.27/, `${crumb.data.url} is scrubbed`);
    }
    for (const raw of [
      'https://planetarycomputer.microsoft.com/api/data/v1/item/point/55.2708,1e-7?collection=sentinel-2-l2a',
      'https://planetarycomputer.microsoft.com/api/data/v1/item/bbox/55.27,-1E-7,55.28,2.5e-1/512x512.png?collection=sentinel-2-l2a',
      'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?BBOX=1e-7,55.27,2e-7,55.28&TIME=2026-11-12',
    ]) {
      const scrubbed = scrubSentryCredentials({ data: { url: raw } }).data.url;
      assert.doesNotMatch(scrubbed, /55\.27|1e-7|1E-7/, scrubbed);
    }
  });

  it('runs the scrubber on every Sentry breadcrumb and span', () => {
    const init = readFileSync(new URL('../src/bootstrap/sentry-init.ts', import.meta.url), 'utf8');
    for (const hook of ['beforeBreadcrumb', 'beforeSendSpan', 'beforeSend']) assert.match(init, new RegExp(`${hook}[:(]`));
    assert.match(init, /beforeBreadcrumb: scrubSentryCredentials/);
    assert.match(init, /beforeSendSpan: scrubSentryCredentials/);
  });
});
