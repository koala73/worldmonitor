#!/usr/bin/env node
// Freeze last-known-good crawlable live-pulse values for country risk,
// chokepoint status, crisis HAPI summaries, the top news headlines,
// the market tape, and
// per-country recent developments (digest headlines matched per country,
// plus the intel brief and timeline where a service key unlocks the
// tier-gated routes). Writes
// docs/snapshots/crawlable-live-pulse-<YYYY-MM-DD>.json.
//
// Usage:
//   API_BASE=https://www.worldmonitor.app node scripts/freeze-crawlable-live-pulse.mjs
//   WORLDMONITOR_API_KEY=<tier-1+ key> API_BASE=... node scripts/freeze-crawlable-live-pulse.mjs
//
// Uses the anonymous wm-session mint path (same contract as live-tools.js),
// upgraded with X-WorldMonitor-Key when a service key is configured — the
// weekly cron provides it via the WORLDMONITOR_API_KEY secret, mirroring the
// resilience-snapshot workflow. Without a key the brief/timeline captures are
// skipped per country (recorded, never fabricated) and the freeze still
// publishes digest headlines.
// Builds remain deterministic: the corpus generator only reads the committed
// snapshot and never fetches live data.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  chokepointStatusViewModel,
  crisisTrackerViewModel,
  liveRiskViewModel,
} from './crawlable-live-tools.mjs';
import { loadEnvFile } from './_seed-utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// Tier-gated captures (intel brief, intel timeline) need a service key; the
// anonymous wm-session the cron mints otherwise gets a 401 on those routes
// (ENDPOINT_ENTITLEMENTS tier 1). Same pattern as
// scripts/freeze-resilience-ranking.mjs: key when available, graceful
// headlines-only degradation when absent. Inert under test runners.
loadEnvFile(import.meta.url, {
  only: ['WORLDMONITOR_API_KEY', 'WM_API_KEY'],
});

function serviceApiKey() {
  return process.env.WM_API_KEY || process.env.WORLDMONITOR_API_KEY || '';
}

const API_BASE = (process.env.API_BASE || 'https://www.worldmonitor.app').replace(/\/$/, '');
const USER_AGENT = process.env.USER_AGENT
  || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
// `Number(env || fallback)` only substitutes the fallback for unset/empty. A typo
// like `20s` parses to NaN, which Node coerces to a ~1ms timer -- every request
// would abort instantly and surface as "captured only 0 countries" instead of a
// bad-env-var error. Fail back to the documented default explicitly.
function numberFromEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const REQUEST_GAP_MS = numberFromEnv('PULSE_FREEZE_GAP_MS', 120);
const HTTP_TIMEOUT_MS = numberFromEnv('PULSE_FREEZE_TIMEOUT_MS', 20_000);
const OUTPUT_BASENAME = process.env.PULSE_FREEZE_OUTPUT_BASENAME || '';

// Countries the upstream may legitimately fail to serve in a single run before
// the freeze is considered too thin to publish. Chokepoints and crises are
// small enough sets that partial capture is never acceptable.
const MAX_COUNTRY_CAPTURE_SHORTFALL = 5;

// The welcome strip's headline card renders four rows, and
// scripts/build-welcome-teasers.mjs derives them from this capture.
//
// A shortfall is recorded and warned about, NOT thrown. This step runs last,
// just before the only write, so throwing here would discard ~196 successfully
// captured countries over a news-content problem -- and two such Mondays in a
// row would push the snapshot past MAX_LIVE_PULSE_SNAPSHOT_AGE_DAYS and hard-
// fail the whole crawlable corpus build. The strip degrades to fewer rows (or
// none); it can never fill the gap with something unattributable, because the
// generator publishes exactly what this capture vouched for.
const HEADLINE_CAPTURE_COUNT = 4;

// Share of headline-matched countries that must come back with a publishable
// brief before the freeze is considered healthy. Proportional because the
// matched set varies run to run, and generous because each brief is an LLM
// response that must clear grounding and citation checks — a genuine outage
// shows up as the zero-brief check, not as a few rejections.
export const MIN_BRIEF_CAPTURE_RATIO = 0.6;

// Lose at most one country, or the ratio's share of them -- whichever is more
// forgiving. Neither rule works alone: a bare ratio demands 2 of 2 on a
// two-country set, where a single LLM rejection is noise rather than a signal;
// a bare "all but one" demands 50 of 51 on a real run. Taking the lower bound
// of the two keeps a majority collapse failing at every set size (1 of 7 still
// rejects) while letting an ordinary run's handful of rejections through.
export function minimumBriefCaptures(briefMatchedCount) {
  return Math.max(1, Math.min(
    briefMatchedCount - 1,
    Math.ceil(briefMatchedCount * MIN_BRIEF_CAPTURE_RATIO),
  ));
}

// Aggregator hosts whose article links are opaque, expiring redirects rather
// than the publisher's own URL. A frozen row is published for up to
// MAX_LIVE_PULSE_SNAPSHOT_AGE_DAYS, and "verifiable" has to mean a reader can
// see the outlet in the URL and still reach the piece next week.
const AGGREGATOR_LINK_HOSTS = new Set(['news.google.com']);

// Shared with scripts/build-welcome-teasers.mjs so the capture-time rule and
// the publish-time re-check cannot drift apart.
export function isVerifiableArticleUrl(url) {
  const value = String(url || '').trim();
  const parsed = URL.parse(value);
  if (!parsed || parsed.protocol !== 'https:' || !parsed.hostname) return false;
  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  return hostname.length > 0 && !AGGREGATOR_LINK_HOSTS.has(hostname);
}

