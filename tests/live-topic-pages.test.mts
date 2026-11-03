import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import middleware from '../middleware';
import {
  LIVE_TOPIC_PAGES,
  liveTopicPageForPath,
  liveTopicReading,
  liveTopicRpcPath,
} from '../scripts/live-pages/index.mjs';
import { finiteNumber, liveSectionMarkers, replaceLiveSection } from '../scripts/live-pages/common.mjs';
import { debtAt } from '../scripts/live-pages/national-debt.mjs';
import weoFiscalPeriods from '../scripts/shared/weo-fiscal-periods.mjs';
import { isPublicSharedRpcRequest, LIVE_TOPIC_RPC_PATHS } from '../src/shared/public-rpc-cache.ts';
import { WORLD_MONITOR_ORG } from '../scripts/build-crawlable-corpus.mjs';

const NOW = Date.parse('2026-10-18T09:00:00Z');
const HOUR = 3_600_000;

const page = (slug: string) => {
  const found = LIVE_TOPIC_PAGES.find((candidate) => candidate.slug === slug);
  assert.ok(found, slug);
  return found;
};

function category(score: number, degraded = false) {
  return { score, weight: 0.1, contribution: score / 10, degraded, inputsJson: '{}' };
}

function fearGreedPayload(seededAt = new Date(NOW - 2 * HOUR).toISOString()) {
  return {
    compositeScore: 56.8,
    compositeLabel: 'Neutral',
    previousScore: 55,
    seededAt,
    sentiment: category(34, true),
    volatility: category(60),
    positioning: category(50),
    trend: category(70),
    breadth: category(52),
    momentum: category(61),
    liquidity: category(45),
    credit: category(58),
    macro: category(40),
    crossAsset: category(66),
    vix: 19.99,
    cnnFearGreed: 18,
    cnnLabel: 'Extreme Fear',
    aaiiBull: 39,
    aaiiBear: 42,
  };
}

function debtPayload(seededAt = new Date(NOW - 2 * 24 * HOUR).toISOString()) {
  const baselineTs = Date.parse('2027-01-01T00:00:00Z');
  return {
    seededAt,
    entries: [
      { iso3: 'USA', debtUsd: 44e12, gdpUsd: 34e12, debtToGdp: 128.7, perSecondRate: 84_737, baselineTs, source: 'IMF WEO 2027' },
      { iso3: 'JPN', debtUsd: 9e12, gdpUsd: 4e12, debtToGdp: 230, perSecondRate: 5_000, baselineTs, source: 'IMF WEO 2027' },
      { iso3: 'NOR', debtUsd: 0.2e12, gdpUsd: 0.5e12, debtToGdp: 40, perSecondRate: 0, baselineTs, source: 'IMF WEO 2027' },
    ],
  };
}

function outagesPayload(fetchedAt = NOW - 20 * 60_000) {
  return {
    fetchedAt,
    outages: [
      { id: 'a', country: 'Namibia', severity: 'OUTAGE_SEVERITY_TOTAL', categories: ['Cloudflare Radar', 'POWER OUTAGE'], detectedAt: NOW - 4 * 24 * HOUR, endedAt: NOW - 3 * 24 * HOUR, description: 'Substation fault.', link: 'https://x.com/CloudflareRadar/status/1' },
      { id: 'b', country: 'Russian Federation', severity: 'OUTAGE_SEVERITY_PARTIAL', categories: ['Cloudflare Radar', 'MILITARY ACTION'], detectedAt: NOW - 11 * 24 * HOUR, endedAt: 0, description: '', link: 'javascript:alert(1)' },
    ],
  };
}

function marketsPayload(fetchedAt = NOW - 30 * 60_000) {
  return {
    fetchedAt,
    dataAvailable: true,
    markets: [
      { id: 'iran', title: 'Will the U.S. invade Iran before 2027?', yesPrice: 0.145, volume: 74_529_597, url: 'https://polymarket.com/event/iran', closesAt: Date.parse('2026-12-31T23:59:00Z'), category: '', source: 'MARKET_SOURCE_POLYMARKET' },
      { id: 'fed', title: 'Fed cut in December </script><script>alert(1)</script>', yesPrice: 0.6, volume: 2_000_000, url: 'https://evil.example/x', closesAt: 0, category: '', source: 'MARKET_SOURCE_KALSHI' },
    ],
  };
}

