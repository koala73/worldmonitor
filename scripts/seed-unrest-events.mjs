#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, httpsProxyFetchRaw, resolveProxyForConnect, describeErr, writeExtraKeyWithMeta, sleep } from './_seed-utils.mjs';
import { getAcledToken } from './shared/acled-oauth.mjs';

loadEnvFile(import.meta.url);

const GDELT_GKG_URL = 'https://api.gdeltproject.org/api/v1/gkg_geojson';
const ACLED_API_URL = 'https://acleddata.com/api/acled/read';
const CANONICAL_KEY = 'unrest:events:v1';
const UNREST_RESOLUTION_CACHE_KEY = 'unrest:events-resolution:v1';
const CACHE_TTL = 16200; // 4.5h — 6x the 45 min cron interval (was 1.3x)
const ACLED_DISPLAY_LOOKBACK_DAYS = 30;
const ACLED_DISPLAY_LIMIT = 500;
const UNREST_RESOLUTION_LOOKBACK_DAYS = 60;
const UNREST_RESOLUTION_PAGE_LIMIT = 5000;
const UNREST_RESOLUTION_MAX_PAGES = 20;
const ACLED_PAGE_DELAY_MS = 250;
const MAX_SOURCE_URLS = 5;
const GDELT_THEME_MIN_DELAY_MS = 5_500;
const GDELT_THEME_JITTER_MS = 1_000;

// ---------- ACLED Event Type Mapping (from _shared.ts) ----------

function mapAcledEventType(eventType, subEventType) {
  const lower = (eventType + ' ' + subEventType).toLowerCase();
  if (lower.includes('riot') || lower.includes('mob violence')) return 'UNREST_EVENT_TYPE_RIOT';
  if (lower.includes('strike')) return 'UNREST_EVENT_TYPE_STRIKE';
  if (lower.includes('demonstration')) return 'UNREST_EVENT_TYPE_DEMONSTRATION';
  if (lower.includes('protest')) return 'UNREST_EVENT_TYPE_PROTEST';
  return 'UNREST_EVENT_TYPE_CIVIL_UNREST';
}

// ---------- Severity Classification (from _shared.ts) ----------

function classifySeverity(fatalities, eventType) {
  if (fatalities > 0 || eventType.toLowerCase().includes('riot')) return 'SEVERITY_LEVEL_HIGH';
  if (eventType.toLowerCase().includes('protest')) return 'SEVERITY_LEVEL_MEDIUM';
  return 'SEVERITY_LEVEL_LOW';
}

function classifyGdeltSeverity(count, name) {
  const lowerName = name.toLowerCase();
  if (count > 100 || lowerName.includes('riot') || lowerName.includes('clash')) return 'SEVERITY_LEVEL_HIGH';
  if (count < 25) return 'SEVERITY_LEVEL_LOW';
  return 'SEVERITY_LEVEL_MEDIUM';
}

function classifyGdeltEventType(name) {
  const lowerName = name.toLowerCase();
  if (lowerName.includes('riot')) return 'UNREST_EVENT_TYPE_RIOT';
  if (lowerName.includes('strike')) return 'UNREST_EVENT_TYPE_STRIKE';
  if (lowerName.includes('demonstration')) return 'UNREST_EVENT_TYPE_DEMONSTRATION';
  return 'UNREST_EVENT_TYPE_PROTEST';
}

function normalizeSourceUrl(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    if (parsed.username || parsed.password) return '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function uniqueSourceUrls(values) {
  return [...new Set(values.map(normalizeSourceUrl).filter(Boolean))];
}

function extractAcledSourceUrls(event) {
  return mergeSourceUrls([
    event.source_url,
    event.sourceUrl,
    event.url,
    event.link,
  ]);
}

function extractGdeltSourceUrls(properties = {}) {
  return mergeSourceUrls([
    properties.url,
    properties.source_url,
    properties.sourceUrl,
    properties.document_url,
    properties.documentUrl,
    properties.article_url,
    properties.articleUrl,
  ]);
}

