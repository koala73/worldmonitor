import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import middleware from '../middleware';
import { isPublicSharedRpcRequest } from '../src/shared/public-rpc-cache.ts';
import {
  headlinesSection,
  outagesSection,
  situationMarkers,
  situationSections,
} from '../scripts/situation-page/sections.mjs';
import { CHOKEPOINT_REGISTRY } from '../src/config/chokepoint-registry.ts';

const SITUATION_SECTIONS = situationSections(CHOKEPOINT_REGISTRY);
const chokepointsSection = SITUATION_SECTIONS[1];

const PAGE_URL = 'https://www.worldmonitor.app/monitor-the-situation/';
const BUILT_URL = `${PAGE_URL}?wm-built=1`;
const HOUR = 3_600_000;

// The published readings a build froze a week before the request.
const PUBLISHED_HEADLINES = {
  asOf: '2026-10-19T04:54:20.887Z',
  rows: [
    { title: 'Published headline one', source: 'Dawn', url: 'https://www.dawn.com/news/1', publishedAt: '2026-10-19T02:28:25.000Z' },
    { title: 'Published headline two', source: 'Meduza', url: 'https://meduza.io/2', publishedAt: '2026-10-19T04:40:00.000Z' },
  ],
};
const PUBLISHED_OUTAGES = {
  asOf: '2026-10-19T04:45:12.907Z',
  total: 1,
  ongoing: 0,
  countries: 1,
  oldest: '2026-10-14T23:30:00.000Z',
  outages: [{ country: 'Namibia', severity: 'Nationwide', cause: 'Power outage', detectedAt: '2026-10-14T23:30:00.000Z', ongoing: false, description: 'Substation fault.', link: null }],
};
const PUBLISHED_CHOKEPOINT_ROWS = CHOKEPOINT_REGISTRY.map((entry, index) => ({
  chokepoint: { id: entry.id, displayName: entry.displayName, slug: entry.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-') },
  score: entry.id === 'hormuz_strait' ? 85 : 10 + index,
  status: entry.id === 'hormuz_strait' ? 'Red' : 'Green',
  congestion: 'Normal',
  aisSnapshotAvailable: true,
  asOf: '2026-10-19T04:50:16.944Z',
}));

function builtPage(): string {
  const sections = [
    headlinesSection.renderSection(PUBLISHED_HEADLINES, { live: false }),
    chokepointsSection.renderSection(chokepointsSection.published(null, { hubRows: PUBLISHED_CHOKEPOINT_ROWS }), { live: false }),
    outagesSection.renderSection(PUBLISHED_OUTAGES, { live: false }),
  ];
  return `<!doctype html><html><body><main>
      <h1>Monitor the situation</h1>
${sections.join('\n')}
      <a class="cta" href="/dashboard">Open</a>
</main></body></html>`;
}

function digestPayload(generatedAt = new Date(Date.now() - 10 * 60_000).toISOString()) {
  return {
    generatedAt,
    coverage: { state: 'complete', servedStale: false },
    categories: {
      world: { items: [
        { title: 'Live headline A', source: 'Reuters', link: 'https://www.reuters.com/world/a', publishedAt: Date.now() - 5 * 60_000, importanceScore: 9 },
        { title: 'Live headline B', source: 'AP', link: 'https://apnews.com/article/b', publishedAt: Date.now() - 50 * 60_000, importanceScore: 7 },
        { title: 'Aggregator copy', source: 'Google News', link: 'https://news.google.com/x', publishedAt: Date.now(), importanceScore: 99 },
      ] },
    },
  };
}

function chokepointPayload(fetchedAt = new Date(Date.now() - 60_000).toISOString()) {
  return {
    fetchedAt,
    upstreamUnavailable: false,
    chokepoints: CHOKEPOINT_REGISTRY.map((entry) => ({
      id: entry.id,
      disruptionScore: entry.id === 'hormuz_strait' ? 62 : 5,
      status: entry.id === 'hormuz_strait' ? 'red' : 'green',
      congestionLevel: 'moderate',
      activeWarnings: 1,
      navigationalWarningsAvailable: true,
      aisDisruptions: 0,
      aisSnapshotAvailable: true,
      transitSummary: { dataAvailable: false },
    })),
  };
}

function outagesPayload(fetchedAt = Date.now() - 20 * 60_000) {
  return {
    fetchedAt,
    outages: [
      { id: 'live', country: 'Panama', severity: 'OUTAGE_SEVERITY_TOTAL', categories: ['NATURAL DISASTER'], detectedAt: Date.now() - 2 * HOUR, endedAt: 0, description: 'Earthquake.', link: 'https://x.com/CloudflareRadar/status/9' },
    ],
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

function servePage(url: string): Response {
  if (url === BUILT_URL) {
    return new Response(builtPage(), {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=3600, must-revalidate',
        'content-length': '999',
        etag: 'W/"built"',
      },
    });
  }
  throw new Error(`unexpected fetch ${url}`);
}

function routeAll({ digest, chokepoints, outages }: { digest?: Route; chokepoints?: Route; outages?: Route }): Route {
  return (url) => {
    if (url.includes('/api/news/v1/list-feed-digest')) return (digest ?? (() => Response.json(digestPayload())))(url);
    if (url.includes('/api/supply-chain/v1/get-chokepoint-status')) return (chokepoints ?? (() => Response.json(chokepointPayload())))(url);
    if (url.includes('/api/infrastructure/v1/list-internet-outages')) return (outages ?? (() => Response.json(outagesPayload())))(url);
    return servePage(url);
  };
}

function pageRequest(headers: Record<string, string> = {}, method = 'GET', url = PAGE_URL): Request {
  return new Request(url, {
    method,
    headers: { accept: 'text/html,*/*;q=0.8', 'user-agent': 'Mozilla/5.0 (compatible; OAI-SearchBot/1.0)', ...headers },
  });
}

/** The HTML between a section's markers. */
function sectionOf(html: string, section: (typeof SITUATION_SECTIONS)[number]): string {
  const { start, end } = situationMarkers(section);
  const from = html.indexOf(start);
  const to = html.indexOf(end, from);
  assert.ok(from !== -1 && to !== -1, `${section.slug} section present once`);
  assert.equal(html.indexOf(start, from + 1), -1, `${section.slug} section present once`);
  return html.slice(from, to);
}

async function serve(route: Route): Promise<{ response: Response; html: string; calls: string[] }> {
  const calls = stubFetch(route);
  const response = await middleware(pageRequest());
  assert.ok(response instanceof Response);
  return { response, html: await response.text(), calls };
}

afterEach(() => mock.restoreAll());

describe('live situation page HTML', () => {
  it('replaces every section with its current reading', async () => {
    const { response, html, calls } = await serve(routeAll({}));

    assert.equal(response.headers.get('x-wm-live-page'), 'situation');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=300, must-revalidate');
    assert.equal(response.headers.get('etag'), null);
    assert.equal(response.headers.get('content-length'), null);

    const headlines = sectionOf(html, headlinesSection);
    assert.match(headlines, /Live headline A/);
    assert.match(headlines, /Live headline B/);
    assert.doesNotMatch(headlines, /Aggregator copy/, 'an aggregator redirect is not a publishable headline');
    assert.doesNotMatch(headlines, /Published headline/);
    assert.match(headlines, /data-live-at-request/);
    assert.match(headlines, /Live reading /);

    const chokepoints = sectionOf(html, chokepointsSection);
    assert.match(chokepoints, /Strait of Hormuz at 62 of 100 \(Red\)/);
    assert.match(chokepoints, /href="\/chokepoints\/strait-of-hormuz\/"/);
    assert.doesNotMatch(chokepoints, /\b85\b/, 'the week-old score is gone');

    const outages = sectionOf(html, outagesSection);
    assert.match(outages, /Panama/);
    assert.doesNotMatch(outages, /Namibia/);

    assert.ok(calls.includes(BUILT_URL), 'the built page is fetched under its own cache key');
    for (const section of SITUATION_SECTIONS) {
      const call = calls.find((url) => url.startsWith(`https://www.worldmonitor.app${section.statusPath.split('?')[0]}`));
      assert.ok(call, `${section.slug} reading fetched`);
      assert.ok(isPublicSharedRpcRequest(call), `${section.slug} reading is the anonymous public shape: ${call}`);
    }
  });

  it('keeps the built section where its source fails and still swaps the others', async () => {
    const { response, html } = await serve(routeAll({
      chokepoints: () => new Response('nope', { status: 503 }),
    }));

    assert.equal(response.headers.get('x-wm-live-page'), 'situation');
    assert.match(sectionOf(html, headlinesSection), /Live headline A/);
    assert.match(sectionOf(html, outagesSection), /Panama/);
    const chokepoints = sectionOf(html, chokepointsSection);
    assert.match(chokepoints, /Strait of Hormuz at 85 of 100 \(Red\)/, 'the published reading stays');
    assert.match(chokepoints, /Published reading/);
    assert.doesNotMatch(chokepoints, /data-live-at-request/);
  });

  it('keeps the built section when a source reports a reading too old to vouch for', async () => {
    const { html } = await serve(routeAll({
      digest: () => Response.json(digestPayload(new Date(Date.now() - 7 * HOUR).toISOString())),
      outages: () => Response.json(outagesPayload(Date.now() - 3 * HOUR)),
    }));

    const headlines = sectionOf(html, headlinesSection);
    assert.match(headlines, /Published headline one/);
    assert.doesNotMatch(headlines, /Live headline/, 'a six-hour-old digest is not current');
    const outages = sectionOf(html, outagesSection);
    assert.match(outages, /Namibia/);
    assert.doesNotMatch(outages, /Panama/);
    assert.match(sectionOf(html, chokepointsSection), /62 of 100/);
  });

  it('keeps the built section when the chokepoint payload is missing a waterway', async () => {
    const partial = chokepointPayload();
    partial.chokepoints = partial.chokepoints.filter((row) => row.id !== 'kerch_strait');
    const { html } = await serve(routeAll({ chokepoints: () => Response.json(partial) }));
    assert.match(sectionOf(html, chokepointsSection), /85 of 100/, 'a board missing a waterway is not published');
  });

  it('serves the built page unchanged when no section can go live', async () => {
    const { response, html } = await serve(routeAll({
      digest: () => new Response('nope', { status: 503 }),
      chokepoints: () => new Response('nope', { status: 503 }),
      outages: () => Response.json({ fetchedAt: Date.now() - 3 * HOUR, outages: [] }),
    }));
    assert.equal(html, builtPage());
    assert.equal(response.headers.get('x-wm-live-page'), null);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=300, must-revalidate');
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