const DAY = 24 * HOUR;

function yieldCurvePayload(date = Date.parse('2026-10-16T00:00:00Z'), overrides: Record<string, unknown> = {}) {
  return {
    unavailable: false,
    curves: [{
      date,
      oneMonth: 4.12, oneAndAHalfMonth: 4.14, twoMonth: 4.17, threeMonth: 4.26, fourMonth: 4.32, sixMonth: 4.34,
      oneYear: 4.46, twoYear: 4.74, threeYear: 4.82, fiveYear: 4.89, sevenYear: 4.98, tenYear: 5.09, twentyYear: 5.47, thirtyYear: 5.43,
      ...overrides,
    }],
  };
}

function oilPayload() {
  return {
    // Oldest first, unlike the seed, so the record cannot rely on order.
    crudeWeeks: [
      { period: '2026-09-25', stocksMb: 425.1, weeklyChangeMb: 1.2 },
      { period: '2026-10-02', stocksMb: 424.134, weeklyChangeMb: -0.966 },
      { period: '2026-10-09', stocksMb: 415.577, weeklyChangeMb: -8.557 },
    ],
    spr: { latestStocksMb: 282.983, changeWow: 0, weeks: [{ period: '2026-10-09', stocksMb: 282.983 }, { period: '2026-10-02', stocksMb: 283.5 }] },
    natGasWeeks: [{ period: '2026-10-09', storBcf: 3567, weeklyChangeBcf: 67 }],
    euGas: { fillPct: 74.31, fillPctChange1d: 0.09, trend: 'injecting', history: [{ date: '2026-10-15', fillPct: 74.22 }, { date: '2026-10-16', fillPct: 74.31 }] },
    refinery: { inputsMbpd: 16.615, period: '2026-10-09' },
    updatedAt: new Date(NOW).toISOString(),
  };
}

describe('live topic readings', () => {
  it('reads the Fear & Greed composite with CNN and AAII beside it, and refuses a stale seed', () => {
    const record = liveTopicReading(page('fear-and-greed-index'), fearGreedPayload(), NOW);
    assert.equal(record.score, 56.8);
    assert.deepEqual(record.cnn, { score: 18, label: 'Extreme Fear' });
    assert.deepEqual(record.aaii, { bull: 39, bear: 42 });
    assert.equal(record.categories.length, 10);
    assert.equal(record.categories[0].partial, true, 'a degraded category is shown as partial, not dropped');
    assert.equal(liveTopicReading(page('fear-and-greed-index'), fearGreedPayload(new Date(NOW - 25 * HOUR).toISOString()), NOW), null);
    assert.equal(liveTopicReading(page('fear-and-greed-index'), { compositeScore: 140, compositeLabel: 'x', seededAt: new Date(NOW).toISOString() }, NOW), null);
  });

  it('extrapolates debt the way the dashboard panel does and refuses data older than 60 days', () => {
    const payload = debtPayload();
    const record = liveTopicReading(page('national-debt-clock'), payload, NOW);
    const expectedUs = 44e12 + 84_737 * ((NOW - payload.entries[0].baselineTs) / 1000);
    assert.equal(record.us.debtUsd, expectedUs);
    assert.equal(debtAt(payload.entries[2], NOW), 0.2e12, 'a surplus country does not tick');
    assert.deepEqual(record.top.map((country: { name: string }) => country.name), ['United States', 'Japan', 'Norway']);
    assert.equal(record.countryCount, 3);
    assert.equal(liveTopicReading(page('national-debt-clock'), debtPayload(new Date(NOW - 61 * 24 * HOUR).toISOString()), NOW), null);
  });

  it('lists outages newest first, marks ongoing ones and drops unsafe links', () => {
    const record = liveTopicReading(page('internet-outages'), outagesPayload(), NOW);
    assert.deepEqual(record.outages.map((outage: { country: string }) => outage.country), ['Namibia', 'Russian Federation']);
    assert.equal(record.ongoing, 1);
    assert.equal(record.outages[0].severity, 'Nationwide');
    assert.equal(record.outages[1].link, null);
    const empty = liveTopicReading(page('internet-outages'), { fetchedAt: NOW, outages: [] }, NOW);
    assert.equal(empty.total, 0, 'an empty seeded list is a real "no disruptions" reading');
  });

  it('ranks markets by volume, keeps venue links on the venue host and refuses a stale capture', () => {
    const record = liveTopicReading(page('prediction-markets'), marketsPayload(), NOW);
    assert.equal(record.markets[0].yesPct, 14.5);
    assert.equal(record.markets[1].url, null, 'a link off the venue host is dropped');
    assert.equal(liveTopicReading(page('prediction-markets'), marketsPayload(NOW - 7 * HOUR), NOW), null);
    assert.equal(liveTopicReading(page('prediction-markets'), { dataAvailable: false, markets: [] }, NOW), null);
  });

  it('lets a programming error propagate instead of publishing "no reading"', () => {
    const broken = { ...page('internet-outages'), record: () => { throw new TypeError('bug'); } };
    assert.throws(() => liveTopicReading(broken, {}, NOW), TypeError);
  });
});

