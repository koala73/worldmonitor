#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
// Reuse the battle-tested schema-anchored parser from seed-vpd-tracker.mjs.
// The 2026-04 webpack rebuild changed the TGH bundle from the legacy
// `var a=[{Alert_ID:"..."}]` shape (unquoted keys) to `eval("var res = [...]")`
// blocks with JSON-quoted keys. This seeder's homegrown regex no longer
// matches the new shape — pre-fix it returned 0 records and silently
// dropped the only geo-rich disease source. Importing vpd-tracker is safe:
// its top-level runSeed is guarded by `if (process.argv[1]?.endsWith(...))`,
// so importing as a module just exposes the parsers.
import { parseRealtimeAlerts } from './seed-vpd-tracker.mjs';
// Pure helpers (parsers/mappers/contentMeta/publishTransform) live in their
// own module so tests can import the real code instead of replicating it.
// See `scripts/_disease-outbreaks-helpers.mjs` for the shape contract.
import {
  whoNormalizeItem,
  rssNormalizeItem,
  tghNormalizeItem,
  mapItem,
  diseaseContentMeta,
  diseasePublishTransform,
  DISEASE_MAX_CONTENT_AGE_MIN,
} from './_disease-outbreaks-helpers.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'health:disease-outbreaks:v1';
const CACHE_TTL = 259200; // 72h (3 days) — 3× daily cron interval per gold standard; survives 2 consecutive missed runs

// WHO Disease Outbreak News JSON API (RSS at /feeds/entity/csr/don/en/rss.xml is dead since 2024)
const WHO_DON_API = 'https://www.who.int/api/emergencies/diseaseoutbreaknews?sf_provider=dynamicProvider372&sf_culture=en&$orderby=PublicationDateAndTime%20desc&$select=Title,ItemDefaultUrl,PublicationDateAndTime&$top=30';
// CDC Health Alert Network RSS (US-centric; supplements WHO for North American events)
const CDC_FEED = 'https://tools.cdc.gov/api/v2/resources/media/132608.rss';
// Outbreak News Today — aggregates WHO, CDC, and regional health ministry alerts
const OUTBREAK_NEWS_FEED = 'https://outbreaknewstoday.com/feed/';
// ThinkGlobalHealth disease tracker — 1,600+ ProMED-sourced real-time alerts
// with lat/lng. Default branch is `master` (NOT `main`) — using `main` returns
// HTTP 404 and silently zeroes out this source, which is the only one that
// publishes precise coordinates (WHO/CDC/ONT only have country names → map
// falls back to country centroids). Verified 2026-05-04.
const THINKGLOBALHEALTH_BUNDLE = 'https://raw.githubusercontent.com/thinkglobalhealth/disease_tracker/master/index_bundle.js';
// Keep alerts within this many days; avoids flooding the map with old events
const TGH_LOOKBACK_DAYS = 90;

const RSS_MAX_BYTES = 500_000; // guard against oversized responses before regex

/**
 * Fetch WHO Disease Outbreak News via their JSON API (RSS feed is dead since 2024).
 * Returns normalized items array.
 */
async function fetchWhoDonApi() {
  try {
    const resp = await fetch(WHO_DON_API, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) { console.warn(`[Disease] WHO DON API HTTP ${resp.status}`); return []; }
    const data = await resp.json();
    const items = data?.value;
    if (!Array.isArray(items)) { console.warn('[Disease] WHO DON API: unexpected response shape'); return []; }
    // Per-item synthetic-tag normalization lives in _disease-outbreaks-helpers.mjs
    // so tests can verify the exact contract without duplicating logic.
    return items.map((item) => whoNormalizeItem(item))
      .filter(i => i.title && Number.isFinite(i.publishedMs));
  } catch (e) {
    console.warn('[Disease] WHO DON API fetch error:', e?.message || e);
    return [];
  }
}

async function fetchRssItems(url, sourceName) {
  try {
    const resp = await fetch(url, {
      headers: { Accept: 'application/rss+xml, application/xml, text/xml', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) { console.warn(`[Disease] ${sourceName} HTTP ${resp.status}`); return []; }
    const xml = await resp.text();
    const bounded = xml.length > RSS_MAX_BYTES ? xml.slice(0, RSS_MAX_BYTES) : xml;
    const items = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRe.exec(bounded)) !== null) {
      const block = match[1];
      const title = (block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1]?.trim() || '';
      const link = (block.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/) || [])[1]?.trim() || '';
      const rawDesc = (block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/) || [])[1] || '';
      const desc = rawDesc
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
        .replace(/<[^>]+>/g, '').trim().slice(0, 300);
      const pubDate = (block.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1]?.trim() || '';
      // Per-item synthetic-tag normalization lives in _disease-outbreaks-helpers.mjs
      // (rssNormalizeItem) so tests verify the exact contract without duplicating logic.
      const normalized = rssNormalizeItem({ title, link, desc, pubDate, sourceName });
      if (!normalized.title || !Number.isFinite(normalized.publishedMs)) continue;
      items.push(normalized);
    }
    return items;
  } catch (e) {
    console.warn(`[Disease] ${sourceName} fetch error:`, e?.message || e);
    return [];
  }
}

/**
 * Fetch ThinkGlobalHealth disease tracker data.
 *
 * The site (https://thinkglobalhealth.github.io/disease_tracker/) embeds
 * ~1,600 ProMED-reviewed disease alerts in index_bundle.js. After their
 * 2026-04 webpack rebuild the data shape changed from a JS object literal
 * (`var a=[{Alert_ID:"..."}]` — unquoted keys) to JSON-quoted records
 * inside `eval("var res = [...]")` blocks. parseRealtimeAlerts (lifted
 * from seed-vpd-tracker.mjs) handles the new format with a
 * schema-anchored scanner that survives further bundler upgrades as long
 * as the field names (Alert_ID, lat, lng, diseases) are stable.
 *
 * We filter to last TGH_LOOKBACK_DAYS days post-parse.
 */
