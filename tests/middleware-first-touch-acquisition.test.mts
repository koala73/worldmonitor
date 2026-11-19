import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import middleware from '../middleware';
import { ACQUISITION_COOKIE_NAME } from '../shared/acquisition-source.ts';
import {
  CHOKEPOINT_LIVE_START,
  renderChokepointLiveSection,
} from '../scripts/crawlable-chokepoint-live.mjs';

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const NAVIGATION = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'user-agent': BROWSER_UA,
};
const COUNTRY_FROM_CHATGPT = 'https://www.worldmonitor.app/countries/iran/?utm_source=chatgpt.com';

function request(url: string, headers: Record<string, string> = {}, method = 'GET'): Request {
  return new Request(url, { method, headers: { ...NAVIGATION, ...headers } });
}

function acquisitionCookie(response: Response | undefined | void): Record<string, unknown> | null {
  const setCookie = response instanceof Response ? response.headers.get('set-cookie') : null;
  if (!setCookie) return null;
  const pair = setCookie.split(';')[0]!;
  assert.ok(pair.startsWith(`${ACQUISITION_COOKIE_NAME}=`), pair);
  return JSON.parse(decodeURIComponent(pair.slice(ACQUISITION_COOKIE_NAME.length + 1)));
}

function failOnFetch() {
  mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  });
}

afterEach(() => mock.restoreAll());