describe('live topic readings never publish a missing value as a fact', () => {
  it('treats null and empty strings as absent, not zero', () => {
    assert.equal(finiteNumber(null), null);
    assert.equal(finiteNumber(''), null);
    assert.equal(finiteNumber(undefined), null);
    assert.equal(finiteNumber(0), 0);
    assert.equal(finiteNumber('12.5'), 12.5);
  });

  it('drops a VIX of 0, which the handler sends when VIX is unavailable', () => {
    const topic = page('fear-and-greed-index');
    for (const vix of [0, null]) {
      const record = liveTopicReading(topic, { ...fearGreedPayload(), vix }, NOW);
      assert.equal(record.vix, null);
      assert.doesNotMatch(topic.renderSection(record, { live: true }), />VIX</);
    }
  });

  it('drops a market without a price instead of publishing it at 0% yes', () => {
    const payload = marketsPayload();
    payload.markets[0].yesPrice = null as never;
    const record = liveTopicReading(page('prediction-markets'), payload, NOW);
    assert.deepEqual(record.markets.map((market: { title: string }) => market.title.slice(0, 3)), ['Fed']);
  });

  it('dates outages by the seeder fetch and refuses a list retained past two hours', () => {
    const topic = page('internet-outages');
    const fetchedAt = NOW - 20 * 60_000;
    assert.equal(liveTopicReading(topic, outagesPayload(fetchedAt), NOW).asOf, new Date(fetchedAt).toISOString());
    assert.equal(liveTopicReading(topic, outagesPayload(NOW - 3 * HOUR), NOW), null);
    assert.equal(liveTopicReading(topic, outagesPayload(0), NOW), null, 'an unknown fetch time is not current');
  });

  it('writes a single disruption in the singular', () => {
    const topic = page('internet-outages');
    const payload = outagesPayload();
    payload.outages = payload.outages.slice(0, 1);
    const section = topic.renderSection(liveTopicReading(topic, payload, NOW), { live: true });
    assert.match(section, /lists 1 internet disruption in 1 country /);
    assert.match(section, /, now ended\./);
    assert.doesNotMatch(section, /of them ongoing/);
  });

  it('labels market totals as every tracked market and says how many rows are shown', () => {
    const topic = page('prediction-markets');
    const payload = marketsPayload();
    payload.markets = Array.from({ length: 20 }, (_, index) => ({ ...payload.markets[0], id: `m${index}`, title: `Market ${index}`, volume: 1_000_000 + index }));
    const record = liveTopicReading(topic, payload, NOW);
    assert.equal(record.total, 20);
    assert.equal(record.markets.length, 15);
    const section = topic.renderSection(record, { live: true });
    assert.match(section, /Markets tracked/);
    assert.match(section, /Volume traded, all tracked markets/);
    assert.match(section, /The 15 most traded of 20 tracked markets/);
    assert.match(section, /tracks 20 Polymarket and Kalshi markets/);
  });

  it('reads the latest Treasury curve with both spreads and refuses a curve older than seven days', () => {
    const topic = page('treasury-yield-curve');
    const record = liveTopicReading(topic, yieldCurvePayload(), NOW);
    assert.equal(record.asOf, '2026-10-16T00:00:00.000Z');
    assert.equal(record.points.length, 14);
    assert.equal(record.tenTwoBp, 35, 'floating-point 5.09 - 4.74 rounds to whole basis points');
    assert.equal(record.tenThreeMonthBp, 83);
    assert.equal(liveTopicReading(topic, yieldCurvePayload(NOW - 8 * DAY), NOW), null);
    assert.equal(liveTopicReading(topic, { curves: [], unavailable: true }, NOW), null);
    assert.equal(liveTopicReading(topic, yieldCurvePayload(undefined, { tenYear: null }), NOW), null, 'no 10-year, no headline');
  });

  it('dates the curve by its business day, not a clock time, and calls an inversion an inversion', () => {
    const topic = page('treasury-yield-curve');
    const section = topic.renderSection(liveTopicReading(topic, yieldCurvePayload(), NOW), { live: true });
    assert.match(section, /<p data-live-answer>On Oct 16, 2026, the US Treasury par yield curve had the 10-year at 5\.09%, the 2-year at 4\.74% and the 3-month at 4\.26%\. The 10-year minus 2-year spread was \+35 basis points, so the curve was not inverted\./);
    assert.match(section, /<time data-live-updated datetime="2026-10-16">Live reading for Oct 16, 2026<\/time>/);
    assert.doesNotMatch(section, /UTC/);
    const inverted = topic.renderSection(liveTopicReading(topic, yieldCurvePayload(undefined, { twoYear: 5.3 }), NOW), { live: true });
    assert.match(inverted, /spread was -21 basis points, so the curve was inverted\./);
  });

  it('reads the newest EIA week whatever the order, and refuses a week older than 21 days', () => {
    const topic = page('crude-oil-inventories');
    const payload = oilPayload();
    const record = liveTopicReading(topic, payload, NOW);
    assert.equal(record.asOf, '2026-10-09T00:00:00.000Z');
    assert.equal(record.crudeMb, 415.6);
    assert.equal(record.crudeChangeMb, -8.557);
    assert.equal(record.sprMb, 283);
    assert.equal(record.sprChangeMb, -0.5, 'the SPR change comes from the weeks, not the handler default of 0');
    assert.deepEqual(record.weeks.map((week: { period: string }) => week.period), ['2026-10-09', '2026-10-02', '2026-09-25']);
    assert.deepEqual(record.euGas, { date: '2026-10-16T00:00:00.000Z', fillPct: 74.3 });
    assert.equal(liveTopicReading(topic, oilPayload(), Date.parse('2026-10-31T00:00:00Z')), null);
    assert.equal(liveTopicReading(topic, { crudeWeeks: [], natGasWeeks: [], updatedAt: '' }, NOW), null);
    const section = topic.renderSection(record, { live: true });
    assert.match(section, /For the week ending Oct 9, 2026, US commercial crude oil inventories were 415\.6 million barrels, down 8\.6 million barrels from the prior week, according to the EIA\. The Strategic Petroleum Reserve held 283\.0 million barrels\. US working natural gas in storage was 3,567 billion cubic feet\./);
    assert.match(section, /Live reading for Oct 9, 2026/);
    assert.match(section, /<strong>415\.6M bbl<\/strong><small>-8\.6M bbl on the week<\/small>/);
    payload.spr.weeks[1].stocksMb = 282.99;
    const flat = topic.renderSection(liveTopicReading(topic, payload, NOW), { live: true });
    assert.match(flat, /<strong>283\.0M bbl<\/strong><small>Unchanged on the week<\/small>/, 'a change that rounds to zero is not written as 0.0');
    payload.spr.weeks[1].period = '2026-09-25';
    const gap = liveTopicReading(topic, payload, NOW);
    assert.equal(gap.sprMb, 283);
    assert.equal(gap.sprChangeMb, null, 'a skipped SPR week makes the prior reading two weeks old, not "on the week"');
  });

  it('drops an inventory section from another report week or with a zero placeholder', () => {
    const topic = page('crude-oil-inventories');
    const payload = oilPayload();
    payload.spr = { latestStocksMb: 0, changeWow: 0, weeks: [{ period: '2026-10-02', stocksMb: 283.5 }] };
    payload.natGasWeeks = [{ period: '2026-10-09', storBcf: 0, weeklyChangeBcf: 0 }];
    payload.refinery = { inputsMbpd: 16.6, period: '2026-10-02' };
    payload.euGas.history = [{ date: '2026-10-10', fillPct: 73 }];
    const record = liveTopicReading(topic, payload, NOW);
    assert.equal(record.sprMb, null, "an SPR figure from the prior week is not this week's");
    assert.equal(record.natGasBcf, null);
    assert.equal(record.refineryMbpd, null);
    assert.equal(record.euGas, null, 'EU storage older than four days is dropped');
    const section = topic.renderSection(record, { live: true });
    assert.doesNotMatch(section, /Strategic Petroleum Reserve held|natural gas in storage was|EU gas storage|agsi\.gie\.eu/);
  });
});

