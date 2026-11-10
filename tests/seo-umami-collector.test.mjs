import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { REFERRER_FAMILIES } from '../scripts/seo-ai-visibility-collector.mjs';
import {
  ENDPOINTS,
  FAMILY_ORDER,
  UMAMI_WEBSITE_ID,
  assertNoSecrets,
  collectUmamiSnapshot,
  createLiveTransport,
  deriveWindow,
  referrerFamily,
  renderUmamiMarkdown,
  runCli,
  toScorecardReferralExport,
  utmSourceFamily,
} from '../scripts/seo-umami-collect.mjs';

const repoPath = (relativePath) => new URL(`../${relativePath}`, import.meta.url).pathname;
const FIXTURES = 'tests/fixtures/umami/';
const OBSERVED_AT = '2026-11-02T06:00:00Z';
const silent = () => {};

const collect = () => runCli(['--fixtures', FIXTURES, '--stdout'], { log: silent });
const recorded = (file) => JSON.parse(readFileSync(repoPath(`${FIXTURES}${file}`), 'utf8'));

const FIRST_DAY = deriveWindow(OBSERVED_AT).startAt;

const EMPTY_DAY = { pageviews: 0, visitors: 0, visits: 0, bounces: 0, totaltime: 0 };

/**
 * Answers each endpoint from `responses` on the first day of the window and
 * with an empty day on the others, unless `days` maps a day offset to its own
 * answer. An Error value answers as that failure.
 */
const memoryTransport = (responses, days = {}) => ({
  kind: 'memory',
  calls: [],
  async call(endpoint, range) {
    this.calls.push({ endpoint, range });
    const offset = Math.round((range.startAt - FIRST_DAY) / 86_400_000);
    const empty = endpoint === ENDPOINTS.totals ? EMPTY_DAY : [];
    const response = days[endpoint]?.[offset] ?? (offset === 0 ? responses[endpoint] : empty);
    if (response instanceof Error) throw response;
    return response;
  },
});

const STATS = { pageviews: 1000, visitors: 300, visits: 400, bounces: 100, totaltime: 48_000 };
const CHANNELS = [{ x: 'organicSearch', y: 120 }, { x: 'direct', y: 200 }, { x: 'llm', y: 3 }];
const REFERRERS = [
  { x: 'google.com', y: 100 },
  { x: 'chatgpt.com', y: 7 },
  { x: 'gemini.google.com', y: 2 },
  { x: 'tech.worldmonitor.app', y: 9 },
  { x: 't.co', y: 4 },
  { x: 'example.org', y: 1 },
];
// ChatGPT tags the links it cites with utm_source=chatgpt.com, so this count is larger than its referrer row.
const UTM_SOURCES = [
  { x: 'chatgpt.com', y: 12 },
  { x: 'welcome', y: 4 },
  { x: 'perplexity', y: 2 },
];
const responses = (overrides = {}) => ({
  [ENDPOINTS.totals]: STATS,
  [ENDPOINTS.channels]: CHANNELS,
  [ENDPOINTS.referrers]: REFERRERS,
  [ENDPOINTS.utmSources]: UTM_SOURCES,
  ...overrides,
});

