import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { redactSensitiveUrl, scrubSentryCredentials } from '../shared/sensitive-url-params.ts';
import { findArchiveEvidence } from '../src/services/orbital/match.ts';
import { parseStacItem, readPointCondition } from '../src/services/orbital/archive-stac.ts';
import { cropBox, gibsSnapshotUrl, planetaryComputerCropUrl } from '../src/services/orbital/crop-url.ts';
import { ARCHIVE_RESPONSES, fakeArchiveFetch, fixtureLookup } from './helpers/orbital-archive-fetch.mts';

const ARCHIVE_HOSTS = new Set(['earth-search.aws.element84.com', 'planetarycomputer.microsoft.com', 'gibs.earthdata.nasa.gov', 'view.eumetsat.int']);
const EXACT_POINT = { lat: 25.2049, lon: 55.2708 };

/** Numbers within a degree of the point that carry it at better than 0.1 degree. */
function coordinatesIn(text: string): string[] {
  return (text.match(/-?\d+\.\d{2,}/g) ?? []).filter((n) => Math.abs(Number(n) - EXACT_POINT.lat) < 1 || Math.abs(Number(n) - EXACT_POINT.lon) < 1);
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

  it('keeps the point out of the request names a RUM collector reports', async () => {
    const { requests, evidence } = await lookupRequests();
    const imageUrls = [...evidence.acquisitions.map((a) => a.imageUrl), ...evidence.mosaics.flatMap((m) => m.days.map((d) => d.imageUrl)), ...evidence.frames.flatMap((f) => [f.latest?.imageUrl, ...(f.latest?.fallbacks ?? []).map((frame) => frame.imageUrl)])]
      .filter((url): url is string => Boolean(url));
    // DebugBear rum-1.1.2.js names a cross-origin resource by host and path, keeping only the last segment of a long path.
    const reportedName = (url: string) => {
      const { hostname, pathname } = new URL(url);
      return hostname.slice(0, 25) + (pathname.length < 30 ? pathname : `/…/${pathname.split('/').pop()}`);
    };
    for (const url of [...requests.map((r) => r.url), ...imageUrls]) assert.deepEqual(coordinatesIn(reportedName(url)), [], reportedName(url));
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