describe('live topic sections', () => {
  it('explains the verified fiscal periods and the calendar-year fallback for debt', () => {
    const explainer = page('national-debt-clock').explainer;
    assert.match(explainer, /<li>June 30 of the WEO-labelled year: [^<]*Egypt/);
    assert.match(explainer, /<li>March 31 of the following year: [^<]*India/);
    assert.match(explainer, /midnight UTC immediately after/);
    assert.match(explainer, /Other countries[^<]*December 31[^<]*fallback/);
    assert.match(explainer, /Singapore[^<]*blend/);
    assert.doesNotMatch(explainer, /reaching the IMF figure on December 31/);
  });

  it('names every economy in the WEO fiscal-period table on the debt explainer', () => {
    const explainer = page('national-debt-clock').explainer;
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const items = [...explainer.matchAll(/<li>([^:<]+): ([^<]+)<\/li>/g)].map(([, label, names]) => ({ label, names: names.split(', ') }));
    for (const row of Object.values(weoFiscalPeriods.countries)) {
      const expected = `${months[row.endMonth - 1]} ${row.endDay} of ${row.yearLabel === 'start' ? 'the following year' : 'the WEO-labelled year'}`;
      const holders = items.filter((item) => item.names.includes(row.name));
      assert.deepEqual(holders.map((item) => item.label), [expected], row.name);
    }
  });

  it('states the reading with its date and carries matching FAQ markup that cannot close its script tag', () => {
    const topic = page('prediction-markets');
    const section = topic.renderSection(liveTopicReading(topic, marketsPayload(), NOW), { live: true });
    const answer = section.match(/<p data-live-answer>([^<]*)<\/p>/)?.[1] ?? '';
    assert.match(answer, /^As of Oct 18, 2026/);
    const ld = section.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? '';
    assert.ok(!ld.includes('</script'), 'market titles cannot end the JSON-LD script');
    const faq = JSON.parse(ld);
    assert.equal(faq.mainEntity[0].name, topic.question);
    assert.ok(section.includes('data-live-at-request'));
  });

  it('attributes the FAQ to the canonical Organization in every state, since middleware renders it outside the corpus attribution pass (#7980)', () => {
    for (const topic of LIVE_TOPIC_PAGES) {
      for (const section of [topic.renderSection(null, { live: false }), topic.renderSection(null, { live: true })]) {
        const faq = JSON.parse(section.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? '{}');
        assert.deepEqual(faq.author, WORLD_MONITOR_ORG, `${topic.slug} FAQ author`);
      }
    }
  });

  it('renders "no current reading" without a dated claim when the record is null', () => {
    for (const topic of LIVE_TOPIC_PAGES) {
      const section = topic.renderSection(null, { live: false });
      assert.ok(!section.includes('<time'), `${topic.slug} makes no dated claim without a reading`);
      assert.match(section, /No current reading/);
    }
  });

  it('replaces exactly one marked section', () => {
    const { start, end } = liveSectionMarkers('x');
    assert.equal(replaceLiveSection(`a${start}old${end}b`, 'x', 'new'), 'anewb');
    assert.equal(replaceLiveSection('no markers', 'x', 'new'), null);
    assert.equal(replaceLiveSection(`${start}1${end}${start}2${end}`, 'x', 'new'), null);
  });
});

