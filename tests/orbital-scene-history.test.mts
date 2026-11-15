/**
 * #10758 item 4: the viewer's compare history searches only the selected
 * mission's collections, follows every result page, and is reused for the
 * point within the tab, never keeping a failure.
 */
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { HISTORY_REUSE_MS, searchSceneHistory } from '../src/services/orbital/scene-history.ts';
import { ARCHIVE_RESPONSES, FIXTURE_NOW, fakeArchiveFetch } from './helpers/orbital-archive-fetch.mts';

const HOUR = 3_600_000;
const dubai = ARCHIVE_RESPONSES.points.dubai;
let nextLat = 0;
/** A point of its own per test, so the tab-wide cache never answers from an earlier test. */
const freshPoint = () => ({ lat: dubai.lat + (++nextLat) * 1e-6, lon: dubai.lon });
const searchBodies = (requests: Array<{ url: string; body?: string }>) =>
  requests.filter(({ url }) => url.endsWith('/search')).map(({ body }) => JSON.parse(body!) as { collections: string[] });

describe('compare history search', () => {
  it('asks the archive only for the selected mission', async () => {
    const { fetch, requests } = fakeArchiveFetch(dubai);
    const point = freshPoint();
    await searchSceneHistory(point, 'sentinel-2', FIXTURE_NOW, { fetch });
    await searchSceneHistory(point, 'landsat', FIXTURE_NOW, { fetch });
    await searchSceneHistory(point, 'sentinel-1', FIXTURE_NOW, { fetch });
    const searches = requests.filter(({ url }) => url.endsWith('/search'));
    assert.deepEqual(searches.map(({ url }) => new URL(url).hostname), ['planetarycomputer.microsoft.com', 'planetarycomputer.microsoft.com', 'earth-search.aws.element84.com']);
    assert.deepEqual(searchBodies(requests).map((body) => body.collections), [['sentinel-2-l2a'], ['landsat-c2-l2'], ['sentinel-1-grd']]);
  });

  it('follows the next page and keeps the mission filter on it', async () => {
    const features = dubai['planetary-computer'].features.filter((feature) => feature.collection === 'sentinel-2-l2a');
    assert.ok(features.length >= 2, 'the fixture holds two Sentinel-2 scenes to split across pages');
    const bodies: Array<{ collections: string[] }> = [];
    const fetch = async (_url: string, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body)) as { collections: string[]; token?: string };
      bodies.push(body);
      return body.token
        ? Response.json({ features: features.slice(1), links: [] })
        : Response.json({ features: features.slice(0, 1), links: [{ rel: 'next', method: 'POST', merge: true, body: { token: 'page-2' }, href: 'https://planetarycomputer.microsoft.com/api/stac/v1/search' }] });
    };
    const history = await searchSceneHistory(freshPoint(), 'sentinel-2', FIXTURE_NOW, { fetch });
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies.map((body) => body.collections), [['sentinel-2-l2a'], ['sentinel-2-l2a']]);
    assert.equal(history.status, 'ok');
    const onePage = await searchSceneHistory(freshPoint(), 'sentinel-2', FIXTURE_NOW, { fetch: async () => Response.json({ features: features.slice(0, 1), links: [] }) });
    assert.ok(history.status === 'ok' && onePage.status === 'ok' && history.scenes.length > onePage.scenes.length, 'the second page adds scenes');
  });

  it('reuses the answer for the point when the viewer opens again, and searches again for another mission or point', async () => {
    const { fetch, requests } = fakeArchiveFetch(dubai);
    const point = freshPoint();
    const first = await searchSceneHistory(point, 'sentinel-2', FIXTURE_NOW, { fetch });
    const again = await searchSceneHistory(point, 'sentinel-2', FIXTURE_NOW + HOUR, { fetch });
    assert.equal(searchBodies(requests).length, 1);
    assert.equal(first.status, 'ok');
    assert.deepEqual(again, first);

    await searchSceneHistory(point, 'landsat', FIXTURE_NOW, { fetch });
    await searchSceneHistory(freshPoint(), 'sentinel-2', FIXTURE_NOW, { fetch });
    assert.equal(searchBodies(requests).length, 3);
  });

  it('searches again once the answer is older than the reuse span', async () => {
    const { fetch, requests } = fakeArchiveFetch(dubai);
    const point = freshPoint();
    const realNow = Date.now();
    mock.method(Date, 'now', () => realNow);
    try {
      await searchSceneHistory(point, 'sentinel-2', FIXTURE_NOW, { fetch });
      (Date.now as unknown as { mock: { mockImplementation(f: () => number): void } }).mock.mockImplementation(() => realNow + HISTORY_REUSE_MS + 1);
      await searchSceneHistory(point, 'sentinel-2', FIXTURE_NOW, { fetch });
    } finally {
      mock.restoreAll();
    }
    await searchSceneHistory(point, 'sentinel-2', FIXTURE_NOW + HISTORY_REUSE_MS + HOUR, { fetch });
    assert.equal(searchBodies(requests).length, 3, 'a later lookup past the reuse span also searches again');
  });

  it('never keeps a failure', async () => {
    const point = freshPoint();
    const down = fakeArchiveFetch(dubai, { failing: ['planetarycomputer.microsoft.com'] });
    const failed = await searchSceneHistory(point, 'sentinel-2', FIXTURE_NOW, { fetch: down.fetch });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.status === 'failed' && failed.failure.reason, 'http-status');
    const retried = await searchSceneHistory(point, 'sentinel-2', FIXTURE_NOW, { fetch: down.fetch });
    assert.equal(searchBodies(down.requests).length, 2);
    assert.equal(retried.status, 'failed');
  });

  it('a viewer that closes mid-search does not cancel the search another viewer waits on', async () => {
    let answer!: () => void;
    const { fetch: answering } = fakeArchiveFetch(dubai);
    let searches = 0;
    const fetch = async (url: string, init?: RequestInit) => {
      searches++;
      await new Promise<void>((resolve) => { answer = resolve; });
      return answering(url, init);
    };
    const point = freshPoint();
    const closed = new AbortController();
    const first = searchSceneHistory(point, 'sentinel-2', FIXTURE_NOW, { fetch, signal: closed.signal });
    const second = searchSceneHistory(point, 'sentinel-2', FIXTURE_NOW, { fetch });
    await new Promise((resolve) => setTimeout(resolve, 0));
    closed.abort();
    assert.equal((await first).status, 'failed');
    answer();
    const kept = await second;
    assert.equal(searches, 1);
    assert.equal(kept.status, 'ok');
    assert.ok(kept.status === 'ok' && kept.scenes.length > 0);
  });
});