function mergeSourceUrls(...groups) {
  return uniqueSourceUrls(groups.flatMap((group) => Array.isArray(group) ? group : [])).slice(0, MAX_SOURCE_URLS);
}

// ---------- Deduplication (from _shared.ts) ----------

function deduplicateEvents(events) {
  const unique = new Map();
  for (const event of events) {
    const lat = event.location?.latitude ?? 0;
    const lon = event.location?.longitude ?? 0;
    const latKey = Math.round(lat * 10) / 10;
    const lonKey = Math.round(lon * 10) / 10;
    const dateKey = new Date(event.occurredAt).toISOString().split('T')[0];
    const key = `${latKey}:${lonKey}:${dateKey}`;

    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, event);
    } else if (event.sourceType === 'UNREST_SOURCE_TYPE_ACLED' && existing.sourceType !== 'UNREST_SOURCE_TYPE_ACLED') {
      event.sources = [...new Set([...event.sources, ...existing.sources])];
      event.sourceUrls = mergeSourceUrls(event.sourceUrls, existing.sourceUrls);
      unique.set(key, event);
    } else if (existing.sourceType === 'UNREST_SOURCE_TYPE_ACLED') {
      existing.sources = [...new Set([...existing.sources, ...event.sources])];
      existing.sourceUrls = mergeSourceUrls(existing.sourceUrls, event.sourceUrls);
    } else {
      existing.sources = [...new Set([...existing.sources, ...event.sources])];
      existing.sourceUrls = mergeSourceUrls(existing.sourceUrls, event.sourceUrls);
      if (existing.sources.length >= 2) existing.confidence = 'CONFIDENCE_LEVEL_HIGH';
    }
  }
  return Array.from(unique.values());
}

// ---------- Sort (from _shared.ts) ----------

function sortBySeverityAndRecency(events) {
  const severityOrder = {
    SEVERITY_LEVEL_HIGH: 0,
    SEVERITY_LEVEL_MEDIUM: 1,
    SEVERITY_LEVEL_LOW: 2,
    SEVERITY_LEVEL_UNSPECIFIED: 3,
  };
  return events.sort((a, b) => {
    const sevDiff = (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3);
    if (sevDiff !== 0) return sevDiff;
    return b.occurredAt - a.occurredAt;
  });
}

// ---------- ACLED Fetch ----------

let acledTokenPromise;
function getAcledTokenOnce() {
  if (!acledTokenPromise) acledTokenPromise = getAcledToken({ userAgent: CHROME_UA });
  return acledTokenPromise;
}