describe('live topic public shapes', () => {
  it('opens exactly the registry routes to anonymous reads, and only as the bare public=1 shape', () => {
    assert.deepEqual([...LIVE_TOPIC_RPC_PATHS].sort(), LIVE_TOPIC_PAGES.map(liveTopicRpcPath).sort());
    for (const topic of LIVE_TOPIC_PAGES) {
      assert.ok(isPublicSharedRpcRequest(`https://www.worldmonitor.app${topic.statusPath}`), topic.statusPath);
      assert.ok(!isPublicSharedRpcRequest(`https://www.worldmonitor.app${liveTopicRpcPath(topic)}`));
      assert.ok(!isPublicSharedRpcRequest(`https://www.worldmonitor.app${topic.statusPath}&country=US`));
      assert.equal(liveTopicPageForPath(topic.path), topic);
    }
  });
});

describe('live topic pages through the middleware', () => {
  const topic = page('fear-and-greed-index');
  const pageUrl = `https://www.worldmonitor.app${topic.path}`;
  const builtUrl = `${pageUrl}?wm-built=1`;
  const builtHtml = `<!doctype html><html><body><main><h1>${topic.h1}</h1>
${topic.renderSection(null, { live: false })}
</main></body></html>`;

  afterEach(() => mock.restoreAll());

  function stubFetch(statusResponse: () => Response) {
    const calls: string[] = [];
    mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      if (url === builtUrl) {
        return new Response(builtHtml, { status: 200, headers: { 'content-type': 'text/html', 'cache-control': 'public, max-age=3600', etag: 'W/"b"' } });
      }
      if (url.includes(liveTopicRpcPath(topic))) return statusResponse();
      throw new Error(`unexpected fetch ${url}`);
    });
    return calls;
  }

  function request(method = 'GET') {
    return new Request(pageUrl, { method, headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (compatible; OAI-SearchBot/1.0)' } });
  }

  it('serves the current reading with the short cache policy', async () => {
    const calls = stubFetch(() => Response.json(fearGreedPayload(new Date(Date.now() - HOUR).toISOString())));
    const response = await middleware(request());
    assert.ok(response instanceof Response);
    const html = await response.text();
    assert.equal(response.headers.get('x-wm-live-page'), topic.slug);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=300, must-revalidate');
    assert.equal(response.headers.get('etag'), null);
    assert.match(html, /World Monitor Fear &amp; Greed Index reads 56\.8 out of 100/);
    const statusCall = calls.find((url) => url.includes(liveTopicRpcPath(topic)));
    assert.equal(new URL(statusCall!).search, '?public=1');
  });

  it('keeps the built page when the reading is stale or the read fails', async () => {
    stubFetch(() => Response.json(fearGreedPayload(new Date(Date.now() - 30 * HOUR).toISOString())));
    let response = await middleware(request());
    assert.equal(await response!.text(), builtHtml);
    assert.equal(response!.headers.get('x-wm-live-page'), null);
    mock.restoreAll();
    stubFetch(() => new Response('nope', { status: 503 }));
    response = await middleware(request());
    assert.equal(await response!.text(), builtHtml);
    assert.equal(response!.headers.get('cache-control'), 'public, max-age=300, must-revalidate');
  });

  it('leaves HEAD and the built-page fetch alone', async () => {
    stubFetch(() => Response.json(fearGreedPayload()));
    assert.equal(await middleware(request('HEAD')), undefined);
    assert.equal(await middleware(new Request(builtUrl, { headers: { accept: 'text/html' } })), undefined);
  });
});

describe('live topic modules in the middleware bundle', () => {
  // Vercel's middleware bundler rejects import attributes
  // (`with { type: 'json' }`): "Expected ";" but found "with"" failed the
  // #9367 preview build, while Node and tsx load them fine.
  it('uses no import attributes anywhere in the middleware import graph', () => {
    const root = resolve(import.meta.dirname, '..');
    const seen = new Set<string>();
    const pending = [join(root, 'middleware.ts')];
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(source, /\bfrom\s+['"][^'"]+['"]\s+(?:with|assert)\s*\{/, `${file.slice(root.length + 1)} uses an import attribute`);
      for (const [, specifier] of source.matchAll(/\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const target = [specifier, `${specifier}.ts`, `${specifier}/index.ts`]
          .map((candidate) => join(dirname(file), candidate))
          .find((candidate) => existsSync(candidate) && statSync(candidate).isFile() && !candidate.endsWith('.json'));
        if (target) pending.push(target);
      }
    }
    assert.ok([...seen].some((file) => file.endsWith('national-debt.mjs')), 'the walk reaches the topic modules');
  });
});
