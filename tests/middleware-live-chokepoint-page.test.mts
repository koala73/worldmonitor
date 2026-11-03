import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import middleware from '../middleware';
import {
  CHOKEPOINT_LIVE_START,
  renderChokepointLiveSection,
  replaceChokepointLiveSection,
} from '../scripts/crawlable-chokepoint-live.mjs';
import { isPublicSharedRpcRequest } from '../src/shared/public-rpc-cache.ts';

const PAGE_URL = 'https://www.worldmonitor.app/chokepoints/strait-of-hormuz/';
const BUILT_URL = `${PAGE_URL}?wm-built=1`;
const HORMUZ = {
  id: 'hormuz_strait',
  displayName: 'Strait of Hormuz',
};

const PUBLISHED_PULSE = {
  disruptionScore: '85',
  status: 'Red',
  congestion: 'High',
  navigationalWarnings: '0 warnings',
  navigationalWarningsAvailable: true,
  aisDisruptions: '1 AIS disruption',
  aisSnapshotAvailable: true,
  description: null,
  officialLatestDate: '2026-10-08',
  officialLatestTotal: 76,
  officialAvg7d: 70.4,
  baselineAvgDaily: 87.4,
  baselineFrom: '2024-10-12',
  baselineTo: '2025-10-11',
  weekMovement: '-13.6% vs prior week',
  partial: false,
  asOf: '2026-10-12T05:02:00.000Z',
};

function builtPage(): string {
  return `<!doctype html><html><body><main>
      <h1>Strait of Hormuz</h1>
${renderChokepointLiveSection({ chokepoint: HORMUZ, pulse: PUBLISHED_PULSE })}
      <a class="cta" href="/dashboard?chokepoint=hormuz_strait">Open</a>
</main></body></html>`;
}

function statusPayload(fetchedAt = new Date(Date.now() - 60_000).toISOString()) {
  return {
    fetchedAt,
    upstreamUnavailable: false,
    chokepoints: [{
      id: 'hormuz_strait',
      disruptionScore: 62,
      status: 'yellow',
      congestionLevel: 'moderate',
      activeWarnings: 2,
      navigationalWarningsAvailable: true,
      aisDisruptions: 0,
      aisSnapshotAvailable: true,
      description: 'Tanker traffic recovering',
      // todayTotal is the relay's AIS zone-exit count (port traffic included);
      // the page must never present it as transits. The official figures are
      // the IMF PortWatch tail of 2026-10-22.
      transitSummary: {
        dataAvailable: true, todayTotal: 91, todayCountsAvailable: true, wowChangePct: 4.2,
        officialLatestDate: '2026-10-18', officialLatestTotal: 4, officialAvg7d: 3.7,
        baselineAvgDaily: 87.4, baselineFrom: '2024-10-22', baselineTo: '2025-10-21',
      },
    }],
  };
}

function pageRequest(headers: Record<string, string> = {}, method = 'GET', url = PAGE_URL): Request {
  return new Request(url, {
    method,
    headers: { accept: 'text/html,*/*;q=0.8', 'user-agent': 'Mozilla/5.0 (compatible; OAI-SearchBot/1.0)', ...headers },
  });
}

type Route = (input: string, init?: RequestInit) => Response | Promise<Response>;

function stubFetch(route: Route) {
  const calls: { url: string; headers: Headers }[] = [];
  mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, headers: new Headers(init?.headers) });
    return route(url, init);
  });
  return calls;
}

function servePage(url: string): Response {
  if (url === BUILT_URL) {
    return new Response(builtPage(), {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=3600, must-revalidate',
        'cdn-cache-control': 'public, s-maxage=600, stale-while-revalidate=60',
        'content-length': '999',
        etag: 'W/"built"',
        'last-modified': 'Mon, 12 Oct 2026 05:02:48 GMT',
      },
    });
  }
  throw new Error(`unexpected fetch ${url}`);
}

afterEach(() => mock.restoreAll());

