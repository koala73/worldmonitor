#!/usr/bin/env node

import { loadEnvFile, loadSharedConfig, CHROME_UA, runSeed } from './_seed-utils.mjs';
import { decodeHtmlEntities } from './_html-entities.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'intelligence:advisories:v1';
const BOOTSTRAP_KEY = 'intelligence:advisories-bootstrap:v1';
const TTL = 10800; // 180min — 2h buffer over 1h cron cadence (was 120min = exactly 1h buffer)
// How many advisories per source are STORED in the news list. This is a
// payload bound, never a coverage bound: buildByCountryMap indexes the full
// fetch, so raising or lowering this cannot change which countries have a
// travel level.
const PER_SOURCE_DISPLAY_LIMIT = 15;
// Travel-advisory feeds are country registers, not sparse event feeds. The US
// and Australian registers each cover far more than 100 countries, so require
// that floor before replacing the last-good global level index. This still
// tolerates normal source differences while rejecting a partial-feed blackout.
export const MIN_ADVISORY_COUNTRY_COVERAGE = 100;
// Two MiB accepts the current ~1.1 MiB State Department register while still
// bounding an allowed upstream's processing and memory use before XML parsing.
export const MAX_ADVISORY_FEED_BYTES = 2 * 1024 * 1024;

const ALLOWED_DOMAINS = new Set(loadSharedConfig('rss-allowed-domains.json'));

const ADVISORY_FEEDS = [
  { name: 'US State Dept', sourceCountry: 'US', sourceCategory: 'travel-advisory', url: 'https://travel.state.gov/_res/rss/TAsTWs.xml', levelParser: 'us' },
  { name: 'Australia DFAT Smartraveller', sourceCountry: 'AU', sourceCategory: 'travel-advisory', url: 'https://www.smartraveller.gov.au/countries/documents/index.rss', levelParser: 'au' },
  { name: 'UK FCDO', sourceCountry: 'UK', sourceCategory: 'travel-advisory', url: 'https://www.gov.uk/foreign-travel-advice.atom' },
  { name: 'US Embassy Thailand', sourceCountry: 'US', sourceCategory: 'travel-advisory', url: 'https://th.usembassy.gov/category/alert/feed/', targetCountry: 'TH' },
  { name: 'US Embassy UAE', sourceCountry: 'US', sourceCategory: 'travel-advisory', url: 'https://ae.usembassy.gov/category/alert/feed/', targetCountry: 'AE' },
  { name: 'US Embassy Germany', sourceCountry: 'US', sourceCategory: 'travel-advisory', url: 'https://de.usembassy.gov/category/alert/feed/', targetCountry: 'DE' },
  { name: 'US Embassy Ukraine', sourceCountry: 'US', sourceCategory: 'travel-advisory', url: 'https://ua.usembassy.gov/category/alert/feed/', targetCountry: 'UA' },
  { name: 'US Embassy Mexico', sourceCountry: 'US', sourceCategory: 'travel-advisory', url: 'https://mx.usembassy.gov/category/alert/feed/', targetCountry: 'MX' },
  { name: 'US Embassy India', sourceCountry: 'US', sourceCategory: 'travel-advisory', url: 'https://in.usembassy.gov/category/alert/feed/', targetCountry: 'IN' },
  { name: 'US Embassy Pakistan', sourceCountry: 'US', sourceCategory: 'travel-advisory', url: 'https://pk.usembassy.gov/category/alert/feed/', targetCountry: 'PK' },
  { name: 'US Embassy Colombia', sourceCountry: 'US', sourceCategory: 'travel-advisory', url: 'https://co.usembassy.gov/category/alert/feed/', targetCountry: 'CO' },
  { name: 'US Embassy Poland', sourceCountry: 'US', sourceCategory: 'travel-advisory', url: 'https://pl.usembassy.gov/category/alert/feed/', targetCountry: 'PL' },
  { name: 'US Embassy Bangladesh', sourceCountry: 'US', sourceCategory: 'travel-advisory', url: 'https://bd.usembassy.gov/category/alert/feed/', targetCountry: 'BD' },
  { name: 'US Embassy Italy', sourceCountry: 'US', sourceCategory: 'travel-advisory', url: 'https://it.usembassy.gov/category/alert/feed/', targetCountry: 'IT' },
  { name: 'US Embassy Dominican Republic', sourceCountry: 'US', sourceCategory: 'travel-advisory', url: 'https://do.usembassy.gov/category/alert/feed/', targetCountry: 'DO' },
  { name: 'US Embassy Myanmar', sourceCountry: 'US', sourceCategory: 'travel-advisory', url: 'https://mm.usembassy.gov/category/alert/feed/', targetCountry: 'MM' },
  { name: 'CDC Travel Notices', sourceCountry: 'US', sourceCategory: 'health', url: 'https://wwwnc.cdc.gov/travel/rss/notices.xml' },
  { name: 'ECDC Epidemiological Updates', sourceCountry: 'EU', sourceCategory: 'health', url: 'https://www.ecdc.europa.eu/en/taxonomy/term/1310/feed' },
  { name: 'ECDC Threats Report', sourceCountry: 'EU', sourceCategory: 'health', url: 'https://www.ecdc.europa.eu/en/taxonomy/term/1505/feed' },
  { name: 'ECDC Risk Assessments', sourceCountry: 'EU', sourceCategory: 'health', url: 'https://www.ecdc.europa.eu/en/taxonomy/term/1295/feed' },
  { name: 'ECDC Avian Influenza', sourceCountry: 'EU', sourceCategory: 'health', url: 'https://www.ecdc.europa.eu/en/taxonomy/term/323/feed' },
  { name: 'ECDC Publications', sourceCountry: 'EU', sourceCategory: 'health', url: 'https://www.ecdc.europa.eu/en/taxonomy/term/1244/feed' },
  { name: 'WHO News', sourceCountry: 'INT', sourceCategory: 'health', url: 'https://www.who.int/rss-feeds/news-english.xml' },
  { name: 'WHO Africa Emergencies', sourceCountry: 'INT', sourceCategory: 'health', url: 'https://www.afro.who.int/rss/emergencies.xml' },
];

