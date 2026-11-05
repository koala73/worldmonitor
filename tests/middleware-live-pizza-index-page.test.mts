import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import middleware from '../middleware';
import { isPublicSharedRpcRequest } from '../src/shared/public-rpc-cache.ts';
import { renderPizzaIndexSection } from '../scripts/live-pages/pentagon-pizza-index.mjs';

const PAGE_URL = 'https://www.worldmonitor.app/blog/glossary/pentagon-pizza-index/';
const BUILT_URL = `${PAGE_URL}?wm-built=1`;
const STATUS_BASE = 'https://www.worldmonitor.app/api/intelligence/v1/get-pizzint-status';
const START = '<!--wm-live:pentagon-pizza-index-->';
const END = '<!--/wm-live:pentagon-pizza-index-->';

// The blog build ships the loading state: the browser fetches the level.
function builtPage(): string {
  return `<!doctype html><html><body><main>
<h1>Pentagon Pizza Index</h1>
<p>The definition.</p>
${renderPizzaIndexSection(null)}
<section class="faq">FAQ</section>
</main></body></html>`;
}

function venue(name: string, percentageOfUsual: number, extra: Record<string, unknown> = {}) {
  return {
    name,
    currentPopularity: 40,
    percentageOfUsual,
    hasBaseline: true,
    noLiveSignal: false,
    isSpike: false,
    dataFreshness: 'DATA_FRESHNESS_FRESH',
    isClosedNow: false,
    ...extra,
  };
}

function statusPayload(overrides: Record<string, unknown> = {}) {
  return {
    pizzint: {
      defconLevel: 3,
      defconLabel: 'Elevated Activity',
      locationsMonitored: 6,
      updatedAt: Date.now() - 10 * 60_000,
      dataFreshness: 'DATA_FRESHNESS_FRESH',
      locations: [
        venue('Domino\'s <Pentagon City>', 190, { isSpike: true }),
        venue('Quiet Pizza', 100),
      ],
      ...overrides,
    },
    tensionPairs: [],
  };
}

type Route = (url: string) => Response | Promise<Response>;

function stubFetch(route: Route) {
  const calls: string[] = [];
  mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    return route(url);
  });
  return calls;
}

function route(status: () => Response): Route {
  return (url) => {
    if (url.startsWith(STATUS_BASE)) return status();
    if (url === BUILT_URL) {
      return new Response(builtPage(), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'content-length': '999', etag: 'W/"built"' },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

function pageRequest(method = 'GET', url = PAGE_URL, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method,
    headers: { accept: 'text/html,*/*;q=0.8', 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)', ...headers },
  });
}

function section(html: string): string {
  const from = html.indexOf(START);
  const to = html.indexOf(END, from);
  assert.ok(from !== -1 && to !== -1, 'the live section is marked');
  assert.equal(html.indexOf(START, from + 1), -1, 'the live section appears once');
  return html.slice(from, to + END.length);
}

async function serve(status: () => Response) {
  const calls = stubFetch(route(status));
  const response = await middleware(pageRequest());
  assert.ok(response instanceof Response);
  return { response, html: await response.text(), calls };
}

afterEach(() => mock.restoreAll());

describe('live Pentagon Pizza Index page HTML', () => {
  it('puts the current level into the page a crawler fetches', async () => {
    const { response, html, calls } = await serve(() => Response.json(statusPayload()));

    assert.equal(response.headers.get('x-wm-live-page'), 'pentagon-pizza-index');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=300, must-revalidate');
    assert.equal(response.headers.get('etag'), null);
    assert.equal(response.headers.get('content-length'), null);

    const live = section(html);
    assert.doesNotMatch(live, /Loading the live level/);
    assert.match(live, /data-state="ready"/);
    assert.match(live, /data-published-pulse/);
    assert.match(live, /<p class="live-reading-answer" data-live-answer>As of .+ UTC, the Pentagon Pizza Index is at level 3, Elevated Activity\.<\/p>/);
    assert.match(live, /<strong data-pizzint-level>3<\/strong>/);
    assert.match(live, /<li>Domino&#39;s &lt;Pentagon City&gt; · Spike \+90%<\/li>/, 'venue names are escaped');
    assert.match(live, /<time data-live-updated datetime="\d{4}-\d\d-\d\dT[^"]+Z">Updated .+<\/time>/);
    assert.match(live, /data-live-fallback hidden/);
    assert.match(html, /<section class="faq">FAQ<\/section>/, 'the rest of the page is untouched');

    assert.ok(calls.includes(BUILT_URL), 'the built page is fetched under its own cache key');
    const statusCall = calls.find((url) => url.startsWith(STATUS_BASE));
    assert.ok(statusCall && isPublicSharedRpcRequest(statusCall), `the reading is the anonymous public shape: ${statusCall}`);
  });

  for (const [label, status] of [
    ['the seed has expired', () => Response.json({ tensionPairs: [] })],
    ['the reading is over an hour old', () => Response.json(statusPayload({ updatedAt: Date.now() - 61 * 60_000 }))],
    ['every venue is closed', () => Response.json(statusPayload({ locations: [venue('Shut', 0, { isClosedNow: true })] }))],
    ['the level is malformed', () => Response.json(statusPayload({ defconLevel: 9 }))],
    ['the API fails', () => new Response('nope', { status: 503 })],
  ] as const) {
    it(`serves the built page unchanged when ${label}`, async () => {
      const { response, html } = await serve(status);
      assert.equal(html, builtPage());
      assert.equal(response.headers.get('x-wm-live-page'), null);
    });
  }

  it('leaves the inner fetch, HEAD and other glossary pages on the static path', async () => {
    const calls = stubFetch(route(() => Response.json(statusPayload())));
    assert.equal(await middleware(pageRequest('GET', BUILT_URL)), undefined);
    assert.equal(await middleware(pageRequest('HEAD')), undefined);
    assert.equal(await middleware(pageRequest('GET', 'https://www.worldmonitor.app/blog/glossary/osint/')), undefined);
    assert.equal(calls.length, 0);
  });
});

describe('Pizza Index status public shape', () => {
  it('accepts only the bare public marker', () => {
    assert.equal(isPublicSharedRpcRequest(`${STATUS_BASE}?public=1`), true);
    assert.equal(isPublicSharedRpcRequest(`${STATUS_BASE}?public=1&rpc=get-pizzint-status`), true, 'the router echo is stripped');
    // include_gdelt widens the read to the tension pairs; it stays credentialed.
    assert.equal(isPublicSharedRpcRequest(`${STATUS_BASE}?public=1&include_gdelt=true`), false);
    assert.equal(isPublicSharedRpcRequest(`${STATUS_BASE}?include_gdelt=true&public=1`), false);
    assert.equal(isPublicSharedRpcRequest(`${STATUS_BASE}?public=1&public=1`), false);
    assert.equal(isPublicSharedRpcRequest(STATUS_BASE), false);
    assert.equal(isPublicSharedRpcRequest(`${STATUS_BASE}?public=1`, 'POST'), false);
  });
});
