/**
 * #10758 item 3: archive searches and GIBS time domains are shared in browser
 * memory. An identical fresh request makes no new search, overlapping consumers
 * share one request, one consumer aborting never cancels another, and expiry or
 * a failure searches again.
 */
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { GIBS_DAILY_MOSAICS, searchGibsDailyMosaics } from '../src/services/orbital/archive-gibs.ts';
import { searchStacArchive, STAC_RESULT_FRESH_MS } from '../src/services/orbital/archive-stac.ts';

const DAY = 86_400_000;
const point = { lat: 25.12, lon: 51.31 };
const feature = (id: string, datetime: string) => ({
  type: 'Feature', id, collection: 'sentinel-2-l2a', bbox: [51, 25, 52, 26],
  properties: { datetime, 'eo:cloud_cover': 3, platform: 'sentinel-2a' },
  assets: { thumbnail: { href: `https://example.test/${id}.jpg` } }, links: [],
});

function stacFetch(reply: () => Response | Promise<Response> = () => Response.json({ features: [feature('S2A_A', new Date(Date.now() - 2 * DAY).toISOString())], links: [] })) {
  const calls: Array<{ signal?: AbortSignal | null }> = [];
  const fetch = async (_url: string, init: RequestInit = {}) => { calls.push({ signal: init.signal }); return reply(); };
  return { fetch, calls };
}
const lastDays = (days: number, nowMs = Date.now()) => ({ startMs: nowMs - days * DAY, endMs: nowMs });