const RELAY_URL = process.env.RELAY_URL || 'https://proxy.worldmonitor.app';

export function parseUsLevel(title) {
  const m = title.match(/Level (\d)/i);
  if (!m) return 'info';
  return { '4': 'do-not-travel', '3': 'reconsider', '2': 'caution', '1': 'normal' }[m[1]] || 'info';
}

// Smartraveller publishes each destination's overall advice twice inside
// <ta:warnings>: as a label (<dc:description>) and as <ta:level>N/5</ta:level>.
// The five-point scale counts "No travel advice" as 1/5, so the four advice
// levels are 2/5..5/5 (checked against the live feed 2026-10-23: 2/5 "Exercise
// normal safety precautions" ... 5/5 "Do not travel"). The label is read first
// because it names the level outright. A bare number names no scale, so it
// falls through to the item text rather than being guessed.
const AU_ADVICE_LABELS = [
  ['do not travel', 'do-not-travel'],
  ['reconsider your need to travel', 'reconsider'],
  ['exercise a high degree of caution', 'caution'],
  ['exercise normal safety precautions', 'normal'],
];
const AU_FIVE_POINT_LEVELS = { '5': 'do-not-travel', '4': 'reconsider', '3': 'caution', '2': 'normal' };

export function parseAuLevel(item) {
  const label = String(item.advisoryLabel || '').trim().toLowerCase();
  for (const [text, level] of AU_ADVICE_LABELS) {
    if (label === text) return level;
  }
  const fivePoint = String(item.advisoryLevel || '').trim().match(/^([1-5])\/5$/);
  if (fivePoint) return AU_FIVE_POINT_LEVELS[fivePoint[1]] || 'info';

  const l = `${item.title || ''} ${item.description || ''}`.toLowerCase();
  if (l.includes('do not travel')) return 'do-not-travel';
  if (l.includes('reconsider')) return 'reconsider';
  if (l.includes('high degree of caution') || l.includes('high degree')) return 'caution';
  if (l.includes('normal safety precautions') || l.includes('normal precautions')) return 'normal';
  return 'info';
}

function parseLevel(item, parser) {
  if (parser === 'us') return parseUsLevel(item.title || '');
  if (parser === 'au') return parseAuLevel(item);
  return 'info';
}