describe('Umami referral collector', () => {
  it('produces the same snapshot from the same fixtures', async () => {
    const first = await collect();
    const second = await collect();
    assert.deepEqual(first.snapshot, second.snapshot);
    assert.equal(first.markdown, second.markdown);
    assert.equal(first.snapshot.snapshotId, 'umami-2026-11-02');
    assert.deepEqual(first.snapshot.window, { label: '28d', startDate: '2026-10-05', endDate: '2026-11-01' });
  });

  it('asks Umami for the 28 complete UTC days before the run', () => {
    const window = deriveWindow('2026-11-02T23:59:00Z');
    assert.equal(window.endAt, Date.parse('2026-11-02T00:00:00Z'));
    assert.equal(window.endAt - window.startAt, 28 * 86_400_000);
    assert.equal(window.endDate, '2026-11-01');
  });

  it('sums each referrer family from exactly the recorded rows in it', async () => {
    const { snapshot } = await collect();
    const rows = Object.values(recorded('referrers.json')).flat().filter((row) => row.x !== '');
    for (const family of FAMILY_ORDER) {
      const inFamily = rows.filter((row) => referrerFamily(row.x) === family);
      assert.equal(snapshot.referrers.byFamily[family].visitorDays, inFamily.reduce((total, row) => total + row.y, 0), family);
      assert.equal(snapshot.referrers.byFamily[family].domains, new Set(inFamily.map((row) => row.x)).size, family);
    }
    assert.equal(snapshot.referrers.domains, new Set(rows.map((row) => row.x)).size);
    assert.equal(snapshot.referrers.daysReported, 28);
  });

  it('classifies referrer domains by suffix, never by substring', () => {
    const cases = {
      'google.com': 'search',
      'google.com.hk': 'search',
      'com.google.android.googlequicksearchbox': 'search',
      'noai.duckduckgo.com': 'search',
      'fr.search.yahoo.com': 'search',
      'yandex.com.tr': 'search',
      'search.yahoo.co.jp': 'search',
      'com.twitter.android': 'social',
      '127.0.0.1': 'internal',
      'gemini.google.com': 'other_ai_search',
      'chatgpt.com': 'chatgpt',
      'chat.openai.com': 'chatgpt',
      'www.perplexity.ai': 'perplexity',
      'claude.ai': 'claude',
      'copilot.microsoft.com': 'copilot_bing',
      'tech.worldmonitor.app': 'internal',
      'l.facebook.com': 'social',
      'com.reddit.frontpage': 'social',
      'www-worldmonitor-app.translate.goog': 'other',
      'notgoogle.com': 'other',
      'fakechatgpt.com': 'other',
      'googleusercontent.com': 'other',
    };
    for (const [domain, family] of Object.entries(cases)) assert.equal(referrerFamily(domain), family, domain);
  });

  it('maps only onto referrer families the visibility collector defines', async () => {
    const { snapshot } = await collect();
    for (const family of Object.keys(snapshot.referrers.referrerFamilies)) {
      assert.ok(REFERRER_FAMILIES.has(family), family);
    }
    assert.deepEqual(new Set(Object.keys(snapshot.referrers.referrerFamilies)), REFERRER_FAMILIES);
  });

  it('reports google_search_ai as unavailable, never zero, and direct visitors from the channel', async () => {
    const snapshot = await collectUmamiSnapshot({ transport: memoryTransport(responses()), observedAt: OBSERVED_AT });
    const { google_search_ai: googleAi, unknown_direct: direct, chatgpt, other_ai_search: otherAi } = snapshot.referrers.referrerFamilies;
    assert.equal(googleAi.availability, 'unavailable');
    assert.equal(googleAi.visitorDays, null);
    assert.equal(direct.visitorDays, 200);
    // 12 utm_source visitor-days beat the 7 referrer ones; the figure is the larger, not their sum.
    assert.equal(chatgpt.visitorDays, 12);
    assert.equal(chatgpt.referrerVisitorDays, 7);
    assert.equal(chatgpt.utmVisitorDays, 12);
    assert.equal(otherAi.visitorDays, 2);
    assert.equal(snapshot.referrers.byFamily.search.visitorDays, 100);
    assert.equal(snapshot.referrers.byFamily.internal.visitorDays, 9);
  });

  it('sums totals across days and names visitors as visitor-days', async () => {
    const { totals } = await collectUmamiSnapshot({
      transport: memoryTransport(responses(), { [ENDPOINTS.totals]: { 9: { pageviews: 500, visitors: 100, visits: 200, bounces: 80, totaltime: 12_000 } } }),
      observedAt: OBSERVED_AT,
    });
    assert.equal(totals.availability, 'available');
    assert.equal(totals.daysReported, 28);
    assert.equal(totals.pageviews, 1500);
    assert.equal(totals.visitorDays, 400);
    assert.equal(totals.visits, 600);
    assert.equal(totals.bounceRate, 0.3);
    assert.equal(totals.avgVisitSeconds, 100);
    assert.equal('visitors' in totals, false);
    assert.equal('previous' in totals, false);
  });

  it('asks for every endpoint once per UTC day of the window', async () => {
    const transport = memoryTransport(responses());
    await collectUmamiSnapshot({ transport, observedAt: OBSERVED_AT });
    const window = deriveWindow(OBSERVED_AT);
    for (const endpoint of Object.values(ENDPOINTS)) {
      const ranges = transport.calls.filter((call) => call.endpoint === endpoint).map((call) => call.range).sort((a, b) => a.startAt - b.startAt);
      assert.equal(ranges.length, 28);
      assert.equal(ranges[0].startAt, window.startAt);
      assert.equal(ranges.at(-1).endAt, window.endAt);
      for (const range of ranges) assert.equal(range.endAt - range.startAt, 86_400_000);
    }
  });

  it('sums each value across days', async () => {
    const snapshot = await collectUmamiSnapshot({
      transport: memoryTransport(responses(), {
        [ENDPOINTS.referrers]: { 0: [{ x: 'chatgpt.com', y: 2 }], 5: [{ x: 'chatgpt.com', y: 3 }, { x: 'claude.ai', y: 1 }] },
        [ENDPOINTS.utmSources]: { 0: [] },
      }),
      observedAt: OBSERVED_AT,
    });
    assert.equal(snapshot.referrers.referrerFamilies.chatgpt.visitorDays, 5);
    assert.equal(snapshot.referrers.referrerFamilies.claude.visitorDays, 1);
    assert.equal(snapshot.referrers.domains, 2);
  });

  it('leaves a failed day out, names it, and marks the section partial', async () => {
    const snapshot = await collectUmamiSnapshot({
      transport: memoryTransport(responses(), { [ENDPOINTS.channels]: { 3: new Error('[seo-umami] metrics?type=channel failed with HTTP 524 after 3 attempts') } }),
      observedAt: OBSERVED_AT,
    });
    assert.equal(snapshot.channels.availability, 'partial');
    assert.equal(snapshot.channels.daysReported, 27);
    assert.match(snapshot.channels.reason, /missing 1 of 28 days: 2026-10-08 \(metrics\?type=channel failed with HTTP 524/);
    assert.equal(snapshot.channels.rows.find((row) => row.channel === 'direct').visitorDays, 200);
  });

  it('carries a partial source into the families derived from it', async () => {
    const down = new Error('[seo-umami] metrics?type=referrer failed with HTTP 524 after 3 attempts');
    const snapshot = await collectUmamiSnapshot({
      transport: memoryTransport(responses(), {
        [ENDPOINTS.channels]: { 3: down },
        [ENDPOINTS.referrers]: { 4: down },
      }),
      observedAt: OBSERVED_AT,
    });
    const families = snapshot.referrers.referrerFamilies;
    assert.equal(families.unknown_direct.availability, 'partial');
    assert.match(families.unknown_direct.reason, /2026-10-08/);
    assert.equal(families.chatgpt.availability, 'partial');
    assert.match(families.chatgpt.reason, /2026-10-09/);
    assert.equal(families.google_search_ai.availability, 'unavailable');
    assert.match(renderUmamiMarkdown(snapshot), /\| unknown_direct \| 200 \| channel direct; partial: missing 1 of 28 days/);
  });

  it('writes a snapshot whose referrer domains spell a secret marker', async () => {
    const snapshot = await collectUmamiSnapshot({
      transport: memoryTransport(responses({ [ENDPOINTS.referrers]: [{ x: 'password', y: 9 }, { x: 'token', y: 8 }] })),
      observedAt: OBSERVED_AT,
    });
    const serialized = JSON.stringify(snapshot, null, 2);
    assert.ok(serialized.includes('"domain": "password"'));
    assert.equal(assertNoSecrets(serialized), serialized);
    assert.equal(assertNoSecrets(renderUmamiMarkdown(snapshot)), renderUmamiMarkdown(snapshot));
  });

  it('degrades only the section whose endpoint failed', async () => {
    const down = new Error('[seo-umami] metrics?type=channel failed with HTTP 500 after 3 attempts');
    const snapshot = await collectUmamiSnapshot({
      transport: memoryTransport(responses(), { [ENDPOINTS.channels]: Object.fromEntries(Array.from({ length: 28 }, (_, day) => [day, down])) }),
      observedAt: OBSERVED_AT,
    });
    assert.equal(snapshot.channels.availability, 'unavailable');
    assert.match(snapshot.channels.reason, /HTTP 500/);
    assert.equal(snapshot.referrers.referrerFamilies.unknown_direct.visitorDays, null);
    assert.equal(snapshot.referrers.availability, 'available');
    assert.equal(snapshot.totals.availability, 'available');
    assert.match(renderUmamiMarkdown(snapshot), /Not measured: metrics\?type=channel failed/);
  });

  it('refuses to write a snapshot when every endpoint failed', async () => {
    const failed = new Error('down');
    const everyDay = Object.fromEntries(Array.from({ length: 28 }, (_, day) => [day, failed]));
    await assert.rejects(
      collectUmamiSnapshot({
        transport: memoryTransport({}, { [ENDPOINTS.totals]: everyDay, [ENDPOINTS.channels]: everyDay, [ENDPOINTS.referrers]: everyDay }),
        observedAt: OBSERVED_AT,
      }),
      /every Umami endpoint failed/,
    );
  });

  it('marks a referrer list at the row limit as partial', async () => {
    const full = Array.from({ length: 1_000 }, (_, index) => ({ x: `site${index}.example`, y: 1 }));
    const { referrers } = await collectUmamiSnapshot({ transport: memoryTransport(responses({ [ENDPOINTS.referrers]: full })), observedAt: OBSERVED_AT });
    assert.equal(referrers.availability, 'partial');
    assert.match(referrers.reason, /lower bounds/);
    assert.equal(referrers.domains, 1_000);
  });

  it('drops a day whose counts are not non-negative integers', async () => {
    const { referrers } = await collectUmamiSnapshot({
      transport: memoryTransport(responses({ [ENDPOINTS.referrers]: [{ x: 'google.com', y: -1 }, { x: 'claude.ai', y: 4 }] })),
      observedAt: OBSERVED_AT,
    });
    assert.equal(referrers.availability, 'partial');
    assert.equal(referrers.daysReported, 27);
    assert.match(referrers.reason, /2026-10-05 \(a row carries a count that is not a non-negative integer\)/);
    assert.equal(referrers.referrerFamilies.claude.visitorDays, 0);
  });

  it('classifies utm_source values onto AI families, case-insensitively and on the whole value', () => {
    const cases = {
      'chatgpt.com': 'chatgpt',
      'ChatGPT.com': 'chatgpt',
      openai: 'chatgpt',
      perplexity: 'perplexity',
      'perplexity.ai': 'perplexity',
      Claude: 'claude',
      anthropic: 'claude',
      'copilot.com': 'copilot_bing',
      bing: 'copilot_bing',
      gemini: 'other_ai_search',
      poe: 'other_ai_search',
      welcome: 'other',
      embed: 'other',
      'mcp.so': 'other',
      'fakechatgpt.com': 'other',
      'chatgpt.com.evil.example': 'other',
      '': 'other',
    };
    for (const [value, family] of Object.entries(cases)) assert.equal(utmSourceFamily(value), family, value);
  });

  it('counts a visit with no referrer and utm_source=chatgpt.com toward chatgpt', async () => {
    // No chatgpt.com referrer row at all: these visits arrived with an empty referrer.
    const withoutChatgptReferrer = REFERRERS.filter((row) => row.x !== 'chatgpt.com');
    const { referrers } = await collectUmamiSnapshot({
      transport: memoryTransport(responses({ [ENDPOINTS.referrers]: [...withoutChatgptReferrer, { x: '', y: 12 }] })),
      observedAt: OBSERVED_AT,
    });
    const { chatgpt } = referrers.referrerFamilies;
    assert.equal(chatgpt.referrerVisitorDays, 0);
    assert.equal(chatgpt.utmVisitorDays, 12);
    assert.equal(chatgpt.visitorDays, 12);
    assert.equal(chatgpt.availability, 'available');
    assert.equal(referrers.utmSources.byFamily.chatgpt.sources[0].source, 'chatgpt.com');
  });

  it('never counts welcome, embed or other non-AI utm_source values toward an AI family', async () => {
    const { referrers } = await collectUmamiSnapshot({
      transport: memoryTransport(responses({
        [ENDPOINTS.referrers]: [],
        [ENDPOINTS.utmSources]: [{ x: 'welcome', y: 500 }, { x: 'embed', y: 300 }, { x: 'mcp.so', y: 9 }, { x: 'chatgpt.com', y: 3 }],
      })),
      observedAt: OBSERVED_AT,
    });
    const families = referrers.referrerFamilies;
    assert.equal(families.chatgpt.visitorDays, 3);
    for (const family of ['perplexity', 'claude', 'copilot_bing', 'other_ai_search']) {
      assert.equal(families[family].visitorDays, 0, family);
      assert.equal(families[family].utmVisitorDays, 0, family);
    }
  });

  it('takes the larger of the referrer and utm_source counts, so a visit carrying both is not counted twice', async () => {
    const snapshot = async (referrerCount, utmCount) => (await collectUmamiSnapshot({
      transport: memoryTransport(responses({
        [ENDPOINTS.referrers]: [{ x: 'chatgpt.com', y: referrerCount }],
        [ENDPOINTS.utmSources]: [{ x: 'chatgpt.com', y: utmCount }],
      })),
      observedAt: OBSERVED_AT,
    })).referrers.referrerFamilies.chatgpt;
    const utmLarger = await snapshot(7, 12);
    assert.equal(utmLarger.visitorDays, 12);
    assert.notEqual(utmLarger.visitorDays, 19);
    assert.equal(utmLarger.basis, 'max-of-referrer-and-utm-lower-bound');
    const referrerLarger = await snapshot(20, 12);
    assert.equal(referrerLarger.visitorDays, 20);
    assert.equal(referrerLarger.referrerVisitorDays, 20);
    assert.equal(referrerLarger.utmVisitorDays, 12);
  });

  it('marks a family partial, not lower, when a utm_source day is missing', async () => {
    const down = new Error('[seo-umami] metrics?type=utmSource failed with HTTP 524 after 3 attempts');
    const { referrers } = await collectUmamiSnapshot({
      transport: memoryTransport(responses(), { [ENDPOINTS.utmSources]: { 3: down } }),
      observedAt: OBSERVED_AT,
    });
    const { chatgpt } = referrers.referrerFamilies;
    assert.equal(chatgpt.availability, 'partial');
    assert.match(chatgpt.reason, /missing 1 of 28 days: 2026-10-08 \(metrics\?type=utmSource failed with HTTP 524/);
    assert.equal(chatgpt.visitorDays, 12, 'the days that answered are still counted');
    assert.equal(referrers.utmSources.availability, 'partial');
    assert.equal(referrers.utmSources.daysReported, 27);
  });

  it('falls back to the referrer count, marked partial, when every utm_source day failed', async () => {
    const down = new Error('[seo-umami] metrics?type=utmSource failed with HTTP 500 after 3 attempts');
    const { referrers } = await collectUmamiSnapshot({
      transport: memoryTransport(responses(), { [ENDPOINTS.utmSources]: Object.fromEntries(Array.from({ length: 28 }, (_, day) => [day, down])) }),
      observedAt: OBSERVED_AT,
    });
    const { chatgpt } = referrers.referrerFamilies;
    assert.equal(referrers.utmSources.availability, 'unavailable');
    assert.equal(chatgpt.availability, 'partial');
    assert.equal(chatgpt.visitorDays, 7);
    assert.equal(chatgpt.utmVisitorDays, null);
    assert.equal(chatgpt.basis, 'referrer-only');
    assert.match(chatgpt.reason, /utm_source counts are unavailable \(metrics\?type=utmSource failed with HTTP 500/);
  });

  it('keeps the utm_source counts, marked partial, when every referrer day failed', async () => {
    const down = new Error('[seo-umami] metrics?type=referrer failed with HTTP 500 after 3 attempts');
    const { referrers } = await collectUmamiSnapshot({
      transport: memoryTransport(responses(), { [ENDPOINTS.referrers]: Object.fromEntries(Array.from({ length: 28 }, (_, day) => [day, down])) }),
      observedAt: OBSERVED_AT,
    });
    const { chatgpt } = referrers.referrerFamilies;
    assert.equal(referrers.availability, 'unavailable');
    assert.equal(chatgpt.availability, 'partial');
    assert.equal(chatgpt.visitorDays, 12);
    assert.equal(chatgpt.referrerVisitorDays, null);
    assert.equal(chatgpt.basis, 'utm-only');
    assert.match(chatgpt.reason, /referrer metrics are unavailable \(metrics\?type=referrer failed with HTTP 500/);
  });

  it('tells the scorecard the AI families are the larger of two signals, and why a utm_source shortfall happened', async () => {
    const classification = { families: [{ id: 'chatgpt', hostSuffixes: ['chatgpt.com'] }] };
    const snapshot = await collectUmamiSnapshot({ transport: memoryTransport(responses()), observedAt: OBSERVED_AT });
    const combined = toScorecardReferralExport(snapshot, { classification });
    assert.match(combined.reason, /larger of its referrer count .* and its utm_source count, never their sum/);
    assert.match(combined.reason, /chatgpt 12\b/);
    assert.doesNotMatch(combined.reason, /utm_source counts are/);

    const down = new Error('[seo-umami] metrics?type=utmSource failed with HTTP 500 after 3 attempts');
    const degraded = await collectUmamiSnapshot({
      transport: memoryTransport(responses(), { [ENDPOINTS.utmSources]: Object.fromEntries(Array.from({ length: 28 }, (_, day) => [day, down])) }),
      observedAt: OBSERVED_AT,
    });
    const fallback = toScorecardReferralExport(degraded, { classification });
    assert.match(fallback.reason, /chatgpt 7 \(partial, referrer-only\)/);
    assert.match(fallback.reason, /utm_source counts are unavailable: .*HTTP 500/);
  });

  it('reports the fixture chatgpt family at least as large as both of its inputs', async () => {
    const { snapshot } = await collect();
    const { chatgpt } = snapshot.referrers.referrerFamilies;
    assert.ok(chatgpt.visitorDays >= chatgpt.utmVisitorDays);
    assert.ok(chatgpt.visitorDays >= chatgpt.referrerVisitorDays);
    assert.equal(chatgpt.visitorDays, Math.max(chatgpt.referrerVisitorDays, chatgpt.utmVisitorDays));
    assert.ok(chatgpt.utmVisitorDays > chatgpt.referrerVisitorDays, 'the fixture mirrors production, where utm_source dominates');
  });

  it('tracks the website the browser tracker reports to', () => {
    const analytics = readFileSync(repoPath('src/services/analytics.ts'), 'utf8');
    assert.match(analytics, new RegExp(`const UMAMI_WEBSITE_ID = '${UMAMI_WEBSITE_ID}'`));
  });
});

describe('Umami live transport', () => {
  const window = deriveWindow(OBSERVED_AT);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('logs in once, sends a browser User-Agent and the bearer token, and keeps both credentials out of the output', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/api/auth/login')) return json({ token: 'tok-SECRET-123', user: { role: 'view-only' } });
      if (String(url).includes('/stats?')) return json(STATS);
      if (String(url).includes('type=channel')) return json(CHANNELS);
      return json(REFERRERS);
    };
    const { snapshot, markdown } = await runCli(['--live', '--stdout'], {
      log: silent,
      env: { UMAMI_API_USERNAME: 'viewer-name', UMAMI_API_PASSWORD: 'hunter2-password' },
      now: () => Date.parse(OBSERVED_AT),
      fetchImpl,
    });
    assert.equal(calls.length, 1 + 28 * 4);
    assert.equal(calls.filter((call) => call.url.endsWith('/api/auth/login')).length, 1);
    for (const call of calls) assert.match(call.init.headers['User-Agent'], /Mozilla/);
    for (const call of calls.slice(1)) {
      assert.equal(call.init.headers.authorization, 'Bearer tok-SECRET-123');
      assert.ok(call.url.includes(`/api/websites/${UMAMI_WEBSITE_ID}/`));
    }
    assert.ok(calls.some((call) => call.url.includes(`/stats?startAt=${window.startAt}&endAt=${window.startAt + 86_400_000}`)));
    assert.ok(calls.some((call) => call.url.includes(`type=referrer&startAt=${window.startAt}&endAt=${window.startAt + 86_400_000}&limit=1000`)));
    assert.ok(calls.some((call) => call.url.includes(`type=utmSource&startAt=${window.startAt}&endAt=${window.startAt + 86_400_000}&limit=1000`)));
    const serialized = JSON.stringify(snapshot) + markdown;
    for (const secret of ['tok-SECRET-123', 'viewer-name', 'hunter2-password']) assert.ok(!serialized.includes(secret), secret);
  });

  it('explains a refused site read as a missing team share', async () => {
    const transport = createLiveTransport({
      username: 'u',
      password: 'p',
      fetchImpl: async (url) => (String(url).endsWith('/api/auth/login') ? json({ token: 't' }) : json({ error: 'Unauthorized' }, 401)),
      sleep: async () => {},
    });
    await assert.rejects(transport.call(ENDPOINTS.totals, window), /Share it with the account through a Umami team/);
  });

  it('explains a refused login without echoing the credentials', async () => {
    const transport = createLiveTransport({
      username: 'viewer-name',
      password: 'hunter2-password',
      fetchImpl: async () => json({ error: 'Unauthorized' }, 401),
      sleep: async () => {},
    });
    await assert.rejects(transport.call(ENDPOINTS.totals, window), (error) => {
      assert.match(error.message, /login was refused/);
      assert.ok(!error.message.includes('viewer-name') && !error.message.includes('hunter2-password'));
      return true;
    });
  });

  it('retries a 5xx and a timeout, then gives up with the last failure', async () => {
    let attempts = 0;
    const transport = createLiveTransport({
      username: 'u',
      password: 'p',
      fetchImpl: async (url) => {
        if (String(url).endsWith('/api/auth/login')) return json({ token: 't' });
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('slow'), { name: 'TimeoutError' });
        return json({}, 503);
      },
      sleep: async () => {},
    });
    await assert.rejects(transport.call(ENDPOINTS.totals, window), /stats failed with HTTP 503 after 3 attempts/);
    assert.equal(attempts, 3);
  });

  it('refuses output that carries a credential or an auth payload', () => {
    assert.throws(() => assertNoSecrets('{"x":"hunter2-password"}', { secrets: ['hunter2-password'] }), /credential/);
    assert.throws(() => assertNoSecrets('{"token":"abc"}'), /token/);
    assert.throws(() => assertNoSecrets('{\n  "password": "abc"\n}'), /password/);
    assert.throws(() => assertNoSecrets('authorization: Bearer abc'), /Bearer/);
    assert.equal(assertNoSecrets('{"visitors":3}', { secrets: ['hunter2-password'] }), '{"visitors":3}');
  });
});