describe('first-touch acquisition at the edge', () => {
  it('sets the first-touch cookie on a static page passed through to the origin', async () => {
    failOnFetch();
    const response = await middleware(request(COUNTRY_FROM_CHATGPT));
    assert.ok(response instanceof Response);
    assert.equal(response.headers.get('x-middleware-next'), '1');
    const record = acquisitionCookie(response);
    assert.equal(record?.source, 'chatgpt-com');
    assert.equal(record?.referrer, 'direct');
    assert.equal(record?.landing, 'countries');
    assert.equal(record?.path, '/countries/iran/');
    assert.match(response.headers.get('set-cookie')!, /domain=\.worldmonitor\.app/);
    assert.doesNotMatch(response.headers.get('set-cookie')!, /utm_source/);
  });

  it('records the external referrer the navigation carried', async () => {
    failOnFetch();
    const response = await middleware(request('https://www.worldmonitor.app/blog/posts/x/', {
      referer: 'https://www.perplexity.ai/search/abc',
    }));
    const record = acquisitionCookie(response);
    assert.equal(record?.referrer, 'perplexity.ai');
    assert.equal(record?.landing, 'blog');
    assert.equal(record?.path, '/blog/posts/x/');
  });

  it('falls back to Accept when the browser sends no fetch metadata', async () => {
    failOnFetch();
    const response = await middleware(request(COUNTRY_FROM_CHATGPT, { 'sec-fetch-dest': '', 'sec-fetch-mode': '' }));
    assert.equal(acquisitionCookie(response)?.landing, 'countries');
  });

  it('sets nothing when a first touch is already stored', async () => {
    failOnFetch();
    const stored = encodeURIComponent(JSON.stringify({ source: 'reddit', referrer: 'reddit.com', capturedAt: Date.now() - 60_000 }));
    const response = await middleware(request(COUNTRY_FROM_CHATGPT, { cookie: `${ACQUISITION_COOKIE_NAME}=${stored}` }));
    assert.equal(acquisitionCookie(response), null);
  });

  it('sets nothing for a crawler', async () => {
    failOnFetch();
    const response = await middleware(request('https://www.worldmonitor.app/countries/iran/', {
      'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    }));
    assert.equal(acquisitionCookie(response), null);
  });

  it('sets nothing for API calls, subresource fetches, prefetches or non-GET requests', async () => {
    failOnFetch();
    const cases: Request[] = [
      request('https://www.worldmonitor.app/api/version?utm_source=chatgpt.com'),
      request('https://www.worldmonitor.app/mcp?utm_source=chatgpt.com'),
      request(COUNTRY_FROM_CHATGPT, { 'sec-fetch-dest': 'empty', accept: '*/*' }),
      request(COUNTRY_FROM_CHATGPT, { 'sec-fetch-dest': '', 'sec-fetch-mode': '', accept: 'application/json' }),
      request(COUNTRY_FROM_CHATGPT, { 'sec-purpose': 'prefetch;prerender' }),
      request(COUNTRY_FROM_CHATGPT, { purpose: 'prefetch' }),
      request(COUNTRY_FROM_CHATGPT, {}, 'HEAD'),
      request('https://www.worldmonitor.app/chokepoints/strait-of-hormuz/?wm-built=1', {
        'sec-fetch-dest': '', 'sec-fetch-mode': '', accept: 'text/html',
        'user-agent': 'Mozilla/5.0 (compatible; WorldMonitorLivePages/1.0)',
      }),
    ];
    for (const req of cases) {
      const response = await middleware(req);
      assert.equal(acquisitionCookie(response), null, `${req.method} ${req.url} ${[...req.headers].join(' ')}`);
    }
  });

  it('adds the cookie to a redirect without dropping its Location', async () => {
    failOnFetch();
    const response = await middleware(request('https://www.worldmonitor.app/getting-started?utm_source=chatgpt.com'));
    assert.ok(response instanceof Response);
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('location'), 'https://www.worldmonitor.app/docs/getting-started?utm_source=chatgpt.com');
    assert.equal(acquisitionCookie(response)?.source, 'chatgpt-com');
  });

  it('adds the cookie to a live chokepoint page and keeps its rendered body and status', async () => {
    const pageUrl = 'https://www.worldmonitor.app/chokepoints/strait-of-hormuz/';
    const built = `<!doctype html><html><body><main>
${renderChokepointLiveSection({
    chokepoint: { id: 'hormuz_strait', displayName: 'Strait of Hormuz' },
    pulse: {
      disruptionScore: '85', status: 'Red', congestion: 'High', navigationalWarnings: '0 warnings',
      navigationalWarningsAvailable: true, aisDisruptions: '1 AIS disruption', aisSnapshotAvailable: true,
      description: null, officialLatestDate: '2026-10-08', officialLatestTotal: 76, officialAvg7d: 70.4,
      baselineAvgDaily: 87.4, baselineFrom: '2024-10-12', baselineTo: '2025-10-11',
      weekMovement: '-13.6% vs prior week', partial: false, asOf: '2026-10-12T05:02:00.000Z',
    },
  })}
</main></body></html>`;
    mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === `${pageUrl}?wm-built=1`) {
        return new Response(built, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      if (url.includes('/api/supply-chain/v1/get-chokepoint-status')) {
        return Response.json({
          fetchedAt: new Date(Date.now() - 60_000).toISOString(),
          upstreamUnavailable: false,
          chokepoints: [{
            id: 'hormuz_strait', disruptionScore: 62, status: 'yellow', congestionLevel: 'moderate',
            activeWarnings: 2, navigationalWarningsAvailable: true, aisDisruptions: 0, aisSnapshotAvailable: true,
            description: 'Tanker traffic recovering',
            transitSummary: {
              dataAvailable: true, todayTotal: 91, todayCountsAvailable: true, wowChangePct: 4.2,
              officialLatestDate: '2026-10-18', officialLatestTotal: 4, officialAvg7d: 3.7,
              baselineAvgDaily: 87.4, baselineFrom: '2024-10-22', baselineTo: '2025-10-21',
            },
          }],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const response = await middleware(request(`${pageUrl}?utm_source=chatgpt.com`));
    assert.ok(response instanceof Response);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-wm-live-page'), 'chokepoint');
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(acquisitionCookie(response)?.landing, 'chokepoints');
    assert.equal(response.headers.getSetCookie().length, 1);
    const html = await response.text();
    assert.equal(html.split(CHOKEPOINT_LIVE_START).length, 2, 'exactly one live section');
    assert.match(html, /data-chokepoint-score>62</, 'live reading replaced the built one');
    assert.doesNotMatch(html, /data-chokepoint-score>85</);
  });
});