// The market card's twelve rows, and the labels it renders them under.
//
// Mirrors QUOTE_SYMBOLS / QUOTE_LABELS in pro-test/src/services/teasers.ts.
// pro-test is an isolated package that must not import from here, so the lists
// are duplicated on purpose; tests/welcome-teasers.test.mjs imports both and
// fails if they drift.
const MARKET_QUOTE_SYMBOLS = ['^GSPC', '^IXIC', '^VIX'];
const COMMODITY_QUOTE_SYMBOLS = ['CL=F', 'BZ=F', 'GC=F', 'HG=F', 'NG=F', 'EURUSD=X', 'USDJPY=X'];
const CRYPTO_QUOTE_IDS = ['bitcoin', 'ethereum'];
export const QUOTE_SYMBOLS = [
  '^GSPC', '^IXIC', '^VIX', 'BTC', 'ETH',
  'CL=F', 'BZ=F', 'GC=F', 'HG=F', 'NG=F', 'EURUSD=X', 'USDJPY=X',
];
export const QUOTE_LABELS = {
  '^GSPC': 'S&P 500',
  '^IXIC': 'Nasdaq',
  '^VIX': 'VIX',
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  'CL=F': 'WTI crude',
  'BZ=F': 'Brent',
  'GC=F': 'Gold',
  'HG=F': 'Copper',
  'NG=F': 'Nat gas',
  'EURUSD=X': 'EUR/USD',
  'USDJPY=X': 'USD/JPY',
};

// The card paints a 14x5px sparkline, so the upstream's 48-530 point series is
// far more resolution than it can show and far more bytes than the committed
// snapshot should carry. Reduce to an evenly spaced sample that keeps the first
// and last observation, so the frozen curve starts and ends where the real one
// does instead of being a truncated tail.
const QUOTE_SPARKLINE_POINTS = 12;

// Round to a precision that survives every instrument on the card: FX quotes
// live in the fourth decimal (EUR/USD 1.0821) while index levels need none.
function roundQuoteValue(value) {
  return Math.round(Number(value) * 10_000) / 10_000;
}

export function downsampleSparkline(points, target = QUOTE_SPARKLINE_POINTS) {
  const values = (Array.isArray(points) ? points : [])
    .map(Number)
    .filter((value) => Number.isFinite(value));
  if (values.length <= target) return values.map(roundQuoteValue);
  const step = (values.length - 1) / (target - 1);
  return Array.from({ length: target }, (_, i) => roundQuoteValue(values[Math.round(i * step)]));
}

// A quote row names a real instrument, so every field has to come from the
// upstream rather than be filled in. #7608 shipped a hand-written market tape
// that drifted to a 22% error on the S&P and a 30% error on Bitcoin -- specific
// false numbers about named instruments, published as "live data". A row
// missing a usable price is dropped, never defaulted.
export function selectFrozenQuotes(payloads) {
  const bySymbol = new Map();
  for (const payload of payloads) {
    for (const quote of Array.isArray(payload?.quotes) ? payload.quotes : []) {
      const symbol = String(quote?.symbol || '').trim();
      const price = Number(quote?.price);
      const change = Number(quote?.change);
      if (!QUOTE_LABELS[symbol]) continue;
      if (!Number.isFinite(price) || price <= 0) continue;
      bySymbol.set(symbol, {
        symbol,
        display: QUOTE_LABELS[symbol],
        price: roundQuoteValue(price),
        change: Number.isFinite(change) ? Math.round(change * 100) / 100 : 0,
        sparkline: downsampleSparkline(quote?.sparkline),
      });
    }
  }
  // Card order, not response order: the strip renders equities, crypto, energy,
  // metals and FX in a fixed sequence.
  return QUOTE_SYMBOLS.map((symbol) => bySymbol.get(symbol)).filter(Boolean);
}

// Per-country "Recent developments" cap (#7615): 3-5 dated, attributed,
// linked headlines per country page. Below 3 the section is thin; above 5 the
// frozen snapshot bloats for no crawlable gain.
const COUNTRY_HEADLINE_LIMIT = 5;

// Timeline depth per country (#7615: "where populated"). A dated event
// sequence, not the whole history store — the corpus renders these as a short
// list, and each record carries its own occurredAt.
const COUNTRY_TIMELINE_LIMIT = 10;

// A crawlable country page should describe recent developments, not the full
// durable history store. Keep the query window explicit and derive its lower
// bound from the single freeze clock so every country uses the same interval.
const COUNTRY_TIMELINE_WINDOW_DAYS = 10;
const COUNTRY_TIMELINE_WINDOW_MS = COUNTRY_TIMELINE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

// Brief context budget (#7615). The dashboard sends 3800 chars of grounding
// (src/app/country-intel.ts); the freeze builds the same `Source [n]` block
// from the same digest so citation indexes align with the frozen sources.
const BRIEF_CONTEXT_MAX_CHARS = 3800;

// Operator-facing review-hygiene text the chokepoint status contract appends
// (THREAT_CONFIG_STALE_NOTE in server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts).
// It is useful in the live tool but must not be frozen into the crawlable corpus,
// where it becomes indexed, quotable page content.
const INTERNAL_NOTE_RE = /\s*;?\s*Threat baseline last reviewed[^;]*?review recommended\.?/gi;
const NO_ACTIVE_DISRUPTIONS_DESCRIPTION = 'No active disruptions';

// Returns null, never a placeholder sentence. "No additional status note was
// supplied." used to be frozen here and rendered as a real <p> in <main> — an
// absence described in prose reads to a crawler as published content, and it
// was the only body text 7 of 13 chokepoint pages carried (#7530). An absent
// note has no page representation: the paragraph is emitted `hidden`.
function publishableDescription(value) {
  const cleaned = String(value || '')
    .replace(INTERNAL_NOTE_RE, '')
    .replace(/^[\s;·—-]+|[\s;·—-]+$/g, '')
    .trim();
  return cleaned && cleaned !== NO_ACTIVE_DISRUPTIONS_DESCRIPTION ? cleaned : null;
}

// Every capture gate below reports a bare count. That number says a refresh
// failed but never why, so a red scheduled run (or a hand-run freeze) starts
// from zero — the per-item errors are collected and then dropped on the throw
// path. Carry the first one into the message.
function firstCaptureCause(errors) {
  const first = errors[0];
  if (!first) return '';
  const scope = first.id ?? first.code ?? first.slug ?? 'unknown';
  return `; first error (${scope}): ${first.message}`;
}

const RESILIENCE_SNAPSHOT_RE = /^resilience-ranking-(\d{4}-\d{2}-\d{2})\.json$/;
const SNAPSHOT_DIR = path.join(REPO_ROOT, 'docs', 'snapshots');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeApiBase(apiBase) {
  return String(apiBase || API_BASE).replace(/\/$/, '');
}

// Parse before accepting an external URL. Besides enforcing HTTPS, URL's
// serialization gives digest and enrichment responses one canonical form
// (host casing and default ports included) for provenance comparisons.
function normalizeHttpsUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