async function fetchThinkGlobalHealth() {
  try {
    const resp = await fetch(THINKGLOBALHEALTH_BUNDLE, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/javascript, text/javascript' },
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) { console.warn(`[Disease] ThinkGlobalHealth HTTP ${resp.status}`); return []; }
    const bundle = await resp.text();

    let records;
    try {
      records = parseRealtimeAlerts(bundle);
    } catch (e) {
      console.warn(`[Disease] ThinkGlobalHealth parse error: ${e?.message || e}`);
      return [];
    }

    const cutoff = Date.now() - TGH_LOOKBACK_DAYS * 86400_000;
    const items = [];
    for (const rec of records) {
      if (rec.lat == null || rec.lng == null || !rec.disease || !rec.date) continue;
      const publishedMs = new Date(rec.date).getTime();
      if (isNaN(publishedMs) || publishedMs < cutoff) continue;
      // Per-item normalization lives in _disease-outbreaks-helpers.mjs
      // (tghNormalizeItem) so tests verify the exact contract without duplicating logic.
      items.push(tghNormalizeItem(rec));
    }
    console.log(`[Disease] ThinkGlobalHealth: ${records.length} total, ${items.length} in last ${TGH_LOOKBACK_DAYS}d`);
    return items;
  } catch (e) {
    console.warn('[Disease] ThinkGlobalHealth fetch error:', e?.message || e);
    return [];
  }
}

async function fetchDiseaseOutbreaks() {
  const [whoItems, cdcItems, outbreakNewsItems, tghItems] = await Promise.all([
    fetchWhoDonApi(),
    fetchRssItems(CDC_FEED, 'CDC'),
    fetchRssItems(OUTBREAK_NEWS_FEED, 'Outbreak News Today'),
    fetchThinkGlobalHealth(),
  ]);
  console.log(`[Disease] Sources: WHO=${whoItems.length} CDC=${cdcItems.length} ONT=${outbreakNewsItems.length} TGH=${tghItems.length}`);

  // TGH items are already disease-curated with exact lat/lng — skip keyword filter,
  // preserve all geo-located alerts, and don't collapse by disease+country.
  const tghOutbreaks = tghItems.map(mapItem);

  const diseaseKeywords = ['outbreak', 'disease', 'virus', 'fever', 'flu', 'ebola', 'mpox',
    'cholera', 'dengue', 'measles', 'polio', 'plague', 'avian', 'h5n1', 'epidemic',
    'infection', 'pathogen', 'rabies', 'meningitis', 'hepatitis', 'nipah', 'marburg',
    'diphtheria', 'chikungunya', 'rift valley', 'influenza', 'botulism',
    'salmonella', 'listeria', 'e. coli', 'norovirus', 'legionella', 'campylobacter'];

  const otherOutbreaks = [...whoItems, ...cdcItems, ...outbreakNewsItems]
    .filter(item => {
      const text = `${item.title} ${item.desc}`.toLowerCase();
      return diseaseKeywords.some(k => text.includes(k));
    })
    .map(mapItem);

  // Sort before dedup so the first occurrence is always the most recent.
  otherOutbreaks.sort((a, b) => b.publishedAt - a.publishedAt);

  // Deduplicate non-TGH items by disease+country (keep most recent per pair).
  // TGH items each represent a distinct geo-located event — never collapse them.
  const seen = new Set();
  const dedupedOthers = otherOutbreaks.filter(o => {
    const key = o.disease === 'Unknown Disease' ? o.id : `${o.disease}:${o.countryCode || o.location}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // TGH first (precise geo), then WHO/CDC/ONT (already sorted above before dedup).
  const tghSorted = tghOutbreaks.sort((a, b) => b.publishedAt - a.publishedAt);

  // Up to 150 TGH geo-pinned alerts + up to 50 from other authoritative sources.
  const outbreaks = [...tghSorted.slice(0, 150), ...dedupedOthers.slice(0, 50)];

  return { outbreaks, fetchedAt: Date.now() };
}

function validate(data) {
  return Array.isArray(data?.outbreaks) && data.outbreaks.length >= 1;
}

export function declareRecords(data) {
  return Array.isArray(data?.outbreaks) ? data.outbreaks.length : 0;
}

runSeed('health', 'disease-outbreaks', CANONICAL_KEY, fetchDiseaseOutbreaks, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'who-api-cdc-ont-v6',

  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 2880,

  // ── Content-age contract (Sprint 2 of the 2026-05-04 health-readiness plan) ──
  //
  // 9-day budget chosen so the 2026-05-04 incident — where the cache held
  // 50 outbreaks all 11+ days old — would have correctly tripped STALE_CONTENT
  // in /api/health. WHO Disease Outbreak News publishes 1-2/week (typical gap
  // 3-5d), CDC HAN is sporadic but rarely silent for a full week, and TGH
  // (post-#3593) provides daily ProMED items. 9 days tolerates a single quiet
  // WHO/CDC week without paging on normal cadence.
  //
  // diseaseContentMeta + diseasePublishTransform live in
  // `_disease-outbreaks-helpers.mjs` so the test suite imports the same code
  // the seeder runs (no drift). See helpers module header for their semantics.
  contentMeta: diseaseContentMeta,
  maxContentAgeMin: DISEASE_MAX_CONTENT_AGE_MIN,
  publishTransform: diseasePublishTransform,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
