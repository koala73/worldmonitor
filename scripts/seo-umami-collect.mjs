#!/usr/bin/env node

/**
 * Collect referral aggregates for worldmonitor.app from the self-hosted Umami
 * API, and write a dated snapshot plus a markdown summary beside the Search
 * Console and Bing snapshots (#10024).
 *
 * The contract is the Search Console collector's:
 *
 * - named fields are picked out of each API response, never copied wholesale;
 * - a missing value stays `null` and carries a reason, never zero;
 * - the credentials arrive only through `loadEnvFile()`, are never printed, and
 *   the writer refuses to emit a snapshot that contains them or the token.
 *
 * Each endpoint feeds one section, and each section carries its own
 * `availability` with a reason, so a failed endpoint degrades only its own
 * section.
 *
 * Every count is Umami's `y`, the visitors it attributes to that value. One
 * visitor can arrive through two channels or two referrers in a day, so channel
 * and referrer rows overlap. On 2026-10-31 the seven channels summed to 8,922
 * against 8,593 visitors. Shares are therefore not computed across rows.
 *
 * Referrer domains map onto the referrer families `seo-ai-visibility-collector`
 * defines, plus search, social, internal and other. `google_search_ai` cannot be
 * measured from a referrer: AI Overviews and AI Mode send the same google.com
 * referrer as web search, so that family is always unavailable rather than zero.
 *
 * AI families also count visits tagged `utm_source=<assistant>`: ChatGPT
 * appends `?utm_source=chatgpt.com` to the links it cites and often sends no
 * Referer, so referrer rows alone miss most of its visits. The family figure is
 * the larger of the two counts (see `combineAiFamily`).
 *
 * Channels, referrers and utm sources are asked for one UTC day at a time and summed. A
 * 28-day metrics query takes one to two minutes on the self-hosted instance,
 * and on 2026-11-02 the channel query hit Cloudflare's 100-second origin limit
 * (HTTP 524); a one-day query takes one to six seconds. The sums are visitor-days:
 * a visitor who comes back on three days counts three times. Totals are asked
 * for per day too: the 28-day stats query took 74 seconds on 2026-11-02.
 *
 * Usage:
 *   node scripts/seo-umami-collect.mjs --fixtures tests/fixtures/umami/
 *   node scripts/seo-umami-collect.mjs --live
 *
 * Options:
 *   --fixtures <dir>      read recorded API responses instead of calling Umami
 *   --live                call the API using UMAMI_API_USERNAME and UMAMI_API_PASSWORD
 *   --out-dir <dir>       snapshot directory (default docs/research/seo-ai-visibility/umami)
 *   --date <YYYY-MM-DD>   snapshot date (default the observation date)
 *   --stdout              print the snapshot instead of writing files
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHROME_UA, loadEnvFile } from './_seed-utils.mjs';
import { isMainModule } from './lib/main-module.mjs';
import { REFERRER_FAMILIES } from './seo-ai-visibility-collector.mjs';
import { REFERRAL_METRICS } from './seo-ai-visibility-scorecard.mjs';
import { markdownCell, percent } from './seo-gsc-collect.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const UMAMI_ORIGIN = 'https://abacus.worldmonitor.app';
/** The tracked site, as `UMAMI_WEBSITE_ID` in src/services/analytics.ts. */
export const UMAMI_WEBSITE_ID = 'e8800335-c853-46a8-8497-c993ed2f58bc';
export const ENDPOINTS = Object.freeze({
  totals: 'stats',
  channels: 'metrics?type=channel',
  referrers: 'metrics?type=referrer',
  // ChatGPT appends ?utm_source=chatgpt.com to cited links and often sends no
  // Referer, so the referrer list misses most of its visits.
  utmSources: 'metrics?type=utmSource',
});
const WINDOW_DAYS = 28;
/** Far above the ~90 referrer domains of a day, so a full list never reaches it. */
const REFERRER_ROW_LIMIT = 1_000;
/** Endpoints asked for with `limit=REFERRER_ROW_LIMIT`. */
const ROW_LIMITED_ENDPOINTS = Object.freeze([ENDPOINTS.referrers, ENDPOINTS.utmSources]);
const MAX_TOP_REFERRERS = 25;
/** Days of the window and the endpoints asked for per day. */
const DAILY_ENDPOINTS = Object.freeze(Object.values(ENDPOINTS));
const DAILY_CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 120_000;
/** Delays between attempts; three attempts in total. */
const RETRY_DELAYS_MS = Object.freeze([5_000, 20_000]);
const SNAPSHOT_SCHEMA_VERSION = 1;
const DAY_MS = 86_400_000;

const GOOGLE_SEARCH_AI_REASON = 'Google AI Overviews and AI Mode send the same google.com referrer as web search, so a referrer cannot separate them.';

/**
 * First match wins. A rule matches the domain itself or any subdomain of it,
 * except the `google.<tld>` and `yandex.<tld>` patterns, which name a TLD set.
 */