describe('live chokepoint page HTML', () => {
  it('replaces the published pulse with the current reading', async () => {
    const calls = stubFetch((url) => (url.includes('/api/supply-chain/v1/get-chokepoint-status')
      ? Response.json(statusPayload())
      : servePage(url)));

    const response = await middleware(pageRequest());
    assert.ok(response instanceof Response);
    const html = await response.text();

    assert.equal(response.headers.get('x-wm-live-page'), 'chokepoint');
    assert.equal(response.headers.get('content-length'), null, 'stale framing header dropped');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=300, must-revalidate');
    assert.equal(response.headers.get('cdn-cache-control'), 'public, s-maxage=300, stale-while-revalidate=60');
    assert.equal(response.headers.get('etag'), null, 'the built file validator does not describe the live body');
    assert.equal(response.headers.get('last-modified'), null);
    assert.match(html, /data-chokepoint-official-transits>4<\/span><small data-chokepoint-official-date>Oct 18, 2026</);
    assert.match(html, /data-chokepoint-official-average>3\.7 a day · 4% of 87\.4</);
    assert.match(html, /data-chokepoint-movement>\+4\.2% vs prior week</);
    assert.match(
      html,
      /IMF PortWatch counted 4 transits through the Strait of Hormuz on Oct 18, 2026 \(latest published day\)\. The 7-day average is 3\.7 a day, 4% of the 87\.4-a-day average for Oct 2024–Oct 2025\./,
    );
    assert.match(html, /data-chokepoint-score>62</);
    assert.match(html, /Live reading /);
    assert.match(html, /data-live-at-request/);
    assert.doesNotMatch(html, /data-chokepoint-official-transits>76</, 'week-old count is gone');
    assert.doesNotMatch(html, /\b91\b/, 'the relay AIS zone-exit count is not presented as transits');
    assert.doesNotMatch(html, /Today's transits|data-chokepoint-transits\b|data-transit-measurement-note/);
    assert.doesNotMatch(html, /Published pulse/);
    assert.equal(html.split(CHOKEPOINT_LIVE_START).length, 2, 'exactly one live section');

    assert.ok(calls.some((call) => call.url === BUILT_URL), 'the built page is fetched under its own cache key');
    const statusFetch = calls.find((call) => call.url.includes('get-chokepoint-status'));
    assert.equal(new URL(statusFetch!.url).search, '?public=1');
    assert.ok(isPublicSharedRpcRequest(statusFetch!.url), 'the status read is the anonymous public shape');
  });

  it('serves the built page unchanged when the reading is unavailable', async () => {
    stubFetch((url) => (url.includes('get-chokepoint-status')
      ? new Response('nope', { status: 503 })
      : servePage(url)));
    const response = await middleware(pageRequest());
    assert.ok(response instanceof Response);
    assert.equal(await response.text(), builtPage());
    assert.equal(response.headers.get('x-wm-live-page'), null);
    assert.equal(
      response.headers.get('cache-control'),
      'public, max-age=300, must-revalidate',
      'a fallback is not held in the browser for an hour after the reading recovers',
    );
    assert.equal(response.headers.get('cdn-cache-control'), 'public, s-maxage=300, stale-while-revalidate=60');
  });

  it('serves the built page when the reading is too old to vouch for', async () => {
    stubFetch((url) => (url.includes('get-chokepoint-status')
      ? Response.json(statusPayload(new Date(Date.now() - 72 * 3_600_000).toISOString()))
      : servePage(url)));
    const response = await middleware(pageRequest());
    assert.ok(response instanceof Response);
    assert.equal(await response.text(), builtPage());
  });

  it('hands the request back to the origin when the built page cannot be fetched', async () => {
    stubFetch(() => new Response('gone', { status: 404 }));
    const response = await middleware(pageRequest());
    assert.ok(response instanceof Response);
    assert.equal(response.headers.get('x-middleware-next'), '1');
  });

  it('leaves the inner fetch, HEAD and markdown requests on the static path', async () => {
    const calls = stubFetch(servePage);
    assert.equal(await middleware(pageRequest({}, 'GET', BUILT_URL)), undefined);
    assert.equal(await middleware(pageRequest({}, 'HEAD')), undefined);
    assert.equal(await middleware(pageRequest({ accept: 'text/markdown' })), undefined);
    assert.equal(calls.length, 0);
  });
});

describe('replaceChokepointLiveSection', () => {
  it('refuses pages without exactly one marked section', () => {
    const section = renderChokepointLiveSection({ chokepoint: HORMUZ, pulse: PUBLISHED_PULSE, live: true });
    assert.equal(replaceChokepointLiveSection('<main></main>', section), null);
    assert.equal(replaceChokepointLiveSection(builtPage() + builtPage(), section), null);
  });
});

describe('chokepoint status public shape', () => {
  it('accepts only the bare public marker', () => {
    const base = 'https://www.worldmonitor.app/api/supply-chain/v1/get-chokepoint-status';
    assert.equal(isPublicSharedRpcRequest(`${base}?public=1`), true);
    assert.equal(isPublicSharedRpcRequest(`${base}?public=1&x=1`), false);
    assert.equal(isPublicSharedRpcRequest(base), false);
    assert.equal(isPublicSharedRpcRequest(`${base}?public=1`, 'POST'), false);
  });
});
