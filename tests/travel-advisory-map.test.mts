import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import middleware from '../middleware';
import { liveTopicPageForPath, liveTopicReading, liveTopicRpcPath } from '../scripts/live-pages/index.mjs';
import { MIN_REGISTER_COUNTRIES, travelAdvisoriesPage } from '../scripts/live-pages/travel-advisories.mjs';
import { renderWorldMapSvg, worldMapShapes } from '../scripts/live-pages-world-map.mjs';
import { renderLiveTopicPage } from '../scripts/build-live-topic-pages.mjs';
import { countryLiveLinks, crisisLiveLinks } from '../scripts/live-pages/related-links.mjs';
import {
  advisoryBootstrapTransform,
  advisoryPublishTransform,
  buildRegisterLevels,
  fetchAll,
} from '../scripts/seed-security-advisories.mjs';
import { isPublicSharedRpcRequest } from '../src/shared/public-rpc-cache.ts';
import { normalizeAdvisoryRegisterLevels } from '../shared/intelligence-snapshots.js';

const NOW = Date.parse('2026-11-07T10:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LEVELS = ['normal', 'caution', 'reconsider', 'do-not-travel'] as const;

// Real ISO 3166-1 alpha-2 codes, so the page's Intl names are real names.
const CODES = [...new Set(Object.values(JSON.parse(readFileSync(new URL('../shared/un-to-iso2.json', import.meta.url), 'utf8')) as Record<string, string>))]
  .filter((code) => /^[A-Z]{2}$/.test(code))
  .sort();

type Row = { title: string; link: string; pubDate: string; source: string; sourceCountry: string; level: string; country: string };

function register(source: 'US' | 'AU', levelFor: (code: string, i: number) => string, count = CODES.length): Row[] {
  return CODES.slice(0, count).map((code, i) => ({
    title: `${code} advisory`,
    link: `https://${source === 'US' ? 'travel.state.gov' : 'www.smartraveller.gov.au'}/${code.toLowerCase()}`,
    pubDate: new Date(NOW - (i + 1) * 5 * DAY).toISOString(),
    source: source === 'US' ? 'US State Dept' : 'Australia DFAT Smartraveller',
    sourceCountry: source,
    level: levelFor(code, i),
    country: code,
  }));
}

const usLevel = (code: string, i: number) => (code === 'AF' || code === 'RU' ? 'do-not-travel' : LEVELS[i % 3]);
const auLevel = (code: string, i: number) => (code === 'AF' ? 'do-not-travel' : code === 'FR' ? 'do-not-travel' : LEVELS[i % 3]);

function payload(overrides: Record<string, unknown> = {}) {
  return {
    advisories: [],
    byCountry: {},
    registerLevels: [...register('US', usLevel), ...register('AU', auLevel)],
    fetchedAt: NOW - 40 * 60_000,
    ...overrides,
  };
}

const read = (value: unknown, now = NOW) => liveTopicReading(travelAdvisoriesPage, value, now) as any;

describe('travel advisory register levels in the seed', () => {
  const US = { name: 'US State Dept', sourceCountry: 'US', levelParser: 'us' };
  const AU = { name: 'Australia DFAT Smartraveller', sourceCountry: 'AU', levelParser: 'au' };
  const EMBASSY = { name: 'US Embassy Mexico', sourceCountry: 'US', targetCountry: 'MX' };

  it('keeps each register’s own level, skips bulletins and undated levels, and prefers the latest entry', () => {
    const item = (country: string, level: string, updated: string, link = `https://example.gov/${country}`) =>
      ({ title: `${country} advisory`, country, level, link, _registerUpdatedAt: updated });
    const levels = buildRegisterLevels([US, AU, EMBASSY], [
      [item('MX', 'caution', '2026-11-01T00:00:00.000Z'), item('MX', 'reconsider', '2026-10-01T00:00:00.000Z'), item('JP', 'info', '')],
      [item('MX', 'reconsider', '')],
      [item('MX', 'do-not-travel', '2026-11-05T00:00:00.000Z')],
    ]);
    assert.deepEqual(levels, [
      { title: 'MX advisory', link: 'https://example.gov/MX', pubDate: '', source: 'Australia DFAT Smartraveller', sourceCountry: 'AU', level: 'reconsider', country: 'MX' },
      { title: 'MX advisory', link: 'https://example.gov/MX', pubDate: '2026-11-01T00:00:00.000Z', source: 'US State Dept', sourceCountry: 'US', level: 'caution', country: 'MX' },
    ], 'the embassy bulletin is not a register, and the newer US entry wins');
  });

  it('publishes the register levels on the canonical key only, and stores no register date on the news list', async () => {
    const rss = `<?xml version="1.0"?><rss><channel>
      <item><title>Mexico - Level 2: Exercise Increased Caution</title><link>https://travel.state.gov/mexico.html</link><pubDate>Sat, 01 Nov 2026 12:00:00 GMT</pubDate></item>
      <item><title>Japan - Level 1: Exercise Normal Precautions</title><link>https://travel.state.gov/japan.html</link><pubDate>not a date</pubDate></item>
    </channel></rss>`;
    const report = await fetchAll({
      feeds: [{ ...US, url: 'https://travel.state.gov/_res/rss/TAsTWs.xml', sourceCategory: 'travel-advisory' }],
      doFetch: async () => ({ ok: true, status: 200, text: async () => rss }) as never,
    });
    assert.deepEqual(report.registerLevels, [
      { title: 'Japan - Level 1: Exercise Normal Precautions', link: 'https://travel.state.gov/japan.html', pubDate: '', source: 'US State Dept', sourceCountry: 'US', level: 'normal', country: 'JP' },
      { title: 'Mexico - Level 2: Exercise Increased Caution', link: 'https://travel.state.gov/mexico.html', pubDate: '2026-11-01T12:00:00.000Z', source: 'US State Dept', sourceCountry: 'US', level: 'caution', country: 'MX' },
    ], 'an unparseable feed date is left empty, not stamped with the fetch time');
    for (const advisory of report.advisories) assert.ok(!('_registerUpdatedAt' in advisory));
    assert.ok('registerLevels' in advisoryPublishTransform(report));
    const bootstrap = advisoryBootstrapTransform(report);
    assert.ok(!('registerLevels' in bootstrap), 'the dashboard bootstrap stays the size it was');
    assert.deepEqual(bootstrap.byCountry, report.byCountry);
    assert.ok(!('_sourceHealth' in bootstrap));
  });
});

describe('travel advisory map reading', () => {
  it('puts both governments side by side for every destination and counts each level', () => {
    const record = read(payload());
    assert.equal(record.countries.length, CODES.length);
    const af = record.countries.find((country: any) => country.code === 'AF');
    assert.equal(af.name, 'Afghanistan');
    assert.equal(af.US.level, 'do-not-travel');
    assert.equal(af.AU.level, 'do-not-travel');
    assert.equal(record.counts.US['do-not-travel'], 2);
    assert.equal(record.counts.AU['do-not-travel'], 2);
    const names = record.countries.map((country: any) => country.name);
    assert.deepEqual(names, [...names].sort((a: string, b: string) => a.localeCompare(b, 'en')), 'rows are in name order');
  });

  it('lists disagreements widest gap first', () => {
    const record = read(payload());
    const codes = record.disagree.map((entry: any) => entry.code);
    assert.ok(codes.includes('FR') && codes.includes('RU'));
    assert.ok(!codes.includes('AF'), 'the same level is not a disagreement');
    const gap = (entry: any) => Math.abs(LEVELS.indexOf(entry.US) - LEVELS.indexOf(entry.AU));
    for (let i = 1; i < record.disagree.length; i++) assert.ok(gap(record.disagree[i - 1]) >= gap(record.disagree[i]));
  });

  it('lists only register dates inside the last 14 days, newest first, and counts the rest', () => {
    const record = read(payload());
    // Dates fall every 5 days per country: days 5 and 10 for two countries in each register.
    assert.equal(record.recentCount, 4);
    assert.ok(record.recent.every((entry: any) => NOW - Date.parse(entry.updatedAt) <= 14 * DAY));
    assert.ok(Date.parse(record.recent[0].updatedAt) >= Date.parse(record.recent.at(-1).updatedAt));
  });

  it('refuses a stale read, a thin register, or no register field, and drops unsafe rows', () => {
    assert.equal(read(payload({ fetchedAt: NOW - 5 * HOUR })), null);
    assert.equal(read(payload({ fetchedAt: 0 })), null);
    assert.equal(read({ advisories: [], byCountry: {}, fetchedAt: NOW }), null, 'a pre-register seed has no reading');
    const thin = [...register('US', usLevel), ...register('AU', auLevel, MIN_REGISTER_COUNTRIES - 1)];
    assert.equal(read(payload({ registerLevels: thin })), null, 'a half-read register would show missing advice as none');
    const rows = payload().registerLevels as Row[];
    rows.push({ title: 'ZZ', link: 'javascript:alert(1)', pubDate: '', source: 'US State Dept', sourceCountry: 'US', level: 'caution', country: 'ZZ' });
    rows.push({ title: 'YY', link: 'https://www.gov.uk/x', pubDate: '', source: 'UK FCDO', sourceCountry: 'UK', level: 'caution', country: 'YY' });
    const record = read(payload({ registerLevels: rows }));
    assert.ok(!record.countries.some((country: any) => country.code === 'ZZ' || country.code === 'YY'));
  });
});

describe('travel advisory map section', () => {
  it('states both counts with the date and gives each level its government’s wording and link', () => {
    const section = travelAdvisoriesPage.renderSection(read(payload()), { live: true });
    const answer = section.match(/<p data-live-answer>([^<]*)<\/p>/)?.[1] ?? '';
    assert.match(answer, /^As of Nov 7, 2026, 9:20 AM UTC, the US State Department rates 2 countries Level 4: Do Not Travel, and Australia’s Smartraveller tells travellers not to go to 2 countries\. The two governments give different advice for \d+ countries\.$/);
    assert.match(section, /<tr id="advisory-af"><th scope="row">Afghanistan<\/th><td class="lvl lvl-4"><a href="https:\/\/travel\.state\.gov\/af" rel="nofollow">Level 4: Do Not Travel<\/a>/);
    assert.match(section, /<a href="https:\/\/www\.smartraveller\.gov\.au\/af" rel="nofollow">Do not travel<\/a>/);
    const faq = JSON.parse(section.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? '{}');
    assert.equal(faq.mainEntity[0].acceptedAnswer.text, answer);
  });

  it('colours the map from the US levels inside the live section, so a swap recolours it', () => {
    const section = travelAdvisoriesPage.renderSection(read(payload()), { live: true });
    const style = section.match(/<style>([^<]*)<\/style>/)?.[1] ?? '';
    assert.match(style, /\.advisory-map \[data-iso2="AF"\]\{fill:var\(--lvl-4\)\}/);
    assert.match(style, /\.advisory-map \[data-iso2="RU"\]\{fill:var\(--lvl-4\)\}/);
    assert.equal((style.match(/\[data-iso2="[A-Z]{2}"\]\{fill:/g) || []).length, CODES.length, 'one rule per country with a US level');
    assert.doesNotMatch(style, /[<>]/);
  });

  it('makes no dated claim and draws no colours without a reading', () => {
    const section = travelAdvisoriesPage.renderSection(null, { live: false });
    assert.match(section, /No current reading/);
    assert.ok(!section.includes('<time') && !section.includes('<style>'));
  });
});

describe('travel advisory map page', () => {
  const tpl = {
    escapeHtml: (value: string) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    absoluteUrl: (base: string, path: string) => new URL(path, base).href,
    breadcrumbLd: () => ({}),
    pageDocument: ({ body }: { body: string }) => `<!doctype html><html><body><main>${body}</main></body></html>`,
  };

  it('does not paint the built map as "no US advisory" when there is no reading', () => {
    const noLevel = /\.advisory-map path\s*\{[^}]*fill:\s*var\(--lvl-none\)/;
    const empty = renderLiveTopicPage({ page: travelAdvisoriesPage, record: null, baseUrl: 'https://www.worldmonitor.app', lastmod: '2026-11-07', tpl });
    assert.doesNotMatch(empty, noLevel, 'without a reading every country would claim no US advisory');
    const filled = renderLiveTopicPage({ page: travelAdvisoriesPage, record: read(payload()), baseUrl: 'https://www.worldmonitor.app', lastmod: '2026-11-07', tpl });
    const sectionAt = filled.indexOf('<!--wm-live:travel-advisory-map-->');
    assert.match(filled.slice(sectionAt), noLevel, 'a reading marks unlisted countries from inside the live section');
  });

  it('draws the major countries with ISO codes and builds the map outside the live section', () => {
    const codes = new Set(worldMapShapes().map((shape) => shape.iso2));
    for (const code of ['US', 'FR', 'RU', 'CN', 'BR', 'AU', 'XK', 'SS']) assert.ok(codes.has(code), code);
    assert.ok(!worldMapShapes().some((shape) => shape.name === 'Antarctica'));
    const html = renderLiveTopicPage({ page: travelAdvisoriesPage, record: read(payload()), baseUrl: 'https://www.worldmonitor.app', lastmod: '2026-11-07', tpl });
    const svgAt = html.indexOf('<svg class="advisory-map"');
    const sectionAt = html.indexOf('<!--wm-live:travel-advisory-map-->');
    assert.ok(svgAt !== -1 && sectionAt !== -1 && svgAt < sectionAt, 'the figure precedes the section and is not inside it');
    assert.ok(html.indexOf('<svg', sectionAt) === -1, 'the section carries no geometry');
    assert.ok(renderWorldMapSvg({ label: 'a "map"' }).includes('aria-label="a &quot;map&quot;"'));
  });

  it('links each country profile to its own row on the map page', () => {
    assert.ok(countryLiveLinks('MX').some((link) => link.href === '/tools/travel-advisory-map/#advisory-mx'));
    assert.ok(!countryLiveLinks('US').some((link) => link.href.startsWith('/tools/travel-advisory-map/')), 'the US register does not rate the US');
    assert.ok(countryLiveLinks('US').length <= 5);
    assert.ok(crisisLiveLinks({ touchesOilChokepoint: true }).some((link) => link.href === '/tools/travel-advisory-map/'));
  });

  it('documents a register row the normalizer accepts, naming its issuing government', () => {
    const spec = JSON.parse(readFileSync(new URL('../docs/api/IntelligenceService.openapi.json', import.meta.url), 'utf8'));
    const example = spec.paths['/api/intelligence/v1/list-security-advisories'].get.responses['200'].content['application/json'].example;
    assert.ok(example.registerLevels.length > 0);
    assert.deepEqual(normalizeAdvisoryRegisterLevels(example), example.registerLevels, 'every documented row is valid');
    assert.ok(example.registerLevels.every((row: { sourceCountry: string }) => row.sourceCountry === 'US' || row.sourceCountry === 'AU'));
    assert.equal(typeof example.fetchedAt, 'number');
  });

  it('opens only the bare public shape of the advisories read', () => {
    assert.equal(liveTopicPageForPath('/tools/travel-advisory-map/'), travelAdvisoriesPage);
    assert.ok(isPublicSharedRpcRequest('https://www.worldmonitor.app/api/intelligence/v1/list-security-advisories?public=1'));
    assert.ok(!isPublicSharedRpcRequest('https://www.worldmonitor.app/api/intelligence/v1/list-security-advisories'));
    assert.ok(!isPublicSharedRpcRequest('https://www.worldmonitor.app/api/intelligence/v1/list-security-advisories?public=1&country=MX'));
  });
});

describe('travel advisory map through the middleware', () => {
  const pageUrl = 'https://www.worldmonitor.app/tools/travel-advisory-map/';
  const builtUrl = `${pageUrl}?wm-built=1`;
  const figure = travelAdvisoriesPage.renderFigure({ worldMapSvg: renderWorldMapSvg });
  const builtHtml = `<!doctype html><html><body><main><h1>Travel advisory map</h1>
${figure}
${travelAdvisoriesPage.renderSection(null, { live: false })}
</main></body></html>`;

  afterEach(() => mock.restoreAll());

  function stubFetch(status: () => Response) {
    const calls: string[] = [];
    mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      if (url === builtUrl) return new Response(builtHtml, { status: 200, headers: { 'content-type': 'text/html' } });
      if (url.includes(liveTopicRpcPath(travelAdvisoriesPage))) return status();
      throw new Error(`unexpected fetch ${url}`);
    });
    return calls;
  }

  const request = () => new Request(pageUrl, { headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' } });

  it('swaps in the current advice and leaves the map geometry untouched', async () => {
    const calls = stubFetch(() => Response.json(payload({ fetchedAt: Date.now() - 30 * 60_000 })));
    const response = await middleware(request());
    assert.ok(response instanceof Response);
    const html = await response.text();
    assert.equal(response.headers.get('x-wm-live-page'), 'travel-advisory-map');
    assert.ok(html.includes(figure), 'the figure is served as built');
    assert.match(html, /the US State Department rates 2 countries Level 4: Do Not Travel/);
    assert.match(html, /\.advisory-map \[data-iso2="AF"\]\{fill:var\(--lvl-4\)\}/);
    assert.equal(new URL(calls.find((url) => url.includes(liveTopicRpcPath(travelAdvisoriesPage)))!).search, '?public=1');
  });

  it('keeps the built page when the registers are stale or the read fails', async () => {
    stubFetch(() => Response.json(payload({ fetchedAt: Date.now() - 6 * HOUR })));
    assert.equal(await (await middleware(request()))!.text(), builtHtml);
    mock.restoreAll();
    stubFetch(() => new Response('unavailable', { status: 503 }));
    assert.equal(await (await middleware(request()))!.text(), builtHtml);
  });
});