describe('shared STAC search cache', () => {
  it('answers an identical fresh search without a new request', async () => {
    const { fetch, calls } = stacFetch();
    const window = lastDays(30);
    const first = await searchStacArchive('earth-search', { point, window, fetch });
    const second = await searchStacArchive('earth-search', { point, window, fetch });

    assert.equal(calls.length, 1);
    assert.deepEqual(second, first);
    assert.equal(first.status === 'ok' && first.items.length, 1);
  });

  it('answers a narrower window and fewer collections from a broader search', async () => {
    const { fetch, calls } = stacFetch();
    await searchStacArchive('earth-search', { point, window: lastDays(30), fetch });
    const narrow = await searchStacArchive('earth-search', { point, window: lastDays(1), fetch, collections: ['sentinel-2-l2a'] });

    assert.equal(calls.length, 1);
    assert.equal(narrow.status === 'ok' && narrow.items.length, 0, 'the two-day-old scene falls outside one day');
  });

  it('searches again for a wider window, another point, or another archive', async () => {
    const { fetch, calls } = stacFetch();
    await searchStacArchive('earth-search', { point, window: lastDays(7), fetch });
    await searchStacArchive('earth-search', { point, window: lastDays(30), fetch });
    await searchStacArchive('earth-search', { point: { lat: 25.13, lon: 51.31 }, window: lastDays(30), fetch });
    await searchStacArchive('planetary-computer', { point, window: lastDays(30), fetch });
    assert.equal(calls.length, 4);
  });

  it('never keeps a failure: the next consumer searches again', async () => {
    let fail = true;
    const { fetch, calls } = stacFetch(() => fail ? new Response('down', { status: 503 }) : Response.json({ features: [], links: [] }));
    const window = lastDays(30);
    assert.equal((await searchStacArchive('earth-search', { point, window, fetch })).status, 'failed');
    fail = false;
    assert.equal((await searchStacArchive('earth-search', { point, window, fetch })).status, 'ok');
    assert.equal(calls.length, 2);
  });

  it('searches again once the answer is no longer fresh', async () => {
    const { fetch, calls } = stacFetch();
    const realNow = Date.now();
    const window = lastDays(30, realNow);
    mock.method(Date, 'now', () => realNow);
    try {
      await searchStacArchive('earth-search', { point, window, fetch });
      (Date.now as unknown as { mock: { mockImplementation(f: () => number): void } }).mock.mockImplementation(() => realNow + STAC_RESULT_FRESH_MS + 1);
      await searchStacArchive('earth-search', { point, window, fetch });
    } finally {
      mock.restoreAll();
    }
    assert.equal(calls.length, 2);
  });

  it('overlapping consumers share one request, and one aborting does not cancel the other', async () => {
    let answer!: (response: Response) => void;
    const { fetch, calls } = stacFetch(() => new Promise<Response>((resolve) => { answer = resolve; }));
    const window = lastDays(30);
    const closed = new AbortController();
    const first = searchStacArchive('earth-search', { point, window, fetch, signal: closed.signal });
    const second = searchStacArchive('earth-search', { point, window, fetch });
    await new Promise((resolve) => setTimeout(resolve, 0));
    closed.abort();

    assert.deepEqual(await first, { status: 'failed', archive: 'earth-search', failure: { archive: 'earth-search', reason: 'aborted' } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.signal?.aborted, false);
    answer(Response.json({ features: [feature('S2A_A', new Date(Date.now() - DAY).toISOString())], links: [] }));
    const shared = await second;
    assert.equal(shared.status === 'ok' && shared.items.length, 1);
  });

  it('cancels the request once every consumer has aborted, and the next consumer searches again', async () => {
    const { fetch, calls } = stacFetch(() => new Promise<Response>(() => {}));
    const window = lastDays(30);
    const closed = new AbortController();
    const first = searchStacArchive('earth-search', { point, window, fetch, signal: closed.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    closed.abort();
    await first;

    assert.equal(calls[0]!.signal?.aborted, true);
    void searchStacArchive('earth-search', { point, window, fetch, signal: AbortSignal.timeout(20) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.length, 2);
  });

  it('a consumer that arrives already aborted leaves no request running, and the next consumer searches again', async () => {
    const { fetch, calls } = stacFetch(() => new Promise<Response>(() => {}));
    const window = lastDays(30);
    const result = await searchStacArchive('earth-search', { point, window, fetch, signal: AbortSignal.abort() });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(result.status, 'failed');
    assert.ok(calls.every((call) => call.signal?.aborted), 'nobody waits on it, so it is cancelled');
    const before = calls.length;
    void searchStacArchive('earth-search', { point, window, fetch, signal: AbortSignal.timeout(20) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.length, before + 1);
  });
});

describe('shared GIBS time-domain cache', () => {
  const domainFetch = () => {
    const urls: string[] = [];
    const fetch = async (url: string) => { urls.push(url); return new Response('<Domain>2026-11-10/2026-11-14/P1D</Domain>'); };
    return { fetch, urls };
  };
  const norad = (source: string) => new Set([GIBS_DAILY_MOSAICS.find((layer) => layer.source === source)!.noradId]);
  const nowMs = Date.parse('2026-11-15T12:00:00Z');
  const day = { startMs: Date.parse('2026-11-14T00:00:00Z'), endMs: Date.parse('2026-11-14T23:59:59Z') };

  it('asks once per layer and day across fire dots at different points', async () => {
    const { fetch, urls } = domainFetch();
    await searchGibsDailyMosaics({ point, window: day, fetch, nowMs, noradIds: norad('VIIRS Suomi NPP') });
    await searchGibsDailyMosaics({ point: { lat: 48.5, lon: 37.25 }, window: day, fetch, nowMs, noradIds: norad('VIIRS Suomi NPP') });
    await searchGibsDailyMosaics({ point, window: day, fetch, nowMs, noradIds: norad('MODIS Aqua') });

    assert.equal(urls.length, 2);
    assert.ok(urls.every((url) => !url.includes('48.5') && !url.includes('25.12')), 'the domain request carries no point');
  });

  it('never keeps a failed domain', async () => {
    let fail = true;
    const urls: string[] = [];
    const fetch = async (url: string) => { urls.push(url); return fail ? new Response('', { status: 503 }) : new Response('<Domain>2026-11-10/2026-11-13/P1D</Domain>'); };
    const window = { startMs: Date.parse('2026-11-13T00:00:00Z'), endMs: Date.parse('2026-11-13T23:59:59Z') };
    await searchGibsDailyMosaics({ point, window, fetch, nowMs, noradIds: norad('MODIS Terra') });
    fail = false;
    const again = await searchGibsDailyMosaics({ point, window, fetch, nowMs, noradIds: norad('MODIS Terra') });

    assert.equal(urls.length, 2);
    assert.equal(again.status, 'ok');
  });
});