async function fetchJson(url, { headers = {}, method = 'GET', body, apiBase = API_BASE } = {}) {
  const origin = normalizeApiBase(apiBase);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        Origin: origin,
        Referer: `${origin}/`,
        ...headers,
      },
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text.slice(0, 400) };
    }
    if (!response.ok) {
      const err = new Error(`HTTP ${response.status} for ${url}`);
      err.status = response.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function mintSession(apiBase = API_BASE) {
  const base = normalizeApiBase(apiBase);
  const payload = await fetchJson(`${base}/api/wm-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    apiBase: base,
  });
  const token = String(payload?.token || '').trim();
  if (!token) throw new Error('wm-session response did not include a token');
  return token;
}

async function authedGet(pathname, token, apiBase = API_BASE, { serviceKey = '' } = {}) {
  const base = normalizeApiBase(apiBase);
  // Service-key callers pass the tier-gated routes (intel brief, timeline)
  // that reject the anonymous session with a 401. Same either/or contract as
  // freeze-resilience-ranking.mjs: key when configured, session cookie
  // otherwise — never both, so a keyed freeze cannot mint session state.
  const headers = serviceKey
    ? { 'X-WorldMonitor-Key': serviceKey }
    : { Cookie: `wm-session=${token}` };
  return fetchJson(`${base}${pathname}`, { headers, apiBase: base });
}

async function resolveLatestResilienceSnapshot() {
  const entries = await fs.readdir(SNAPSHOT_DIR);
  const candidates = entries
    .map((filename) => ({ filename, match: filename.match(RESILIENCE_SNAPSHOT_RE) }))
    .filter(({ match }) => match)
    .sort((a, b) => b.match[1].localeCompare(a.match[1]));
  if (candidates.length === 0) {
    throw new Error('No resilience ranking snapshot found');
  }
  const relativePath = path.join('docs', 'snapshots', candidates[0].filename);
  const snapshot = JSON.parse(await fs.readFile(path.join(REPO_ROOT, relativePath), 'utf8'));
  const codes = [
    ...(Array.isArray(snapshot.items) ? snapshot.items : []),
    ...(Array.isArray(snapshot.greyedOut) ? snapshot.greyedOut : []),
  ]
    .map((row) => String(row?.code || row?.countryCode || '').toUpperCase())
    .filter((code) => /^[A-Z]{2}$/.test(code));
  return { relativePath, codes: [...new Set(codes)].sort() };
}

async function loadCrises() {
  const raw = JSON.parse(
    await fs.readFile(path.join(REPO_ROOT, 'shared', 'crawlable-crises.json'), 'utf8'),
  );
  return raw.map((crisis) => ({
    slug: crisis.slug,
    coverage: crisis.coverage.map((country) => ({
      code: String(country.code).toUpperCase(),
      name: country.name,
    })),
  }));
}

async function loadChokepointIds() {
  const module = await import(pathToFileURL(
    path.join(REPO_ROOT, 'src', 'config', 'chokepoint-registry.ts'),
  ).href);
  return (module.CHOKEPOINT_REGISTRY || []).map((entry) => entry.id);
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function countryRecord(view, payload, freezeStartedAt) {
  return {
    partial: view.partial === true,
    score: view.partial ? null : view.score,
    band: view.partial ? null : view.band,
    trend: view.partial ? null : view.trend,
    advisory: view.advisory,
    sanctions: view.sanctions,
    // `computedAt === null` means the upstream supplied nothing datable. The
    // browser path deliberately renders no <time datetime> in that case; the
    // freeze must not invent one either, or every such page publishes a
    // machine-readable retrieval claim sourced from the harvest clock. The
    // harvest instant is kept separately for operator forensics.
    asOf: view.computedAt === null ? null : new Date(view.computedAt).toISOString(),
    retrievedAt: new Date(freezeStartedAt).toISOString(),
    methodologyVersion: view.methodologyVersion || '',
    geoConvergence: Number.isFinite(payload?.cii?.components?.geoConvergence)
      ? payload.cii.components.geoConvergence
      : null,
  };
}

function chokepointRecord(view) {
  return {
    disruptionScore: view.disruptionScore,
    status: view.status,
    congestion: view.congestion,
    navigationalWarnings: view.navigationalWarnings,
    navigationalWarningsAvailable: view.navigationalWarnings !== null,
    aisDisruptions: view.aisDisruptions,
    aisSnapshotAvailable: view.aisDisruptions !== null,
    description: publishableDescription(view.description),
    todayTransits: view.todayTransits,
    todayCountsAvailable: view.todayCountsAvailable,
    weekMovement: view.weekMovement,
    partial: view.partial === true,
    asOf: new Date(view.fetchedAt).toISOString(),
  };
}

function crisisRecord(view) {
  return {
    state: view.state,
    eventsTotal: view.eventsTotal,
    fatalities: view.fatalities,
    politicalViolenceEvents: view.politicalViolenceEvents,
    referencePeriod: view.referencePeriod,
    asOf: view.updatedAt === null ? null : new Date(view.updatedAt).toISOString(),
    missingCountries: view.missingCountries,
    rows: view.rows.map((row) => ({
      code: row.code,
      name: row.name,
      events: row.events,
      fatalities: row.fatalities,
      political: row.political,
      demonstrations: row.demonstrations,
      referencePeriod: row.referencePeriod,
      updatedAt: new Date(row.updatedAt).toISOString(),
    })),
  };
}

// Normalize one get-country-intel-brief response into the frozen shape, or
// return null when the response carries no publishable brief. An LLM outage
// surfaces as an empty brief (the handler returns `empty` on failure), which
// must degrade into developmentsErrors — freezing an empty string would let
// the corpus render a "Recent developments" section with no developments.
function briefRecord(payload, digestUrls) {
  const text = String(payload?.brief || '').trim();
  if (!text) return null;
  const generatedMs = Number(payload?.generatedAt);
  if (!Number.isFinite(generatedMs) || generatedMs <= 0) {
    throw new Error('brief response carried no valid generatedAt');
  }
  const sources = Array.isArray(payload?.sources) ? payload.sources : [];
  if (sources.length === 0) {
    throw new Error('brief response carried no sources from the frozen digest generation');
  }
  const normalizedSources = sources.map((source) => {
    const title = String(source?.title || '').trim();
    const outlet = String(source?.source || '').trim();
    const url = normalizeHttpsUrl(source?.url);
    const publishedMs = new Date(String(source?.publishedAt || '')).getTime();
    if (!title || !outlet || !url || !Number.isFinite(publishedMs)) {
      throw new Error('brief response carried an invalid source');
    }
    if (!digestUrls.has(url)) {
      throw new Error(`brief source was not in the frozen digest generation: ${url}`);
    }
    return {
      title,
      source: outlet,
      url,
      publishedAt: new Date(publishedMs).toISOString(),
    };
  });
  const citations = [...text.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
  if (citations.length === 0) {
    throw new Error('brief response carried no source citation');
  }
  if (citations.some((citation) => citation < 1 || citation > normalizedSources.length)) {
    throw new Error('brief response carried an out-of-range source citation');
  }
  return {
    text,
    model: String(payload?.model || ''),
    generatedAt: new Date(generatedMs).toISOString(),
    // Preserve the returned order exactly: [n] citations index this array.
    // Any invalid or unfrozen entry rejects the whole brief above rather than
    // being removed and silently shifting later citation indexes.
    sources: normalizedSources,
  };
}

// Normalize one get-intel-timeline record. Attribution is mandatory: an
// otherwise publishable event without a safe source URL is not crawlable
// evidence and must not enter the frozen timeline.
function timelineRecord(record) {
  const title = String(record?.title || '').trim();
  const occurredMs = Number(record?.occurredAt);
  const sourceUrl = normalizeHttpsUrl(record?.sourceUrl);
  if (!title || !Number.isFinite(occurredMs) || occurredMs <= 0 || !sourceUrl) return null;
  const summary = String(record?.summary || '').replace(/\s+/g, ' ').trim();
  return {
    title,
    summary: summary.length > 400 ? `${summary.slice(0, 399).trim()}...` : summary,
    sourceUrl,
    occurredAt: new Date(occurredMs).toISOString(),
    domain: String(record?.domain || ''),
  };
}

function emptyDevelopments(freezeStartedAt, briefSkipped) {
  return {
    headlines: [],
    brief: null,
    timeline: null,
    timelineStatus: 'not-requested',
    briefSkipped,
    capturedAt: new Date(freezeStartedAt).toISOString(),
  };
}

// Reduce a ListFeedDigest response to the publishable headline rows.
//
// A row reaches the homepage with a masthead beside it, so it must carry
// everything a reader needs to check that attribution: the outlet, an https
// article URL on the publisher's own host, and the publication time. #7608
// shipped four invented headlines under real Reuters/FT/AP/BBC bylines because
// the strip's fallback was hand-written prose with none of those. An item
// missing any of them is dropped here rather than published unverifiable.
//
// Ranking is importance-first like the browser path in
// pro-test/src/services/teasers.ts, but this selector is deliberately STRICTER:
// it also requires a masthead, a publication time and a non-aggregator link, so
// the frozen rows are a publishable subset of what a live fetch would show, not
// necessarily the identical four.
//
// Returns the accepted rows plus a rejection tally. A silent `.filter()` here
// would leave a shortfall with no recorded cause, since the request itself
// succeeded -- the operator would see a count and no reason.
export function selectFrozenHeadlines(payload, limit = HEADLINE_CAPTURE_COUNT) {
  const rejections = { noTitle: 0, noSource: 0, unverifiableUrl: 0, noPublishedAt: 0 };
  const categories = payload && typeof payload === 'object' ? payload.categories : null;
  if (!categories || typeof categories !== 'object') return { rows: [], rejections };
  const rows = Object.values(categories)
    .flatMap((bucket) => (Array.isArray(bucket?.items) ? bucket.items : []))
    .map((item) => {
      const title = String(item?.title || '').trim();
      const source = String(item?.source || '').trim();
      const url = String(item?.link || '').trim();
      const publishedAt = Number(item?.publishedAt);
      if (!title) { rejections.noTitle += 1; return null; }
      if (!source) { rejections.noSource += 1; return null; }
      if (!isVerifiableArticleUrl(url)) { rejections.unverifiableUrl += 1; return null; }
      if (!Number.isFinite(publishedAt) || publishedAt <= 0) { rejections.noPublishedAt += 1; return null; }
      return {
        row: { title, source, url, publishedAt: new Date(publishedAt).toISOString() },
        importanceScore: Number(item?.importanceScore) || 0,
        publishedAtMs: publishedAt,
      };
    })
    .filter((entry) => entry !== null)
    .sort((a, b) => (
      b.importanceScore - a.importanceScore
      || b.publishedAtMs - a.publishedAtMs
      || a.row.title.localeCompare(b.row.title)
    ))
    .slice(0, limit)
    .map((entry) => entry.row);
  return { rows, rejections };
}

// Country matching mirrors the server's shared grounding
// (server/worldmonitor/intelligence/v1/_country-brief-context.ts):
// display NAME matches case-insensitively on word boundaries, while the ISO
// code matches ONLY as an uppercase token in the raw text. Codes like IN, US
// or NO collide with ordinary English words — a case-insensitive code match
// swept "rally in Europe" into India's brief (post-#4898 review). This copy is
// deliberately local: the freeze is plain .mjs and must not import server TS.
function escapeMatchRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countryDisplayName(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return '';
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(normalized);
    if (!name || name.toUpperCase() === normalized || name.toLowerCase() === 'unknown region') return '';
    return name;
  } catch {
    return '';
  }
}

// These ISO codes are also common English words or abbreviations. A display
// name match remains valid, but a bare uppercase token is too ambiguous to
// establish country relevance. US stays eligible because it is a common and
// intentional digest token for the United States.
const AMBIGUOUS_ENGLISH_ISO_CODES = new Set([
  'AI', 'AM', 'AS', 'AT', 'BE', 'BY', 'DO', 'ID', 'IN', 'IS',
  'IT', 'LA', 'ME', 'MY', 'NO', 'SO', 'TO',
]);

function matchesCountryText(text, code, name) {
  if (name) {
    const term = name.trim().toLowerCase();
    if (term && new RegExp(`(^|[^a-z0-9])${escapeMatchRegExp(term)}(?=$|[^a-z0-9])`, 'i').test(text)) {
      return true;
    }
  }
  if (AMBIGUOUS_ENGLISH_ISO_CODES.has(code)) return false;
  // Raw text, NOT lowercased — the uppercase-token code match depends on the
  // original casing surviving to this point.
  return new RegExp(`(^|[^A-Za-z0-9])${escapeMatchRegExp(code)}(?=$|[^A-Za-z0-9])`).test(text);
}

// Per-country slice of ONE digest fetch (#7615). The global top headlines
// above and every country's developments below derive from the same payload —
// one capture path, shared with #7608, not two. Rows carry the same
// publishability bar (masthead, https URL, publication time); ranking mirrors
// the browser path so frozen rows match what live would show.
function selectCountryHeadlines(digestItems, code, limit = COUNTRY_HEADLINE_LIMIT) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized) || !Array.isArray(digestItems)) return [];
  const name = countryDisplayName(normalized);
  return digestItems
    .map((item) => {
      const title = String(item?.title || '').trim();
      const source = String(item?.source || '').trim();
      const url = normalizeHttpsUrl(item?.link);
      const publishedAt = Number(item?.publishedAt);
      if (!title || !source || !url) return null;
      if (!Number.isFinite(publishedAt) || publishedAt <= 0) return null;
      const text = `${title} ${typeof item?.snippet === 'string' ? item.snippet : ''}`;
      if (!matchesCountryText(text, normalized, name)) return null;
      return {
        row: { title, source, url, publishedAt: new Date(publishedAt).toISOString() },
        importanceScore: Number(item?.importanceScore) || 0,
        publishedAtMs: publishedAt,
      };
    })
    .filter((entry) => entry !== null)
    .sort((a, b) => (
      b.importanceScore - a.importanceScore
      || b.publishedAtMs - a.publishedAtMs
      || a.row.title.localeCompare(b.row.title)
    ))
    .slice(0, limit)
    .map((entry) => entry.row);
}

// Brief grounding block in the server's `Source [n]` format
// (_country-brief-context.ts briefSourceContextLines). The brief endpoint
// verifies citation indexes against entry sources, so the block and the
// frozen sources below must describe the same rows in the same order.
//
// Titles are whitespace-collapsed before composing EITHER section. Digest
// titles are untrusted RSS: a newline in a title forges an extra headline
// line the brief reads as a real story, and a crafted `Source [n]:` line
// parses into sources[] server-side (the #5857 gap the server closes with
// sanitizeForPromptLine). JSON.stringify already keeps the Source lines
// single-line; the Headlines: lines need the same treatment here.
function buildBriefContext(headlines, maxChars = BRIEF_CONTEXT_MAX_CHARS) {
  // cleanTitle applies ONLY to the Headlines: lines. The Source JSON keeps
  // the exact frozen title (JSON.stringify already neutralizes newlines, and
  // exact parity keeps citation indexes aligned with the frozen rows).
  const cleanTitle = (headline) => String(headline.title || '').replace(/\s+/g, ' ').trim();
  const lines = headlines.map((headline, index) => {
    const payload = { title: headline.title, source: headline.source, url: headline.url };
    if (headline.publishedAt) payload.publishedAt = headline.publishedAt;
    return `Source [${index + 1}]: ${JSON.stringify(payload)}`;
  });
  // Dash-prefixed: a hostile title shaped like `Source [9]: {...}` must never
  // parse as a source line server-side (parseCountryBriefSources scans
  // /^Source \[\d+\]:/mg over the whole context block).
  const headlineLines = headlines.map((headline) => `- ${cleanTitle(headline)}`);
  return [...lines, 'Headlines:', ...headlineLines].join('\n').slice(0, maxChars);
}

function signalConvergenceReference(capturedAt) {
  // Methodology-cited reference examples from docs/geographic-convergence.mdx.
  // These make the Geographic Convergence Score crawlable and attributable
  // without requiring Pro MCP access at freeze time.
  return {
    metricName: 'Geographic Convergence Score',
    methodologyPath: 'docs/geographic-convergence.mdx',
    scale: { min: 0, max: 100 },
    formula: {
      typeScore: 'event_types × 25',
      countBoost: 'min(25, total_events × 2)',
      convergenceScore: 'min(100, type_score + count_boost)',
    },
    defaultMinDomains: 3,
    thresholds: [
      { types: 4, scoreRange: '100', priority: 'Critical' },
      { types: 3, scoreRange: '90-100', priority: 'Critical' },
      { types: 3, scoreRange: '81-89', priority: 'High' },
    ],
    referenceExamples: [
      {
        label: 'Taiwan Strait Buildup',
        cell: '25°N, 121°E',
        types: ['military flights', 'naval vessels', 'protests'],
        typeCount: 3,
        totalEvents: 6,
        score: 87,
        priority: 'High',
        source: 'docs/geographic-convergence.mdx',
        kind: 'methodology-example',
      },
      {
        label: 'Middle East Flashpoint',
        cell: '32°N, 35°E',
        types: ['military flights', 'protests', 'earthquake'],
        typeCount: 3,
        totalEvents: 14,
        score: 100,
        priority: 'Critical',
        source: 'docs/geographic-convergence.mdx',
        kind: 'methodology-example',
      },
    ],
    capturedAt,
  };
}

export async function freezeCrawlableLivePulse({
  apiBase = API_BASE,
  rootDir = REPO_ROOT,
  // Injectable so the coverage gates can be exercised without a 20+ second
  // inter-request delay; production callers keep the throttled default.
  requestGapMs = REQUEST_GAP_MS,
  // Tier-gated captures (intel brief, timeline) authenticate with this key.
  // Default reads the operator environment (WORLDMONITOR_API_KEY secret in the
  // weekly cron); tests inject a stub value. Empty means headlines-only.
  serviceKey = serviceApiKey(),
} = {}) {
  const base = normalizeApiBase(apiBase);
  const freezeStartedAt = Date.now();
  const capturedAt = isoDate(freezeStartedAt);
  const keyed = serviceKey.trim().length > 0;
  const token = keyed ? '' : await mintSession(base);
  const authOpts = keyed ? { serviceKey } : {};
  const { relativePath: resilienceSnapshotPath, codes } = await resolveLatestResilienceSnapshot();
  const crises = await loadCrises();
  const chokepointIds = await loadChokepointIds();

  const countries = {};
  const countryErrors = [];
  for (const code of codes) {
    try {
      const payload = await authedGet(
        `/api/intelligence/v1/get-country-risk?country_code=${encodeURIComponent(code)}`,
        token,
        base,
        authOpts,
      );
      const view = liveRiskViewModel(payload, freezeStartedAt);
      countries[code] = countryRecord(view, payload, freezeStartedAt);
    } catch (error) {
      countryErrors.push({ code, message: error instanceof Error ? error.message : String(error) });
    }
    await sleep(requestGapMs);
  }

  // Every other network call in this run degrades per-item into *Errors. Left
  // unguarded, a single transient failure here would propagate out of the
  // function and discard the ~190 country records already fetched above.
  let chokepointPayload = null;
  const chokepointErrors = [];
  try {
    chokepointPayload = await authedGet('/api/supply-chain/v1/get-chokepoint-status', token, base, authOpts);
  } catch (error) {
    chokepointErrors.push({
      id: '*',
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const chokepoints = {};
  if (chokepointPayload !== null) {
    for (const id of chokepointIds) {
      try {
        const view = chokepointStatusViewModel(chokepointPayload, id, freezeStartedAt);
        chokepoints[id] = chokepointRecord(view);
      } catch (error) {
        chokepointErrors.push({ id, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  const crisisSnapshots = {};
  const crisisErrors = [];
  for (const crisis of crises) {
    try {
      const results = [];
      for (const country of crisis.coverage) {
        try {
          const payload = await authedGet(
            `/api/conflict/v1/get-humanitarian-summary?country_code=${encodeURIComponent(country.code)}`,
            token,
            base,
            authOpts,
          );
          results.push({ code: country.code, payload });
        } catch (error) {
          results.push({ code: country.code, error });
        }
        await sleep(requestGapMs);
      }
      const view = crisisTrackerViewModel(results, crisis.coverage, freezeStartedAt);
      crisisSnapshots[crisis.slug] = crisisRecord(view);
    } catch (error) {
      crisisErrors.push({
        slug: crisis.slug,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Guarded like every other network step, and unlike the others it never
  // throws: a digest outage costs the strip its headline rows, not the whole
  // snapshot (see HEADLINE_CAPTURE_COUNT).
  // The raw items are ALSO the per-country developments source below — one
  // digest fetch feeds the global strip (#7608) and every country page
  // (#7615), never two.
  const headlineErrors = [];
  let headlines = [];
  let digestItems = [];
  // ListFeedDigest self-reports how it is being served. Four well-formed rows
  // off a six-hour-old last-good replay look identical to a complete capture
  // unless that verdict is carried into the artifact, so record it.
  let headlineDigestState = null;
  let headlineServedStale = null;
  try {
    const digest = await authedGet('/api/news/v1/list-feed-digest?variant=full&lang=en', token, base, authOpts);
    headlineDigestState = digest?.coverage?.state ?? null;
    headlineServedStale = typeof digest?.coverage?.servedStale === 'boolean'
      ? digest.coverage.servedStale
      : null;
    const { rows, rejections } = selectFrozenHeadlines(digest, HEADLINE_CAPTURE_COUNT);
    headlines = rows;
    if (rows.length < HEADLINE_CAPTURE_COUNT) {
      headlineErrors.push({
        id: '*',
        message: `only ${rows.length} of ${HEADLINE_CAPTURE_COUNT} digest items were publishable `
          + `(rejected: ${Object.entries(rejections).map(([k, v]) => `${k}=${v}`).join(', ')}; `
          + `digest state=${headlineDigestState ?? 'unknown'})`,
      });
    }
    const categories = digest && typeof digest === 'object' ? digest.categories : null;
    if (categories && typeof categories === 'object') {
      digestItems = Object.values(categories)
        .flatMap((bucket) => (Array.isArray(bucket?.items) ? bucket.items : []));
    }
  } catch (error) {
    headlineErrors.push({
      id: '*',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  // Market tape (#7608). Three endpoints, captured individually so one bad
  // upstream costs the card its rows rather than the whole tape, and never
  // throwing for the same reason the headline capture does not: a market
  // outage must not discard the country work or arm the corpus staleness fuse.
  const quoteErrors = [];
  let quotes = [];
  let quotesAsOf = null;
  let quotesRateLimited = null;
  const quotePayloads = [];
  const quoteRequests = [
    ['market', `/api/market/v1/list-market-quotes?${MARKET_QUOTE_SYMBOLS.map((symbol) => `symbols=${encodeURIComponent(symbol)}`).join('&')}`],
    ['commodities', `/api/market/v1/list-commodity-quotes?${COMMODITY_QUOTE_SYMBOLS.map((symbol) => `symbols=${encodeURIComponent(symbol)}`).join('&')}`],
    ['crypto', `/api/market/v1/list-crypto-quotes?${CRYPTO_QUOTE_IDS.map((id) => `ids=${encodeURIComponent(id)}`).join('&')}`],
  ];
  for (const [id, pathname] of quoteRequests) {
    try {
      const payload = await authedGet(pathname, token, base, authOpts);
      quotePayloads.push(payload);
      if (id === 'market') {
        quotesAsOf = typeof payload?.asOf === 'string' ? payload.asOf : null;
        quotesRateLimited = typeof payload?.rateLimited === 'boolean' ? payload.rateLimited : null;
      }
    } catch (error) {
      quoteErrors.push({ id, message: error instanceof Error ? error.message : String(error) });
    }
    await sleep(requestGapMs);
  }
  quotes = selectFrozenQuotes(quotePayloads);
  if (quotes.length < QUOTE_SYMBOLS.length) {
    const missing = QUOTE_SYMBOLS.filter((symbol) => !quotes.some((quote) => quote.symbol === symbol));
    quoteErrors.push({
      id: '*',
      message: `captured ${quotes.length} of ${QUOTE_SYMBOLS.length} quotes; missing ${missing.join(', ')}`,
    });
  }

  // Per-country recent developments (#7615). Headlines match from the digest
  // fetched above; the brief and timeline ride the tier-gated routes, so they
  // run only with a service key. Briefs additionally require grounding: an
  // ungrounded brief is energy-data prose with no events, which is the defect
  // this enrichment removes rather than replicates.
  const developmentsErrors = [];
  const headlinesByCode = new Map();
  for (const code of Object.keys(countries)) {
    headlinesByCode.set(code, selectCountryHeadlines(digestItems, code, COUNTRY_HEADLINE_LIMIT));
  }
  // Provenance cross-check (#7615): a brief source renders headline-grade on
  // the page, so its URL must have been in the frozen digest generation. The
  // server re-grounds from its own live digest read at brief time; anything
  // outside this run's frozen generation (rotation, hallucination) rejects
  // the entire brief rather than being removed and shifting citation indexes.
  // Both sides use the same HTTPS-only URL serialization.
  const digestUrls = new Set();
  for (const item of digestItems) {
    const url = normalizeHttpsUrl(item?.link);
    if (url) digestUrls.add(url);
  }
  const timelineFrom = freezeStartedAt - COUNTRY_TIMELINE_WINDOW_MS;
  for (const code of Object.keys(countries)) {
    const countryHeadlines = headlinesByCode.get(code) || [];
    const briefSkipped = !keyed
      ? 'no-service-key'
      : countryHeadlines.length === 0 ? 'no-grounding' : null;
    const developments = {
      ...emptyDevelopments(freezeStartedAt, briefSkipped),
      headlines: countryHeadlines,
    };
    if (briefSkipped === null) {
      try {
        const context = buildBriefContext(countryHeadlines);
        const briefPayload = await authedGet(
          `/api/intelligence/v1/get-country-intel-brief?country_code=${encodeURIComponent(code)}&lang=en&context=${encodeURIComponent(context)}`,
          token,
          base,
          authOpts,
        );
        const brief = briefRecord(briefPayload, digestUrls);
        if (brief) {
          developments.brief = brief;
        } else {
          developmentsErrors.push({ code, stage: 'brief', message: 'response carried no publishable brief text' });
        }
      } catch (error) {
        developmentsErrors.push({ code, stage: 'brief', message: error instanceof Error ? error.message : String(error) });
      }
      await sleep(requestGapMs);
    }
    if (keyed) {
      try {
        const timelinePayload = await authedGet(
          `/api/intelligence/v1/get-intel-timeline?country=${encodeURIComponent(code)}&from=${timelineFrom}&limit=${COUNTRY_TIMELINE_LIMIT}`,
          token,
          base,
          authOpts,
        );
        if (timelinePayload?.upstreamUnavailable === true) {
          developments.timelineStatus = 'unavailable';
          developmentsErrors.push({ code, stage: 'timeline', message: 'timeline upstream unavailable' });
        } else {
          const records = Array.isArray(timelinePayload?.records) ? timelinePayload.records : [];
          const publishableRecords = records
            .map(timelineRecord)
            .filter((record) => record !== null);
          const droppedCount = records.length - publishableRecords.length;
          developments.timeline = publishableRecords;
          developments.timelineStatus = timelinePayload?.partial === true || droppedCount > 0
            ? 'partial'
            : 'available';
          if (droppedCount > 0) {
            developmentsErrors.push({
              code,
              stage: 'timeline',
              message: `dropped ${droppedCount} of ${records.length} timeline records without publishable attribution`,
            });
          }
        }
      } catch (error) {
        developments.timelineStatus = 'failed';
        developmentsErrors.push({ code, stage: 'timeline', message: error instanceof Error ? error.message : String(error) });
      }
      await sleep(requestGapMs);
    }
    countries[code].developments = developments;
  }

  const geoLeaders = Object.entries(countries)
    .filter(([, row]) => Number.isFinite(row.geoConvergence) && row.geoConvergence > 0)
    .sort((a, b) => b[1].geoConvergence - a[1].geoConvergence)
    .slice(0, 10)
    .map(([code, row]) => ({
      code,
      geoConvergence: row.geoConvergence,
      instabilityScore: row.score,
      asOf: row.asOf,
    }));

  const snapshot = {
    schemaVersion: 1,
    capturedAt,
    capturedAtMs: freezeStartedAt,
    apiBase: base,
    resilienceSnapshotPath,
    countries,
    chokepoints,
    crises: crisisSnapshots,
    headlines,
    quotes,
    quotesAsOf,
    signalConvergence: {
      ...signalConvergenceReference(capturedAt),
      ciiGeoConvergenceLeaders: geoLeaders,
    },
    coverage: {
      countryCount: Object.keys(countries).length,
      countryErrorCount: countryErrors.length,
      chokepointCount: Object.keys(chokepoints).length,
      chokepointErrorCount: chokepointErrors.length,
      crisisCount: Object.keys(crisisSnapshots).length,
      crisisErrorCount: crisisErrors.length,
      headlineCount: headlines.length,
      headlineErrorCount: headlineErrors.length,
      headlineDigestState,
      headlineServedStale,
      quoteCount: quotes.length,
      quoteErrorCount: quoteErrors.length,
      quotesRateLimited,
      headlineCountryCount: Object.values(countries)
        .filter((row) => (row.developments?.headlines?.length || 0) > 0).length,
      briefCountryCount: Object.values(countries)
        .filter((row) => row.developments?.brief != null).length,
      briefMatchedCount: Object.values(countries)
        .filter((row) => row.developments?.briefSkipped !== 'no-grounding'
          && (row.developments?.headlines?.length || 0) > 0).length,
      timelineCountryCount: Object.values(countries)
        .filter((row) => (row.developments?.timeline?.length || 0) > 0).length,
      serviceKeyPresent: keyed,
      developmentsErrorCount: developmentsErrors.length,
    },
    errors: {
      countries: countryErrors,
      chokepoints: chokepointErrors,
      crises: crisisErrors,
      headlines: headlineErrors,
      quotes: quoteErrors,
      developments: developmentsErrors,
    },
  };

  // Gate against the universe the corpus actually renders, not a magic number.
  // The corpus builds one page per code/id, so a capture that clears a fixed
  // floor while missing dozens of entries would silently return those pages to
  // the pre-pulse placeholder state with a green build.
  const minCountries = Math.max(1, codes.length - MAX_COUNTRY_CAPTURE_SHORTFALL);
  if (Object.keys(countries).length < minCountries) {
    throw new Error(
      `Pulse freeze captured only ${Object.keys(countries).length} of ${codes.length} countries; `
      + `expected at least ${minCountries}`
      + firstCaptureCause(countryErrors),
    );
  }
  if (Object.keys(chokepoints).length < chokepointIds.length) {
    throw new Error(
      `Pulse freeze captured only ${Object.keys(chokepoints).length} of ${chokepointIds.length} chokepoints`
      + firstCaptureCause(chokepointErrors),
    );
  }
  if (Object.keys(crisisSnapshots).length < crises.length) {
    throw new Error(
      `Pulse freeze captured only ${Object.keys(crisisSnapshots).length} of ${crises.length} crises`
      + firstCaptureCause(crisisErrors),
    );
  }

  // Brief gate (#7615, retuned in the #7620 follow-up): with a service key,
  // every headline-matched country is owed a brief attempt. Zero briefs means
  // the key is wrong-tiered, the route moved, or the model is down, and
  // shipping that silently would revert every enriched page to headlines-only.
  //
  // The tolerance is PROPORTIONAL, not the absolute MAX_COUNTRY_CAPTURE_SHORTFALL
  // this originally borrowed. That constant is calibrated against ~196 countries
  // (a 2.5% allowance); applied to a headline-matched set that varies run to run
  // — 51 on 2026-09-04 — it became a 90% demand on a stochastic upstream, where
  // each brief must pass grounding and citation checks. A run capturing 41 of 51
  // threw and wrote no snapshot at all, taking the country, chokepoint and
  // crisis captures down with it.
  // Without a key there is nothing to gate: briefSkipped=no-service-key is
  // the documented degraded state, not a failure.
  if (keyed && snapshot.coverage.briefMatchedCount > 0) {
    if (snapshot.coverage.briefCountryCount === 0) {
      throw new Error(
        `Pulse freeze captured briefs for 0 of ${snapshot.coverage.briefMatchedCount} headline-matched countries`
        + firstCaptureCause(developmentsErrors),
      );
    }
    const minBriefs = minimumBriefCaptures(snapshot.coverage.briefMatchedCount);
    if (snapshot.coverage.briefCountryCount < minBriefs) {
      throw new Error(
        `Pulse freeze captured briefs for only ${snapshot.coverage.briefCountryCount} of ${snapshot.coverage.briefMatchedCount} headline-matched countries; `
        + `expected at least ${minBriefs}`
        + firstCaptureCause(developmentsErrors),
      );
    }
  }

  const basename = OUTPUT_BASENAME || `crawlable-live-pulse-${capturedAt}.json`;
  const outPath = path.join(rootDir, 'docs', 'snapshots', basename);
  await fs.writeFile(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return { outPath, snapshot };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  freezeCrawlableLivePulse()
    .then(({ outPath, snapshot }) => {
      console.log(`[freeze-crawlable-live-pulse] wrote ${outPath}`);
      console.log(
        `[freeze-crawlable-live-pulse] countries=${snapshot.coverage.countryCount} `
        + `chokepoints=${snapshot.coverage.chokepointCount} `
        + `crises=${snapshot.coverage.crisisCount} `
        + `headlines=${snapshot.coverage.headlineCount} `
        + `quotes=${snapshot.coverage.quoteCount} `
        + `headlineCountries=${snapshot.coverage.headlineCountryCount} `
        + `briefCountries=${snapshot.coverage.briefCountryCount} `
        + `timelineCountries=${snapshot.coverage.timelineCountryCount} `
        + `keyed=${snapshot.coverage.serviceKeyPresent}`,
      );
      if (snapshot.coverage.headlineCount < HEADLINE_CAPTURE_COUNT) {
        console.warn(
          `[freeze-crawlable-live-pulse] WARNING: only ${snapshot.coverage.headlineCount} publishable `
          + 'headline(s) captured; the welcome strip will show that many rows. '
          + `Cause: ${snapshot.errors.headlines[0]?.message || 'unrecorded'}`,
        );
      }
      if (snapshot.coverage.quoteCount < QUOTE_SYMBOLS.length) {
        console.warn(
          `[freeze-crawlable-live-pulse] WARNING: only ${snapshot.coverage.quoteCount} of `
          + `${QUOTE_SYMBOLS.length} market quotes captured; the tape will show that many rows. `
          + `Cause: ${snapshot.errors.quotes[0]?.message || 'unrecorded'}`,
        );
      }
      if (snapshot.coverage.quotesRateLimited) {
        console.warn(
          '[freeze-crawlable-live-pulse] WARNING: market upstream reported rateLimited; '
          + 'frozen prices may be older than this run.',
        );
      }
      if (snapshot.coverage.headlineServedStale) {
        console.warn(
          '[freeze-crawlable-live-pulse] WARNING: news digest served stale content '
          + `(state=${snapshot.coverage.headlineDigestState}); frozen headlines are older than this run.`,
        );
      }
      if (
        snapshot.coverage.countryErrorCount
        || snapshot.coverage.chokepointErrorCount
        || snapshot.coverage.crisisErrorCount
        || snapshot.coverage.headlineErrorCount
        || snapshot.coverage.quoteErrorCount
        || snapshot.coverage.developmentsErrorCount
      ) {
        console.warn('[freeze-crawlable-live-pulse] partial errors recorded in snapshot.errors');
      }
      // Loud by design: a keyless cron (missing/expired WORLDMONITOR_API_KEY)
      // is green but headlines-only — indistinguishable from healthy without
      // this line. The weekly workflow declares the secret; if this warning
      // appears there, the enrichment is silently off.
      if (!snapshot.coverage.serviceKeyPresent) {
        console.warn(
          '[freeze-crawlable-live-pulse] no service key configured: tier-gated brief/timeline captures skipped '
          + '(briefSkipped=no-service-key). Set WORLDMONITOR_API_KEY for full enrichment.',
        );
      }
      console.log('[freeze-crawlable-live-pulse] next: npm run teasers:welcome (regenerates the welcome strip)');
    })
    .catch((error) => {
      console.error('[freeze-crawlable-live-pulse] failed:', error);
      process.exitCode = 1;
    });
}

export {
  normalizeApiBase,
  mintSession,
  authedGet,
  selectCountryHeadlines,
  buildBriefContext,
  countryDisplayName,
  normalizeHttpsUrl,
  timelineRecord,
};