const FAMILY_RULES = Object.freeze([
  ['internal', ['worldmonitor.app', 'localhost', '127.0.0.1', 'local']],
  ['chatgpt', ['chatgpt.com', 'chat.openai.com']],
  ['perplexity', ['perplexity.ai']],
  ['claude', ['claude.ai']],
  ['copilot_bing', ['copilot.microsoft.com', 'copilot.cloud.microsoft']],
  ['other_ai_search', [
    'gemini.google.com', 'chat.deepseek.com', 'grok.com', 'you.com', 'phind.com',
    'meta.ai', 'chat.mistral.ai', 'poe.com', 'kimi.com', 'chat.qwen.ai',
  ]],
  ['search', [
    /^(www\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/, 'com.google.android.googlequicksearchbox',
    'bing.com', 'duckduckgo.com', 'search.brave.com', /^(www\.)?yandex\.[a-z]{2,3}(\.[a-z]{2})?$/,
    'search.yahoo.com', 'search.yahoo.co.jp', 'ya.ru', 'coccoc.com', 'ecosia.org',
    'baidu.com', 'naver.com', 'startpage.com', 'qwant.com', 'kagi.com', 'seznam.cz',
  ]],
  ['social', [
    't.co', 'x.com', 'twitter.com', 'com.twitter.android', 'facebook.com', 'instagram.com',
    'threads.com', 'threads.net', 'linkedin.com', 'com.linkedin.android', 'lnkd.in', 'reddit.com', 'com.reddit.frontpage',
    'youtube.com', 'news.ycombinator.com', 'bsky.app', 'web.telegram.org',
    'org.telegram.messenger', 'discord.com', 'tiktok.com',
  ]],
]);
/**
 * `utm_source` values that name an AI assistant, matched case-insensitively on
 * the whole value. A source that is not listed (`welcome`, `embed`, a directory
 * site) is `other` and never reaches an AI family.
 */
const UTM_FAMILY_RULES = Object.freeze([
  ['chatgpt', ['chatgpt.com', 'openai']],
  ['perplexity', ['perplexity', 'perplexity.ai']],
  ['claude', ['claude', 'claude.ai', 'anthropic']],
  ['copilot_bing', ['copilot.com', 'copilot', 'bing']],
  ['other_ai_search', ['gemini', 'grok', 'deepseek', 'meta.ai', 'poe']],
]);
const OTHER_FAMILY = 'other';
const AI_FAMILIES = Object.freeze(['chatgpt', 'perplexity', 'claude', 'copilot_bing', 'other_ai_search']);
export const FAMILY_ORDER = Object.freeze([...AI_FAMILIES, 'search', 'social', 'internal', OTHER_FAMILY]);
for (const family of [...AI_FAMILIES, 'google_search_ai', 'unknown_direct']) {
  invariant(REFERRER_FAMILIES.has(family), `${family} is not a referrer family seo-ai-visibility-collector defines`);
}

/**
 * A `"token":` or `"password":` key only appears in an auth payload copied
 * wholesale. The colon matters: referrer domains are visitor-supplied, so a
 * domain spelled `password` must not abort the run.
 */
const SECRET_MARKERS = Object.freeze(['"token":', '"password":', 'Bearer ']);

function invariant(condition, message) {
  if (!condition) throw new Error(`[seo-umami] ${message}`);
}

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const roundTo = (value, digits) => Number(value.toFixed(digits));
const ratio = (numerator, denominator) => (
  denominator > 0 ? roundTo(numerator / denominator, 4) : null
);

const count = (value) => {
  invariant(Number.isInteger(value) && value >= 0, 'a row carries a count that is not a non-negative integer');
  return value;
};

export function referrerFamily(domain) {
  const host = String(domain).toLowerCase();
  for (const [family, patterns] of FAMILY_RULES) {
    for (const pattern of patterns) {
      const matches = typeof pattern === 'string'
        ? host === pattern || host.endsWith(`.${pattern}`)
        : pattern.test(host);
      if (matches) return family;
    }
  }
  return OTHER_FAMILY;
}

export function utmSourceFamily(value) {
  const source = String(value).trim().toLowerCase();
  for (const [family, values] of UTM_FAMILY_RULES) {
    if (values.includes(source)) return family;
  }
  return OTHER_FAMILY;
}

/** The 28 complete UTC days before the observation date. */
export function deriveWindow(observedAt) {
  const endAt = Date.parse(`${observedAt.slice(0, 10)}T00:00:00Z`);
  invariant(Number.isFinite(endAt), 'observedAt is not a date');
  const startAt = endAt - WINDOW_DAYS * DAY_MS;
  return {
    label: `${WINDOW_DAYS}d`,
    startDate: isoDate(startAt),
    endDate: isoDate(endAt - DAY_MS),
    startAt,
    endAt,
  };
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/**
 * Recorded responses named per endpoint in `manifest.json`. A daily endpoint's
 * file maps each `YYYY-MM-DD` to that day's response. A recording of
 * `{ "error": { "code": n } }` answers as that HTTP failure.
 */
export function createFixtureTransport(directory) {
  const root = resolve(directory);
  const manifest = readJson(join(root, 'manifest.json'));
  return {
    kind: 'fixtures',
    manifest,
    async call(endpoint, range) {
      const file = manifest.endpoints?.[endpoint];
      invariant(file !== undefined, `${endpoint} has no recorded response`);
      let payload = readJson(join(root, file));
      if (DAILY_ENDPOINTS.includes(endpoint)) {
        const day = isoDate(range.startAt);
        invariant(day in payload, `${endpoint} has no recorded response for ${day}`);
        payload = payload[day];
      }
      invariant(!payload?.error, `${endpoint} failed with HTTP ${payload?.error?.code ?? 0}`);
      return payload;
    },
  };
}

const defaultSleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * The instance sits behind the same User-Agent policy as the API and rejects a
 * bare runtime agent with 403, the login included, so every request sends
 * CHROME_UA. The token lives only in this closure.
 */
export function createLiveTransport({
  username,
  password,
  fetchImpl = fetch,
  sleep = defaultSleep,
}) {
  const attempts = RETRY_DELAYS_MS.length + 1;
  // One shared login: the daily workers start together and would each log in.
  let login = null;

  async function request(url, init, label) {
    let failure = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1) await sleep(RETRY_DELAYS_MS[attempt - 2]);
      let response;
      try {
        response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (error) {
        failure = error?.name ?? 'network error';
        continue;
      }
      if (response.ok) return response.json();
      await response.body?.cancel().catch(() => {});
      invariant(response.status !== 401, label === 'login'
        ? 'login was refused: check UMAMI_API_USERNAME and UMAMI_API_PASSWORD'
        : `${label} was refused: the account cannot read the site. Share it with the account through a Umami team`);
      invariant(response.status === 429 || response.status >= 500, `${label} failed with HTTP ${response.status}`);
      failure = `HTTP ${response.status}`;
    }
    throw new Error(`[seo-umami] ${label} failed with ${failure} after ${attempts} attempts`);
  }

  return {
    kind: 'umami-api',
    async call(endpoint, range) {
      login ??= request(`${UMAMI_ORIGIN}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'User-Agent': CHROME_UA },
        body: JSON.stringify({ username, password }),
      }, 'login').then((auth) => {
        invariant(typeof auth?.token === 'string' && auth.token !== '', 'login returned no token');
        return auth.token;
      });
      const token = await login;
      const separator = endpoint.includes('?') ? '&' : '?';
      const limit = ROW_LIMITED_ENDPOINTS.includes(endpoint) ? `&limit=${REFERRER_ROW_LIMIT}` : '';
      const url = `${UMAMI_ORIGIN}/api/websites/${UMAMI_WEBSITE_ID}/${endpoint}${separator}startAt=${range.startAt}&endAt=${range.endAt}${limit}`;
      return request(url, {
        headers: { accept: 'application/json', authorization: `Bearer ${token}`, 'User-Agent': CHROME_UA },
      }, endpoint);
    },
  };
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

const unavailable = (endpoint, reason) => ({ endpoint, availability: 'unavailable', reason });

const failureReason = (error) => error.message.replace(/^\[seo-umami\] /, '');

async function fetchPayload(transport, endpoint, range) {
  try {
    return { payload: await transport.call(endpoint, range), reason: null };
  } catch (error) {
    return { payload: null, reason: failureReason(error) };
  }
}

/**
 * One request per day, summed by value. A failed day is left out and named in
 * `reason`; the section is unavailable only when every day failed.
 */
const STATS_FIELDS = Object.freeze(['pageviews', 'visitors', 'visits', 'bounces', 'totaltime']);

/** A day's payload as `[key, count]` pairs to sum: stats by field, metrics by value. */
function dayEntries(endpoint, payload) {
  if (endpoint === ENDPOINTS.totals) {
    invariant(payload && typeof payload === 'object' && !Array.isArray(payload), 'stats returned no object');
    return STATS_FIELDS.map((field) => [field, count(payload[field])]);
  }
  invariant(Array.isArray(payload), `${endpoint} returned no row list`);
  return payload.map((row) => [String(row.x ?? ''), count(row.y)]);
}

async function fetchDaily(transport, endpoint, window) {
  const days = Array.from({ length: WINDOW_DAYS }, (_, index) => window.startAt + index * DAY_MS);
  const results = new Array(days.length);
  let next = 0;
  const worker = async () => {
    while (next < days.length) {
      const index = next;
      next += 1;
      results[index] = await fetchPayload(transport, endpoint, { startAt: days[index], endAt: days[index] + DAY_MS });
    }
  };
  await Promise.all(Array.from({ length: DAILY_CONCURRENCY }, worker));

  const totals = new Map();
  const missing = [];
  let capped = false;
  let lastReason = null;
  for (const [index, { payload, reason }] of results.entries()) {
    // A day whose payload fails its shape check is dropped whole, like a failed request.
    let rows = null;
    let dayReason = reason;
    try {
      if (payload !== null) rows = dayEntries(endpoint, payload);
    } catch (error) {
      dayReason = failureReason(error);
    }
    if (rows === null) {
      missing.push(`${isoDate(days[index])} (${dayReason})`);
      lastReason = dayReason;
      continue;
    }
    if (ROW_LIMITED_ENDPOINTS.includes(endpoint) && rows.length >= REFERRER_ROW_LIMIT) capped = true;
    for (const [key, visitors] of rows) totals.set(key, (totals.get(key) ?? 0) + visitors);
  }
  if (missing.length === days.length) return { payload: null, reason: lastReason, daysReported: 0 };
  return {
    payload: [...totals].map(([x, y]) => ({ x, y })),
    reason: missing.length > 0 ? `missing ${missing.length} of ${WINDOW_DAYS} days: ${missing.join('; ')}` : null,
    daysReported: days.length - missing.length,
    capped,
  };
}

const dailyStatus = ({ reason, daysReported }, extra = null) => {
  const reasons = [reason, extra].filter(Boolean);
  return {
    availability: reasons.length === 0 ? 'available' : 'partial',
    reason: reasons.length === 0 ? null : `${reasons.join('. ')}. Sums leave out what is missing.`,
    basis: 'sum-of-daily-values',
    daysReported,
  };
};

/**
 * Pageviews, visits, bounces and time are additive across days. Visitors are
 * not, so `visitorDays` is named for what it is. No previous window is
 * reported: Umami keeps 30 days of raw events (scripts/umami-retention.sql), so
 * the 28 days before this window are mostly deleted and would read as a crash.
 */
function buildTotals(fetched) {
  if (fetched.payload === null) return unavailable(ENDPOINTS.totals, fetched.reason);
  const sums = Object.fromEntries(fetched.payload.map(({ x, y }) => [x, y]));
  return {
    endpoint: ENDPOINTS.totals,
    ...dailyStatus(fetched),
    pageviews: sums.pageviews,
    visitorDays: sums.visitors,
    visits: sums.visits,
    bounceRate: ratio(sums.bounces, sums.visits),
    avgVisitSeconds: sums.visits > 0 ? Math.round(sums.totaltime / sums.visits) : null,
  };
}

const pickRows = (payload, endpoint) => {
  invariant(Array.isArray(payload), `${endpoint} returned no row list`);
  return payload.map((row) => ({ key: String(row.x ?? ''), visitorDays: count(row.y) }));
};

function buildChannels(fetched) {
  if (fetched.payload === null) return unavailable(ENDPOINTS.channels, fetched.reason);
  const rows = pickRows(fetched.payload, ENDPOINTS.channels)
    .map(({ key, visitorDays }) => ({ channel: key, visitorDays }))
    .sort((left, right) => right.visitorDays - left.visitorDays || left.channel.localeCompare(right.channel));
  return { endpoint: ENDPOINTS.channels, ...dailyStatus(fetched), rows };
}

const MAX_TOP_UTM_SOURCES = 10;
const COMBINED_BASIS = 'max-of-referrer-and-utm-lower-bound';
const REFERRER_ONLY_BASIS = 'referrer-only';
const UTM_ONLY_BASIS = 'utm-only';

/**
 * The `utm_source` rows, classified. Unavailable when no day answered; a
 * failed day or a row-limit cut makes it partial through `dailyStatus`.
 */
function buildUtmSources(fetched) {
  if (fetched.payload === null) return unavailable(ENDPOINTS.utmSources, fetched.reason);
  const rows = pickRows(fetched.payload, ENDPOINTS.utmSources)
    .filter((row) => row.key !== '')
    .map(({ key, visitorDays }) => ({ source: key.toLowerCase(), family: utmSourceFamily(key), visitorDays }))
    .sort((left, right) => right.visitorDays - left.visitorDays || left.source.localeCompare(right.source));
  const byFamily = Object.fromEntries(AI_FAMILIES.map((family) => {
    const group = rows.filter((row) => row.family === family);
    return [family, {
      visitorDays: group.reduce((total, row) => total + row.visitorDays, 0),
      sources: group.slice(0, 5).map(({ source, visitorDays }) => ({ source, visitorDays })),
    }];
  }));
  return {
    endpoint: ENDPOINTS.utmSources,
    ...dailyStatus(fetched, fetched.capped
      ? `Umami returned the ${REFERRER_ROW_LIMIT}-row limit on at least one day, so that day's long tail is cut and utm_source sums are lower bounds`
      : null),
    byFamily,
    top: rows.slice(0, MAX_TOP_UTM_SOURCES),
  };
}

/**
 * One AI family from both signals. ChatGPT tags the links it cites with
 * `utm_source=chatgpt.com` and often sends no Referer, so the referrer rows
 * alone miss most of its visits; a visit can also carry both signals.
 *
 * The two numbers come from separate aggregate endpoints that cannot be joined
 * per visit, so there is no way to tell which visits appear in both. A sum
 * would count those twice. The maximum never double-counts: every visit in the
 * larger signal is a real visit, so `max` is a lower bound on the family's true
 * visitor-days. It is not an estimate; the overlap is unknown.
 */
function combineAiFamily({ family, referrerVisitorDays, referrerStatus, utm }) {
  if (utm.availability === 'unavailable') {
    return {
      availability: 'partial',
      reason: [
        referrerStatus.reason,
        `utm_source counts are unavailable (${utm.reason}), so this is the referrer count alone and misses visits that carry only utm_source`,
      ].filter(Boolean).join('. '),
      visitorDays: referrerVisitorDays,
      referrerVisitorDays,
      utmVisitorDays: null,
      basis: REFERRER_ONLY_BASIS,
    };
  }
  const utmVisitorDays = utm.byFamily[family].visitorDays;
  return {
    availability: referrerStatus.availability === 'available' && utm.availability === 'available' ? 'available' : 'partial',
    reason: [referrerStatus.reason, utm.reason].filter(Boolean).join('. ') || null,
    visitorDays: Math.max(referrerVisitorDays, utmVisitorDays),
    referrerVisitorDays,
    utmVisitorDays,
    basis: COMBINED_BASIS,
  };
}

function buildReferrers(fetched, channels, utmFetched) {
  const { payload, reason } = fetched;
  // Derived families carry their source section's status: a sum missing days is partial, not available.
  const unknownDirect = channels.availability === 'unavailable'
    ? { availability: 'unavailable', reason: `Umami channel metrics are unavailable: ${channels.reason}`, visitorDays: null }
    : {
      availability: channels.availability,
      reason: channels.reason,
      visitorDays: channels.rows.find((row) => row.channel === 'direct')?.visitorDays ?? 0,
      source: 'channel direct',
    };
  const googleSearchAi = { availability: 'unavailable', reason: GOOGLE_SEARCH_AI_REASON, visitorDays: null };
  // A malformed utm_source payload degrades to "unavailable" like a failed request.
  let utm;
  try {
    utm = buildUtmSources(utmFetched);
  } catch (error) {
    utm = unavailable(ENDPOINTS.utmSources, failureReason(error));
  }
  if (payload === null) {
    // Without referrer rows the utm_source counts still measure the AI
    // families; report them as partial instead of dropping them.
    const utmOnly = utm.availability === 'unavailable'
      ? {}
      : Object.fromEntries(AI_FAMILIES.map((family) => [family, {
        availability: 'partial',
        reason: [`Umami referrer metrics are unavailable (${reason}), so this is the utm_source count alone and misses visits that carry only a referrer`, utm.reason].filter(Boolean).join('. '),
        visitorDays: utm.byFamily[family].visitorDays,
        referrerVisitorDays: null,
        utmVisitorDays: utm.byFamily[family].visitorDays,
        basis: UTM_ONLY_BASIS,
      }]));
    return {
      ...unavailable(ENDPOINTS.referrers, reason),
      utmSources: utm,
      referrerFamilies: { ...utmOnly, google_search_ai: googleSearchAi, unknown_direct: unknownDirect },
    };
  }
  const rows = pickRows(payload, ENDPOINTS.referrers)
    .filter((row) => row.key !== '')
    .map(({ key, visitorDays }) => ({ domain: key.toLowerCase(), family: referrerFamily(key), visitorDays }))
    .sort((left, right) => right.visitorDays - left.visitorDays || left.domain.localeCompare(right.domain));

  const byFamily = {};
  for (const family of FAMILY_ORDER) {
    const group = rows.filter((row) => row.family === family);
    byFamily[family] = {
      visitorDays: group.reduce((total, row) => total + row.visitorDays, 0),
      domains: group.length,
      top: group.slice(0, 5).map(({ domain, visitorDays }) => ({ domain, visitorDays })),
    };
  }
  const status = dailyStatus(fetched, fetched.capped
    ? `Umami returned the ${REFERRER_ROW_LIMIT}-row limit on at least one day, so that day's long tail is cut and family sums are lower bounds`
    : null);
  return {
    endpoint: ENDPOINTS.referrers,
    ...status,
    domains: rows.length,
    byFamily,
    utmSources: utm,
    referrerFamilies: {
      ...Object.fromEntries(AI_FAMILIES.map((family) => [family, combineAiFamily({
        family,
        referrerVisitorDays: byFamily[family].visitorDays,
        referrerStatus: status,
        utm,
      })])),
      google_search_ai: googleSearchAi,
      unknown_direct: unknownDirect,
    },
    top: rows.slice(0, MAX_TOP_REFERRERS),
  };
}

export async function collectUmamiSnapshot({ transport, observedAt }) {
  const window = deriveWindow(observedAt);
  const raw = {
    totals: await fetchDaily(transport, ENDPOINTS.totals, window),
    channels: await fetchDaily(transport, ENDPOINTS.channels, window),
    referrers: await fetchDaily(transport, ENDPOINTS.referrers, window),
  };
  // utm_source only refines the AI families, so it alone cannot make a snapshot.
  const utmFetched = await fetchDaily(transport, ENDPOINTS.utmSources, window);
  const failures = Object.values(raw).filter((entry) => entry.payload === null);
  invariant(
    failures.length < Object.keys(raw).length,
    `every Umami endpoint failed, so there is no snapshot to write: ${failures.map((entry) => entry.reason).join('; ')}`,
  );
  // A payload that fails its shape check degrades its own section, like a failed request.
  const guarded = (endpoint, build) => {
    try {
      return build();
    } catch (error) {
      return unavailable(endpoint, failureReason(error));
    }
  };
  const channels = guarded(ENDPOINTS.channels, () => buildChannels(raw.channels));
  const referrers = guarded(ENDPOINTS.referrers, () => buildReferrers(raw.referrers, channels, utmFetched));
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: `umami-${observedAt.slice(0, 10)}`,
    observedAt,
    source: transport.kind,
    window: { label: window.label, startDate: window.startDate, endDate: window.endDate },
    totals: guarded(ENDPOINTS.totals, () => buildTotals(raw.totals)),
    channels,
    referrers: referrers.referrerFamilies
      ? referrers
      : buildReferrers({ payload: null, reason: referrers.reason }, channels, utmFetched),
    guardrails: [
      'Every count is a sum of 28 daily values. Visitors are visitor-days: a returning visitor counts once per day, and channel and referrer rows overlap.',
      'No previous window: Umami keeps 30 days of raw events, so week-over-week change comes from comparing weekly snapshots.',
      'AI family visitor-days are the larger of the referrer count and the utm_source count, never their sum: the two aggregates cannot be joined per visit and one visit can carry both, so the figure is a lower bound.',
      'google_search_ai is unavailable, never zero: a referrer cannot separate AI Overviews and AI Mode from web search.',
      'The credentials and session token stay in operator configuration and never reach this file.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Scorecard feed
// ---------------------------------------------------------------------------

const SCORECARD_WINDOWS = Object.freeze({ '28d': 28, '90d': 90 });
/**
 * Characters of an upstream reason quoted in the scorecard reason; the rest is
 * in the snapshot. Three such quotes stay far under the 4 KB limit even in
 * multi-byte text.
 */
const MAX_QUOTED_REASON = 300;
const brief = (text) => {
  const characters = [...String(text ?? '')];
  return characters.length <= MAX_QUOTED_REASON
    ? characters.join('')
    : `${characters.slice(0, MAX_QUOTED_REASON).join('')}... (see the snapshot)`;
};

/**
 * Shape a snapshot for `sources.referrals` of
 * `scripts/seo-ai-visibility-collector.mjs`.
 *
 * Only `sessions` has a source: Umami's `visits`, summed over the 28 one-day
 * queries. Visitors are visitor-days and never stand in for sessions. The
 * outcome metrics need landing-page and event breakdowns this collector does
 * not read, so they are null. There is no 90-day window: Umami keeps 30 days
 * of raw events. Referrer families are counted in visitor-days with no
 * landing-page dimension, so they cannot fill the referrer × landing-page
 * session segments; the reason lists them against the classification instead.
 */
export function toScorecardReferralExport(snapshot, { classification }) {
  const { window, totals, referrers } = snapshot;
  const sessions = totals.availability === 'available' && Number.isInteger(totals.visits)
    ? totals.visits
    : null;
  const nullMetrics = Object.fromEntries(REFERRAL_METRICS.map((metric) => [metric, null]));
  const windows = Object.entries(SCORECARD_WINDOWS).map(([label, days]) => ({
    label,
    startDate: isoDate(Date.parse(window.endDate) - (days - 1) * DAY_MS),
    endDate: window.endDate,
    metrics: label === window.label ? { ...nullMetrics, sessions } : nullMetrics,
  }));
  // A partial section's reason lists every failed day. It is stated once below,
  // bounded, rather than repeated per family, so the whole reason stays inside
  // the collector's 4 KB limit however many days failed.
  const families = classification.families.map(({ id, hostSuffixes }) => {
    const measured = referrers.referrerFamilies?.[id];
    const value = !measured
      ? 'not measured'
      : measured.visitorDays === null
        ? `unavailable (${brief(measured.reason)})`
        : `${measured.visitorDays}${measured.availability === 'available' ? '' : ` (${measured.availability}${measured.basis && measured.basis !== COMBINED_BASIS ? `, ${measured.basis}` : ''})`}`;
    // Where the classification and the Umami host rules disagree, say so: the
    // count above follows the Umami rules.
    const elsewhere = hostSuffixes
      .map((host) => [host, referrerFamily(host)])
      .filter(([, family]) => family !== id)
      .map(([host, family]) => `${host} counts as ${family}`);
    return `${id} ${value}${elsewhere.length > 0 ? ` [${elsewhere.join(', ')}]` : ''}`;
  });
  const sectionNotes = [
    ['Referrer', referrers],
    ['utm_source', referrers.utmSources],
    ['Channel (the unknown_direct source)', snapshot.channels],
  ]
    .filter(([, section]) => section && section.availability !== 'available')
    .map(([name, section]) => `${name} counts are ${section.availability}: ${brief(section.reason)}`);
  const notes = [
    sessions === null
      ? `sessions is null: Umami totals are ${totals.availability} (${brief(totals.reason ?? 'no visits count was returned')}).`
      : 'sessions is Umami `visits`, summed over 28 one-day queries, so a visit that spans midnight UTC counts on both days. Umami visitors are visitor-days and are not reported as sessions.',
    `${REFERRAL_METRICS.filter((metric) => metric !== 'sessions').join(', ')} are null: the weekly Umami collection reads no landing-page or event breakdown.`,
    'The 90d window is null: Umami keeps 30 days of raw events.',
    'There are no referrer by landing-page segments: Umami referrer counts are visitor-days with no landing-page dimension.',
    `Referrer families, ${window.label} visitor-days. Each AI family is the larger of its referrer count (the Umami collector's host rules) and its utm_source count, never their sum: the two cannot be joined per visit, so the figure is a lower bound. ${families.join('; ')}.`,
    ...sectionNotes.map((note) => (/[.!?]$/.test(note) ? note : `${note}.`)),
  ];
  return {
    status: sessions === null ? 'unavailable' : 'partial',
    reason: notes.join(' '),
    windows,
    rows: [],
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** Refuse to write anything that carries a credential, the token, or an auth payload. */
export function assertNoSecrets(serialized, { secrets = [] } = {}) {
  for (const marker of SECRET_MARKERS) {
    invariant(!serialized.includes(marker), `refusing to write output containing ${marker.replace(/[":\s]/g, '')}`);
  }
  for (const value of secrets) {
    if (typeof value !== 'string' || value.length < 4) continue;
    invariant(
      !serialized.includes(value) && !serialized.includes(encodeURIComponent(value)),
      'refusing to write output containing a credential',
    );
  }
  return serialized;
}

const unavailableLine = (section) => `Not measured: ${section.reason}`;
const duration = (seconds) => (seconds === null ? 'n/a' : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`);

function renderTotals(totals, lines) {
  lines.push('## Totals');
  lines.push('');
  if (totals.availability === 'unavailable') {
    lines.push(unavailableLine(totals));
    lines.push('');
    return;
  }
  if (totals.reason) lines.push(`Partial: ${totals.reason}`);
  lines.push(`Summed over ${totals.daysReported} daily queries. Visitor-days count a returning visitor once per day.`);
  lines.push('');
  lines.push('| Visitor-days | Visits | Pageviews | Bounce rate | Avg visit |');
  lines.push('|---:|---:|---:|---:|---:|');
  lines.push(`| ${totals.visitorDays} | ${totals.visits} | ${totals.pageviews} | ${percent(totals.bounceRate)} | ${duration(totals.avgVisitSeconds)} |`);
  lines.push('');
}

function renderChannels(channels, lines) {
  lines.push('## Channels');
  lines.push('');
  if (channels.availability === 'unavailable') {
    lines.push(unavailableLine(channels));
    lines.push('');
    return;
  }
  if (channels.reason) lines.push(`Partial: ${channels.reason}`);
  lines.push(`Umami's own channel classification, summed over ${channels.daysReported} daily queries: a visitor counts once per day per channel.`);
  lines.push('');
  lines.push('| Channel | Visitor-days |');
  lines.push('|---|---:|');
  for (const row of channels.rows) lines.push(`| ${markdownCell(row.channel)} | ${row.visitorDays} |`);
  lines.push('');
}

function renderReferrers(referrers, lines) {
  lines.push('## Referrer families');
  lines.push('');
  if (referrers.availability === 'unavailable') {
    lines.push(unavailableLine(referrers));
    lines.push('');
  } else {
    if (referrers.reason) lines.push(`Partial: ${referrers.reason}`);
    lines.push(`${referrers.domains} referrer domains, summed over ${referrers.daysReported} daily queries: a visitor counts once per day per domain.`);
    lines.push('');
    lines.push('| Family | Visitor-days | Domains | Largest domains |');
    lines.push('|---|---:|---:|---|');
    for (const family of FAMILY_ORDER) {
      const row = referrers.byFamily[family];
      const largest = row.top.map(({ domain, visitorDays }) => `${markdownCell(domain)} (${visitorDays})`).join(', ') || 'none';
      lines.push(`| ${family} | ${row.visitorDays} | ${row.domains} | ${largest} |`);
    }
    lines.push('');
  }
  lines.push('### AI referrer families');
  lines.push('');
  lines.push('| Family | Visitor-days | Note |');
  lines.push('|---|---:|---|');
  for (const [family, row] of Object.entries(referrers.referrerFamilies)) {
    const signals = row.basis === undefined
      ? null
      : `referrer ${row.referrerVisitorDays}, utm_source ${row.utmVisitorDays ?? 'n/a'}, basis ${row.basis}`;
    const note = [row.source, signals, row.availability === 'available' ? null : `${row.availability}: ${row.reason}`].filter(Boolean).join('; ');
    lines.push(`| ${family} | ${row.visitorDays ?? 'n/a'} | ${markdownCell(note)} |`);
  }
  lines.push('');
  if (referrers.top) {
    lines.push(`### Top ${referrers.top.length} referrers`);
    lines.push('');
    lines.push('| Domain | Family | Visitor-days |');
    lines.push('|---|---|---:|');
    for (const row of referrers.top) lines.push(`| ${markdownCell(row.domain)} | ${row.family} | ${row.visitorDays} |`);
    lines.push('');
  }
}

export function renderUmamiMarkdown(snapshot) {
  const lines = [];
  lines.push(`# Umami referral snapshot ${snapshot.observedAt.slice(0, 10)}`);
  lines.push('');
  lines.push(`Source: \`${snapshot.source}\`. Window: ${snapshot.window.startDate} to ${snapshot.window.endDate}, the ${snapshot.window.label.replace('d', '')} complete UTC days before the run.`);
  lines.push('');
  lines.push('| Section | Endpoint | Availability |');
  lines.push('|---|---|---|');
  for (const name of ['totals', 'channels', 'referrers']) {
    lines.push(`| ${name} | \`${snapshot[name].endpoint}\` | ${snapshot[name].availability} |`);
  }
  lines.push('');
  renderTotals(snapshot.totals, lines);
  renderChannels(snapshot.channels, lines);
  renderReferrers(snapshot.referrers, lines);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const options = {
    fixtures: null,
    live: false,
    outDir: 'docs/research/seo-ai-visibility/umami',
    date: null,
    stdout: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      const value = argv[index + 1];
      invariant(value !== undefined && !value.startsWith('--'), `${flag} requires a value`);
      index += 1;
      return value;
    };
    switch (flag) {
      case '--fixtures': options.fixtures = next(); break;
      case '--live': options.live = true; break;
      case '--out-dir': options.outDir = next(); break;
      case '--date': options.date = next(); break;
      case '--stdout': options.stdout = true; break;
      default: throw new Error(`[seo-umami] unknown argument ${flag}`);
    }
  }
  invariant(options.fixtures !== null || options.live, 'pass --fixtures <dir> or --live');
  invariant(!(options.fixtures !== null && options.live), '--fixtures and --live are mutually exclusive');
  invariant(options.date === null || /^\d{4}-\d{2}-\d{2}$/.test(options.date), '--date must be YYYY-MM-DD');
  return options;
}

export async function runCli(argv, { env = process.env, log = console.log, now = Date.now, fetchImpl = fetch } = {}) {
  const options = parseArgs(argv);

  let transport;
  let observedAt;
  let secrets = [];
  if (options.fixtures) {
    transport = createFixtureTransport(resolve(REPO_ROOT, options.fixtures));
    observedAt = transport.manifest.recordedAt;
    invariant(
      typeof observedAt === 'string' && observedAt !== '',
      'the fixture manifest must record recordedAt so the run is deterministic',
    );
  } else {
    loadEnvFile(import.meta.url, { only: ['UMAMI_API_USERNAME', 'UMAMI_API_PASSWORD'] });
    const username = env.UMAMI_API_USERNAME?.trim();
    const password = env.UMAMI_API_PASSWORD;
    invariant(
      username && typeof password === 'string' && password !== '',
      'UMAMI_API_USERNAME and UMAMI_API_PASSWORD are not both set. Use a view-only Umami account that a team shares the site with, and store both in .env.local.',
    );
    secrets = [username, password];
    observedAt = new Date(now()).toISOString();
    transport = createLiveTransport({ username, password, fetchImpl });
  }

  const snapshot = await collectUmamiSnapshot({ transport, observedAt });
  const date = options.date ?? observedAt.slice(0, 10);
  const json = assertNoSecrets(`${JSON.stringify(snapshot, null, 2)}\n`, { secrets });
  const markdown = assertNoSecrets(renderUmamiMarkdown(snapshot), { secrets });

  if (options.stdout) {
    log(json);
    return { snapshot, markdown, written: [] };
  }

  const outDir = resolve(REPO_ROOT, options.outDir);
  mkdirSync(outDir, { recursive: true });
  const written = [join(outDir, `${date}.json`), join(outDir, `${date}.md`)];
  writeFileSync(written[0], json);
  writeFileSync(written[1], markdown);
  log(`[seo-umami] wrote ${written.map((path) => path.replace(`${REPO_ROOT}/`, '')).join(', ')}`);
  return { snapshot, markdown, written };
}

if (isMainModule(import.meta.url, process.argv[1])) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