const COUNTRY_NAMES = loadSharedConfig('country-names.json');
const SORTED_COUNTRY_ENTRIES = Object.entries(COUNTRY_NAMES).sort((a, b) => b[0].length - a[0].length);
// Reverse map: ISO2 → display name (title-cased from the config keys).
const BY_COUNTRY_NAME = Object.fromEntries(
  Object.entries(COUNTRY_NAMES).map(([name, code]) => [
    code,
    name.replace(/\b\w/g, (c) => c.toUpperCase()),
  ]),
);

function extractCountry(title, feed) {
  if (feed.targetCountry) return feed.targetCountry;
  if (feed.sourceCountry === 'EU' || feed.sourceCountry === 'INT') return undefined;
  // Apostrophes are deleted, not spaced: the country keys spell
  // "democratic peoples republic of korea", and a space left "republic of
  // korea" (KR) as the longest match for Smartraveller's North Korea title.
  const normalized = title.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase()
    .replace(/['\u2019]/g, '').replace(/[.(),/-]/g, ' ').replace(/\s+/g, ' ');
  for (const [name, code] of SORTED_COUNTRY_ENTRIES) {
    if (normalized.includes(name)) return code;
  }
  return undefined;
}

function isValidUrl(link) {
  if (!link) return false;
  try {
    const u = new URL(link);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

function stripHtml(html) {
  const stripped = html.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '');
  return decodeHtmlEntities(stripped).replace(/\s+/g, ' ').trim();
}

export function parseRssItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = stripHtml((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const link = stripHtml((block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || '');
    const description = stripHtml((block.match(/<description[^>]*>([\s\S]*?)<\/description>/i) || [])[1] || '');
    const pubDate = stripHtml((block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || [])[1] || '');
    const advisoryLevel = stripHtml((block.match(/<ta:level[^>]*>([\s\S]*?)<\/ta:level>/i) || [])[1] || '');
    const warnings = (block.match(/<ta:warnings[^>]*>([\s\S]*?)<\/ta:warnings>/i) || [])[1] || '';
    const advisoryLabel = stripHtml((warnings.match(/<dc:description>([\s\S]*?)<\/dc:description>/i) || [])[1] || '');
    items.push({ title, link, description, pubDate, advisoryLevel, advisoryLabel });
  }
  return items;
}

function parseAtomEntries(xml) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = stripHtml((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const linkMatch = block.match(/<link[^>]*href=["']([^"']+)["']/i);
    const link = linkMatch ? linkMatch[1] : '';
    const description = stripHtml((block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i) || [])[1] || '');
    const updated = stripHtml((block.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i) || [])[1] || '');
    const published = stripHtml((block.match(/<published[^>]*>([\s\S]*?)<\/published>/i) || [])[1] || '');
    entries.push({ title, link, description, pubDate: updated || published });
  }
  return entries;
}

function parseFeed(xml) {
  if (xml.includes('<entry>') || xml.includes('<entry ')) return parseAtomEntries(xml);
  return parseRssItems(xml);
}

function rssProxyUrl(feedUrl) {
  const domain = new URL(feedUrl).hostname;
  if (!ALLOWED_DOMAINS.has(domain)) {
    console.warn(`  Skipping disallowed domain: ${domain}`);
    return null;
  }
  return `${RELAY_URL}/rss?url=${encodeURIComponent(feedUrl)}`;
}

export async function readBoundedFeedText(response, maxBytes = MAX_ADVISORY_FEED_BYTES) {
  const advertisedLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
    try { await response.body?.cancel?.(); } catch { /* reject even if cancellation fails */ }
    throw new Error('RESPONSE_TOO_LARGE');
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('RESPONSE_TOO_LARGE');
    return text;
  }

  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

// `doFetch` is injectable so a test can drive this whole path — including the
// no-truncation guarantee below — without network access.
export async function fetchFeed(feed, doFetch = fetch) {
  const proxyUrl = rssProxyUrl(feed.url);
  if (!proxyUrl) return [];

  try {
    const resp = await doFetch(proxyUrl, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      console.warn(`  ${feed.name}: HTTP ${resp.status}`);
      return [];
    }
    const xml = await readBoundedFeedText(resp);
    // There is no item-count cut here: truncating before the country index is
    // built made the US State Dept register — one standing advisory per
    // country, ~219 items — contribute only its first 15 countries. The
    // bounded source read above protects processing resources; fetchAll bounds
    // what gets STORED instead.
    return mapFeedItems(parseFeed(xml), feed);
  } catch (e) {
    console.warn(`  ${feed.name}: ${e.message}`);
    return [];
  }
}

// Smartraveller stamps every item in Canberra time ("20 Oct 2026 23:00:00
// AEDT"), and Date does not know those zone names. Unparseable dates used to
// throw from toISOString() and drop the whole feed; they now fall back to the
// fetch time, the same as an item with no date.
const ZONE_OFFSETS = { AEST: '+1000', AEDT: '+1100' };

function toIsoDate(pubDate) {
  const normalized = String(pubDate || '').trim().replace(/\b(AEST|AEDT)$/, (zone) => ZONE_OFFSETS[zone]);
  const parsed = normalized ? new Date(normalized) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
}

/**
 * Normalise one feed's raw items into advisory records.
 *
 * Retains every item from a bounded source response: the country-level index
 * must see everything a register feed publishes, while fetchAll decides how
 * many records to store in the news list.
 */
export function mapFeedItems(items, feed) {
  return items
    .filter(item => item.title && isValidUrl(item.link))
    .map(item => ({
      title: item.title,
      link: item.link,
      pubDate: toIsoDate(item.pubDate),
      source: feed.name,
      sourceCountry: feed.sourceCountry,
      level: parseLevel(item, feed.levelParser),
      country: extractCountry(item.title, feed) || '',
    }));
}

/**
 * Bound the STORED advisory list to `limit` per source, preserving input order
 * (callers sort by recency first). This is the news list's bound only — the
 * country-level index is built from the full set, because one cap cannot serve
 * both a "latest N headlines" list and a complete per-country register.
 */
export function capPerSource(advisories, limit) {
  const kept = [];
  const counts = new Map();
  for (const a of advisories) {
    const n = counts.get(a.source) ?? 0;
    if (n >= limit) continue;
    counts.set(a.source, n + 1);
    kept.push(a);
  }
  return kept;
}

export function buildByCountryMap(advisories) {
  const map = {};
  for (const a of advisories) {
    if (!a.country || !a.level || a.level === 'info') continue;
    const existing = map[a.country];
    const rank = { 'do-not-travel': 4, reconsider: 3, caution: 2, normal: 1 };
    if (!existing || (rank[a.level] || 0) > (rank[existing] || 0)) {
      map[a.country] = a.level;
    }
  }
  return map;
}

// Pre-publish diagnostics carried on the fetched report. advisoryPublishTransform
// strips them from both stored keys; advisoryAfterPublish copies them onto
// seed-meta, where api/health.js reads sourceState and errorCode.
export const ADVISORY_SOURCE_HEALTH_FIELD = '_sourceHealth';

// A travel register (a feed with a levelParser) is missing when it contributed
// no levelled country: an HTTP failure, an empty body, and a format change that
// leaves every item at 'info' all look the same to byCountry. The seed still
// publishes while the other register clears MIN_ADVISORY_COUNTRY_COVERAGE, so
// this is what keeps a one-register index from reading as healthy.
function summarizeSourceHealth(feeds, itemsByFeed) {
  const missingRegisters = [];
  const emptyFeeds = [];
  feeds.forEach((feed, i) => {
    const items = itemsByFeed[i];
    if (items.length === 0) emptyFeeds.push(feed.name);
    if (feed.levelParser && !items.some((a) => a.country && a.level && a.level !== 'info')) {
      missingRegisters.push(feed.sourceCountry);
    }
  });
  return { missingRegisters: [...new Set(missingRegisters)].sort(), emptyFeeds };
}

export function advisoryPublishTransform(data) {
  const { [ADVISORY_SOURCE_HEALTH_FIELD]: _diagnostics, ...published } = data || {};
  return published;
}

export async function advisoryAfterPublish(data) {
  const { missingRegisters = [], emptyFeeds = [] } = data?.[ADVISORY_SOURCE_HEALTH_FIELD] || {};
  if (missingRegisters.length === 0) {
    // Explicit undefineds: a validation skip merges the previous seed-meta's
    // diagnostics under this patch, so a recovery must clear the old failure.
    return { freshnessMetaPatch: { sourceState: 'ok', errorCode: undefined, failedSources: undefined, emptyFeeds } };
  }
  return {
    freshnessMetaPatch: {
      sourceState: 'degraded',
      errorCode: `ADVISORY_REGISTER_MISSING_${missingRegisters.join('_')}`,
      failedSources: missingRegisters,
      emptyFeeds,
    },
  };
}

export async function fetchAll({ feeds = ADVISORY_FEEDS, doFetch = fetch } = {}) {
  const results = await Promise.allSettled(feeds.map((feed) => fetchFeed(feed, doFetch)));
  const all = [];
  const itemsByFeed = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    itemsByFeed.push(r.status === 'fulfilled' ? r.value : []);
    if (r.status === 'fulfilled') all.push(...r.value);
    else console.warn(`  Feed ${feeds[i]?.name || i} failed: ${r.reason?.message || r.reason}`);
  }
  const sourceHealth = summarizeSourceHealth(feeds, itemsByFeed);
  if (sourceHealth.missingRegisters.length > 0) {
    console.warn(`  Travel registers with no levelled country: ${sourceHealth.missingRegisters.join(', ')}`);
  }

  const seen = new Set();
  const deduped = all.filter(a => {
    const key = a.title.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  deduped.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());

  // Index from EVERYTHING fetched; store a bounded slice. The two have
  // different jobs: `byCountry` answers "what is the travel level for X" and
  // must be complete, while `advisories` is a recency-ordered news list whose
  // size is a payload concern.
  const byCountry = buildByCountryMap(deduped);
  const advisories = capPerSource(deduped, PER_SOURCE_DISPLAY_LIMIT);
  const report = {
    byCountry,
    byCountryName: BY_COUNTRY_NAME,
    advisories,
    fetchedAt: new Date().toISOString(),
    [ADVISORY_SOURCE_HEALTH_FIELD]: sourceHealth,
  };

  console.log(`  ${advisories.length} advisories stored (${deduped.length} fetched), ${Object.keys(byCountry).length} countries with levels`);

  return report;
}

// `advisories.length > 0` alone is not enough. The ~20 health and news feeds
// (WHO, CDC, ECDC, embassy bulletins) emit `level: 'info'`, which
// buildByCountryMap skips, so they satisfy that bound while contributing
// nothing to the level index. When the travel-advisory feeds failed and the
// news feeds did not, the seed published a report with an empty `byCountry` and
// production served `advisoryLevel: ""` for every country — the same symptom
// this file's header describes, recurring because the earlier fix addressed the
// truncation CAUSE and left the OUTCOME unguarded (#7530).
//
// `byCountry` is the reason this key exists: it is the sole source of
// GetCountryRiskResponse.advisoryLevel and of the CII scorer's advisory input.
// A report without one must fail the seed so the previous value lives out its
// TTL, rather than publishing an index that blanks every advisory tile.
export function validateAdvisoryReport(data) {
  if (!Array.isArray(data?.advisories) || data.advisories.length === 0) return false;
  const byCountry = data.byCountry;
  if (!byCountry || typeof byCountry !== 'object' || Array.isArray(byCountry)) return false;
  return Object.keys(byCountry).length >= MIN_ADVISORY_COUNTRY_COVERAGE;
}

export function declareRecords(data) {
  return Array.isArray(data?.advisories) ? data.advisories.length : 0;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ''));
if (isMain) {
  runSeed('intelligence', 'advisories', CANONICAL_KEY, fetchAll, {
    validateFn: validateAdvisoryReport,
    ttlSeconds: TTL,
    recordCount: (d) => d?.advisories?.length || 0,
    sourceVersion: 'rss-feeds',
    publishTransform: advisoryPublishTransform,
    afterPublish: advisoryAfterPublish,
    // A rejected report (no register cleared the coverage floor) skips the
    // publish; this replaces the previous run's sourceState instead of
    // carrying it forward onto the mirrored seed-meta.
    afterValidationSkip: advisoryAfterPublish,
    extraKeys: [{ key: BOOTSTRAP_KEY, transform: advisoryPublishTransform, ttl: TTL, declareRecords }],

    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 120,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