function acledDateRange(now, lookbackDays) {
  return {
    startDate: new Date(now - lookbackDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    endDate: new Date(now).toISOString().split('T')[0],
  };
}

function buildAcledProtestParams({ startDate, endDate, limit, page }) {
  const params = new URLSearchParams({
    event_type: 'Protests',
    event_date: `${startDate}|${endDate}`,
    event_date_where: 'BETWEEN',
    limit: String(limit),
    _format: 'json',
  });
  if (page) params.set('page', String(page));
  return params;
}

async function fetchAcledProtestPage(token, params) {
  const resp = await fetch(`${ACLED_API_URL}?${params}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': CHROME_UA,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) throw new Error(`ACLED API error: ${resp.status}`);
  const data = await resp.json();
  if (data.message || data.error) throw new Error(data.message || data.error || 'ACLED API error');
  return Array.isArray(data.data) ? data.data : [];
}

function normalizeAcledProtestEvents(rawEvents) {
  return rawEvents
    .filter((e) => {
      const lat = parseFloat(e.latitude || '');
      const lon = parseFloat(e.longitude || '');
      return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
    })
    .map((e) => {
      const fatalities = parseInt(e.fatalities || '', 10) || 0;
      return {
        id: `acled-${e.event_id_cnty}`,
        title: e.notes?.slice(0, 200) || `${e.sub_event_type} in ${e.location}`,
        summary: typeof e.notes === 'string' ? e.notes.substring(0, 500) : '',
        eventType: mapAcledEventType(e.event_type || '', e.sub_event_type || ''),
        city: e.location || '',
        country: e.country || '',
        region: e.admin1 || '',
        location: {
          latitude: parseFloat(e.latitude || '0'),
          longitude: parseFloat(e.longitude || '0'),
        },
        occurredAt: new Date(e.event_date || '').getTime(),
        severity: classifySeverity(fatalities, e.event_type || ''),
        fatalities,
        sources: [e.source].filter(Boolean),
        sourceType: 'UNREST_SOURCE_TYPE_ACLED',
        tags: e.tags?.split(';').map((t) => t.trim()).filter(Boolean) ?? [],
        actors: [e.actor1, e.actor2].filter(Boolean),
        confidence: 'CONFIDENCE_LEVEL_HIGH',
        sourceUrls: extractAcledSourceUrls(e),
      };
    });
}

async function fetchAcledProtests({
  lookbackDays = ACLED_DISPLAY_LOOKBACK_DAYS,
  limit = ACLED_DISPLAY_LIMIT,
  paginated = false,
  maxPages = 1,
  label = 'ACLED',
} = {}) {
  const token = await getAcledTokenOnce();
  if (!token) {
    console.log(`  ${label}: no credentials configured, skipping`);
    return { events: [], pagination: undefined };
  }

  const now = Date.now();
  const { startDate, endDate } = acledDateRange(now, lookbackDays);
  const rawEvents = [];
  const seen = new Set();
  let pagesFetched = 0;
  let lastPageCount = 0;
  const pageLimit = paginated ? Math.max(1, maxPages) : 1;

  for (let page = 1; page <= pageLimit; page += 1) {
    const params = buildAcledProtestParams({
      startDate,
      endDate,
      limit,
      page: paginated ? page : undefined,
    });
    const pageEvents = await fetchAcledProtestPage(token, params);
    pagesFetched = page;
    lastPageCount = pageEvents.length;
    const before = rawEvents.length;
    for (const event of pageEvents) {
      const id = event.event_id_cnty || `${event.event_date}:${event.country}:${event.latitude}:${event.longitude}:${event.notes || event.source || ''}`;
      if (seen.has(id)) continue;
      seen.add(id);
      rawEvents.push(event);
    }
    if (!paginated || pageEvents.length < limit || rawEvents.length === before) break;
    await sleep(ACLED_PAGE_DELAY_MS);
  }

  const events = normalizeAcledProtestEvents(rawEvents);
  const pagination = paginated
    ? { lookbackDays, limit, pagesFetched, maxPages, truncated: pagesFetched >= maxPages && lastPageCount >= limit }
    : undefined;
  console.log(`  ${label}: ${events.length} raw events (${startDate} to ${endDate}${paginated ? `, ${pagesFetched} page(s)` : ''})`);
  return { events, pagination };
}

// ---------- GDELT Fetch ----------

// Direct fetch from Railway has 0% success — every attempt errors with
// UND_ERR_CONNECT_TIMEOUT or ECONNRESET. Path is always proxy-only here.
// Decodo→Cloudflare→GDELT occasionally returns 522 or RSTs the TLS handshake
// (~80% per single attempt in production); retry-with-jitter recovers most of
// it without touching the cron interval.
//
// Test seams:
//   _proxyFetcher  — replaces httpsProxyFetchRaw (default production wiring).
//   _sleep         — replaces the inter-attempt jitter delay.
//   _maxAttempts   — replaces the default 3 (lets tests bound iterations).
//   _jitter        — replaces Math.random()-based jitter (deterministic in tests).
export async function fetchGdeltViaProxy(url, proxyAuth, opts = {}) {
  const {
    _proxyFetcher = httpsProxyFetchRaw,
    _sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    _maxAttempts = 3,
    _jitter = () => 1500 + Math.random() * 1500,
  } = opts;
  let lastErr;
  for (let attempt = 1; attempt <= _maxAttempts; attempt++) {
    try {
      const { buffer } = await _proxyFetcher(url, proxyAuth, {
        accept: 'application/json',
        timeoutMs: 45_000,
      });
      return JSON.parse(buffer.toString('utf8'));
    } catch (err) {
      lastErr = err;
      // JSON.parse on a successfully fetched body is deterministic — retrying
      // can't recover. Bail immediately so we don't burn three attempts on
      // a malformed-but-cached upstream response.
      if (err instanceof SyntaxError) throw err;
      if (attempt < _maxAttempts) {
        console.warn(`  [GDELT] proxy attempt ${attempt}/${_maxAttempts} failed (${describeErr(err)}); retrying`);
        await _sleep(_jitter());
      }
    }
  }
  throw lastErr;
}

// v1 GKG GeoJSON accepts one theme tag per call.  Fan out + merge.
// http://data.gdeltproject.org/documentation/GKG-MASTER-THEMELIST.TXT
const UNREST_THEMES = ['PROTEST', 'STRIKE', 'VIOLENT_UNREST'];

export async function fetchGdeltEvents(opts = {}) {
  const { _resolveProxyForConnect = resolveProxyForConnect, ..._proxyOpts } = opts;
  const proxyAuth = _resolveProxyForConnect();
  if (!proxyAuth) {
    // Direct fetch hasn't worked from Railway since PR #3256; this seeder
    // hard-requires a CONNECT proxy. Surface the env var ops needs to set.
    throw new Error('GDELT requires CONNECT proxy: PROXY_URL env var is not set on this Railway service');
  }

  // One shared locationMap across all theme calls so a hotspot mentioned
  // under multiple themes sums counts + merges source URLs instead of
  // producing duplicate events.
  const locationMap = new Map();
  // GKG v1 emits one feature per (article, location) pair. Dedup on
  // (url, lat/lon bucket) so an article mentioning N places still contributes
  // N feature-counts, but the same (article × location) only counts once
  // across multiple theme calls.
  const seenUrlLocs = new Set();
  let anyThemeSucceeded = false;
  let lastError = null;
  let totalMentions = 0;

  // GDELT asks clients to stay at or below 1 request / 5s. Keep the
  // production fan-out default above that floor while tests can inject 0ms.
  const {
    _sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    _jitter = () => GDELT_THEME_MIN_DELAY_MS + Math.random() * GDELT_THEME_JITTER_MS
  } = _proxyOpts;
  for (let i = 0; i < UNREST_THEMES.length; i++) {
    if (i > 0) await _sleep(_jitter()); // Jitter between theme calls to reduce chance of back-to-back failures
    const theme = UNREST_THEMES[i];
    const params = new URLSearchParams({ QUERY: theme, MAXROWS: '2500' });
    const url = `${GDELT_GKG_URL}?${params}`;
    let data;
    try {
      data = await fetchGdeltViaProxy(url, proxyAuth, _proxyOpts);
    } catch (proxyErr) {
      lastError = proxyErr;
      continue;
    }
    anyThemeSucceeded = true;
    const features = data?.features || [];
    totalMentions += features.length;
    for (const feature of features) {
      const name = feature.properties?.name || '';
      if (!name) continue;
      const coords = feature.geometry?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const [lon, lat] = coords;
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
      const key = `${lat.toFixed(1)}:${lon.toFixed(1)}`;
      const sourceUrls = extractGdeltSourceUrls(feature.properties);
      const fUrl = sourceUrls[0] || null;
      const dedupKey = fUrl ? `${fUrl}|${key}` : null;
      if (dedupKey && seenUrlLocs.has(dedupKey)) continue;
      if (dedupKey) seenUrlLocs.add(dedupKey);
      const existing = locationMap.get(key);
      const tone = feature.properties?.urltone;
      if (existing) {
        existing.count++;
        if (typeof tone === 'number' && tone < existing.worstTone) {
          existing.worstTone = tone;
        }
        existing.sourceUrls = mergeSourceUrls(existing.sourceUrls, sourceUrls);
      } else {
        locationMap.set(key, {
          name,
          lat,
          lon,
          count: 1,
          worstTone: typeof tone === 'number' ? tone : 0,
          sourceUrls,
        });
      }
    }
  }

  if (!anyThemeSucceeded) {
    throw Object.assign(
      new Error(`GDELT proxy failed for all themes (last error: ${describeErr(lastError)})`),
      { cause: lastError },
    );
  }

  const events = [];
  for (const [, loc] of locationMap) {
    if (loc.count < 5) continue;

    const country = loc.name.split(',').pop()?.trim() || loc.name;
    events.push({
      id: `gdelt-${loc.lat.toFixed(2)}-${loc.lon.toFixed(2)}-${Date.now()}`,
      title: `${loc.name} (${loc.count} reports)`,
      summary: '',
      eventType: classifyGdeltEventType(loc.name),
      city: loc.name.split(',')[0]?.trim() || '',
      country,
      region: '',
      location: { latitude: loc.lat, longitude: loc.lon },
      occurredAt: Date.now(),
      severity: classifyGdeltSeverity(loc.count, loc.name),
      fatalities: 0,
      sources: ['GDELT'],
      sourceType: 'UNREST_SOURCE_TYPE_GDELT',
      tags: [],
      actors: [],
      confidence: loc.count > 20 ? 'CONFIDENCE_LEVEL_HIGH' : 'CONFIDENCE_LEVEL_MEDIUM',
      sourceUrls: loc.sourceUrls,
    });
  }

  console.log(`  GDELT: ${totalMentions} mentions → ${events.length} aggregated events`);
  return events;
}

// ---------- Main Fetch ----------

async function fetchUnrestEvents() {
  const results = await Promise.allSettled([
    fetchAcledProtests({ label: 'ACLED display' }),
    fetchAcledProtests({
      lookbackDays: UNREST_RESOLUTION_LOOKBACK_DAYS,
      limit: UNREST_RESOLUTION_PAGE_LIMIT,
      paginated: true,
      maxPages: UNREST_RESOLUTION_MAX_PAGES,
      label: 'ACLED resolution',
    }),
    fetchGdeltEvents(),
  ]);

  const acled = results[0].status === 'fulfilled' ? results[0].value : null;
  const acledResolution = results[1].status === 'fulfilled' ? results[1].value : null;
  const acledEvents = acled?.events ?? [];
  const gdeltEvents = results[2].status === 'fulfilled' ? results[2].value : [];

  if (results[0].status === 'rejected') console.log(`  ACLED failed: ${describeErr(results[0].reason)}`);
  if (results[1].status === 'rejected') console.log(`  ACLED resolution failed: ${describeErr(results[1].reason)}`);
  if (results[2].status === 'rejected') console.log(`  GDELT failed: ${describeErr(results[2].reason)}`);

  if (acledResolution?.events?.length) {
    const sortedResolutionEvents = sortBySeverityAndRecency([...acledResolution.events]);
    await writeExtraKeyWithMeta(
      UNREST_RESOLUTION_CACHE_KEY,
      { events: sortedResolutionEvents, clusters: [], pagination: acledResolution.pagination },
      CACHE_TTL,
      sortedResolutionEvents.length,
    );
  }

  const merged = deduplicateEvents([...acledEvents, ...gdeltEvents]);
  const sorted = sortBySeverityAndRecency(merged);

  console.log(`  Merged: ${acledEvents.length} ACLED + ${gdeltEvents.length} GDELT = ${sorted.length} deduplicated`);

  return { events: sorted, clusters: [], pagination: undefined };
}

function validate(data) {
  return Array.isArray(data?.events) && data.events.length > 0;
}

export function declareRecords(data) {
  return Array.isArray(data?.events) ? data.events.length : 0;
}

// Gate the runSeed entry-point so this module is importable from tests
// without triggering a real seed run. process.argv[1] is set when this file
// is invoked as a script (`node scripts/seed-unrest-events.mjs`); under
// `node --test`, argv[1] is the test runner, not this file.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runSeed('unrest', 'events', CANONICAL_KEY, fetchUnrestEvents, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: 'acled+gdelt',

    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 120,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
