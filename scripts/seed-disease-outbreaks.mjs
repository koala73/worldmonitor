#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
import { extractCountryCode } from './shared/geo-extract.mjs';

loadEnvFile(import.meta.url);

// WHO DON uses multi-word or hyphenated country names that the bigram scanner misses.
// These override extractCountryCode for exact substring matches (checked first, case-insensitive).
const WHO_NAME_OVERRIDES = {
  'democratic republic of the congo': 'CD',
  'dr congo': 'CD',
  'timor-leste': 'TL',
  'east timor': 'TL',
  'papua new guinea': 'PG',
  'kingdom of saudi arabia': 'SA',
  'united kingdom': 'GB',
};

function extractCountryCodeFull(text) {
  const lower = text.toLowerCase();
  for (const [name, iso2] of Object.entries(WHO_NAME_OVERRIDES)) {
    if (lower.includes(name)) return iso2;
  }
  return extractCountryCode(text) ?? '';
}

const CANONICAL_KEY = 'health:disease-outbreaks:v1';
const CACHE_TTL = 259200; // 72h (3 days) — 3× daily cron interval per gold standard; survives 2 consecutive missed runs

// WHO Disease Outbreak News JSON API (RSS at /feeds/entity/csr/don/en/rss.xml is dead since 2024)
const WHO_DON_API = 'https://www.who.int/api/emergencies/diseaseoutbreaknews?sf_provider=dynamicProvider372&sf_culture=en&$orderby=PublicationDateAndTime%20desc&$select=Title,ItemDefaultUrl,PublicationDateAndTime&$top=30';
// CDC Health Alert Network RSS (US-centric; supplements WHO for North American events)
const CDC_FEED = 'https://tools.cdc.gov/api/v2/resources/media/132608.rss';
// Outbreak News Today — aggregates WHO, CDC, and regional health ministry alerts
const OUTBREAK_NEWS_FEED = 'https://outbreaknewstoday.com/feed/';
// ThinkGlobalHealth disease tracker — 1,600+ ProMED-sourced real-time alerts with lat/lng
const THINKGLOBALHEALTH_BUNDLE = 'https://raw.githubusercontent.com/thinkglobalhealth/disease_tracker/main/index_bundle.js';
// Keep alerts within this many days; avoids flooding the map with old events
const TGH_LOOKBACK_DAYS = 90;

const RSS_MAX_BYTES = 500_000; // guard against oversized responses before regex

// Proxy support (same pattern as seed-fear-greed): Railway IPs get blocked by some sources.
// PROXY_URL="host:port:user:pass" (Decodo) or OREF_PROXY_AUTH="user:pass@host:port" (Froxy).
function resolveProxy() {
  const raw = process.env.PROXY_URL || '';
  if (raw) {
    // Format: "host:port:user:pass" — password may itself contain colons, so split on first 3 only
    const idx1 = raw.indexOf(':');
    const idx2 = raw.indexOf(':', idx1 + 1);
    const idx3 = raw.indexOf(':', idx2 + 1);
    if (idx1 !== -1 && idx2 !== -1 && idx3 !== -1) {
      const host = raw.slice(0, idx1);
      const port = raw.slice(idx1 + 1, idx2);
      const user = raw.slice(idx2 + 1, idx3);
      const pass = raw.slice(idx3 + 1);
      return `${user}:${pass}@${host.replace(/^gate\./, 'us.')}:${port}`;
    }
  }
  return process.env.OREF_PROXY_AUTH || '';
}
const _proxyAuth = resolveProxy();

// curl-based fetch for sources that block Railway IPs (e.g. Outbreak News Today).
function curlFetch(url, extraHeaders = {}) {
  const args = ['-sS', '--compressed', '--max-time', '15', '-L'];
  if (_proxyAuth) args.push('-x', `http://${_proxyAuth}`);
  args.push('-H', `User-Agent: ${CHROME_UA}`);
  for (const [k, v] of Object.entries(extraHeaders)) args.push('-H', `${k}: ${v}`);
  args.push('-w', '\n%{http_code}');
  args.push(url);
  const raw = execFileSync('curl', args, { encoding: 'utf8', timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'] });
  const nl = raw.lastIndexOf('\n');
  const httpStatus = parseInt(raw.slice(nl + 1).trim(), 10);
  if (httpStatus < 200 || httpStatus >= 300) throw Object.assign(new Error(`HTTP ${httpStatus}`), { status: httpStatus });
  return raw.slice(0, nl);
}

function stableHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/**
 * Extract location string from WHO-style titles.
 * Handles: "Disease – Country" (em-dash), "Disease - Country" (hyphen), "Disease in Country".
 */
function extractLocationFromTitle(title) {
  // WHO DON pattern: "Disease – Country" or "Disease - Country" (one or more dash-separated segments)
  // Split on em-dash, en-dash, or " - " / " – " to get all segments, then take the last capitalized one.
  const segments = title.split(/\s*[–—]\s*|\s+-\s+/);
  if (segments.length >= 2) {
    const last = segments[segments.length - 1].trim();
    if (/^[A-Z]/.test(last)) return last;
  }
  // Fallback: "... in <Country/Region>"
  const inMatch = title.match(/\bin\s+([A-Z][^,.(]+)/);
  if (inMatch) return inMatch[1].trim();
  return '';
}

function detectAlertLevel(title, desc) {
  const text = `${title} ${desc}`.toLowerCase();
  if (text.includes('outbreak') || text.includes('emergency') || text.includes('epidemic') || text.includes('pandemic')) return 'alert';
  if (text.includes('warning') || text.includes('spread') || text.includes('cases increasing')) return 'warning';
  return 'watch';
}

function detectDisease(title) {
  const lower = title.toLowerCase();
  const known = ['mpox', 'monkeypox', 'ebola', 'cholera', 'covid', 'dengue', 'measles',
    'polio', 'marburg', 'lassa', 'plague', 'yellow fever', 'typhoid', 'influenza',
    'avian flu', 'h5n1', 'h5n2', 'anthrax', 'rabies', 'meningitis', 'hepatitis',
    'nipah', 'rift valley', 'crimean-congo', 'leishmaniasis', 'malaria', 'diphtheria',
    'chikungunya', 'botulism', 'brucellosis'];
  for (const d of known) {
    if (lower.includes(d)) return d.charAt(0).toUpperCase() + d.slice(1);
  }
  return 'Unknown Disease';
}

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
    return items.map((item) => ({
      title: (item.Title || '').trim(),
      link: item.ItemDefaultUrl ? `https://www.who.int${item.ItemDefaultUrl}` : '',
      desc: '',
      publishedMs: item.PublicationDateAndTime ? new Date(item.PublicationDateAndTime).getTime() : Date.now(),
      sourceName: 'WHO',
    })).filter(i => i.title && !isNaN(i.publishedMs));
  } catch (e) {
    console.warn('[Disease] WHO DON API fetch error:', e?.message || e);
    return [];
  }
}

async function fetchRssItems(url, sourceName, useCurl = false) {
  try {
    let xml;
    if (useCurl) {
      xml = curlFetch(url, { Accept: 'application/rss+xml, application/xml, text/xml' });
    } else {
      const resp = await fetch(url, {
        headers: { Accept: 'application/rss+xml, application/xml, text/xml', 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) { console.warn(`[Disease] ${sourceName} HTTP ${resp.status}`); return []; }
      xml = await resp.text();
    }
    const bounded = xml.length > RSS_MAX_BYTES ? xml.slice(0, RSS_MAX_BYTES) : xml;
    const items = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRe.exec(bounded)) !== null) {
      const block = match[1];
      const title = (block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1]?.trim() || '';
      const link = (block.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/) || [])[1]?.trim() || '';
      const desc = (block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/) || [])[1]?.replace(/<[^>]+>/g, '').trim().slice(0, 300) || '';
      const pubDate = (block.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1]?.trim() || '';
      const publishedMs = pubDate ? new Date(pubDate).getTime() : Date.now();
      if (!title || isNaN(publishedMs)) continue;
      items.push({ title, link, desc, publishedMs, sourceName });
    }
    return items;
  } catch (e) {
    console.warn(`[Disease] ${sourceName} fetch error:`, e?.message || e);
    return [];
  }
}

/**
 * Fetch ThinkGlobalHealth disease tracker data.
 * The site (https://thinkglobalhealth.github.io/disease_tracker/) embeds all ProMED-reviewed
 * disease alerts directly in index_bundle.js as a JS object literal array:
 *   var a=[{Alert_ID:"...",lat:"...",lng:"...",diseases:"...",country:"...",date:"M/D/YYYY",...}]
 * ~1,600 records with exact lat/lng coordinates. We filter to last TGH_LOOKBACK_DAYS days.
 */
async function fetchThinkGlobalHealth() {
  try {
    const resp = await fetch(THINKGLOBALHEALTH_BUNDLE, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/javascript, text/javascript' },
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) { console.warn(`[Disease] ThinkGlobalHealth HTTP ${resp.status}`); return []; }
    const bundle = await resp.text();

    // Extract the data array: "var a=[{Alert_ID:"
    const marker = 'var a=[{Alert_ID:';
    const startIdx = bundle.indexOf(marker);
    if (startIdx === -1) { console.warn('[Disease] ThinkGlobalHealth: data marker not found'); return []; }

    // Find the end of the array by counting brackets from the [ position
    const arrStart = startIdx + 'var a='.length;
    let depth = 0, end = arrStart;
    for (; end < bundle.length; end++) {
      if (bundle[end] === '[' || bundle[end] === '{') depth++;
      else if (bundle[end] === ']' || bundle[end] === '}') { depth--; if (depth === 0) { end++; break; } }
    }
    const arrayStr = bundle.slice(arrStart, end);

    // Parse JS object literals (keys are unquoted identifiers, all values are strings).
    // Pattern: {Key:"value",...} — flat objects only.
    const records = [];
    const objRe = /\{([^{}]+)\}/g;
    let m;
    while ((m = objRe.exec(arrayStr)) !== null) {
      const obj = {};
      const pairRe = /(\w+):"((?:[^"\\]|\\.)*)"/g;
      let p;
      while ((p = pairRe.exec(m[1])) !== null) obj[p[1]] = p[2];
      if (obj.Alert_ID) records.push(obj);
    }

    const cutoff = Date.now() - TGH_LOOKBACK_DAYS * 86400_000;
    const items = [];
    for (const rec of records) {
      if (!rec.lat || !rec.lng || !rec.diseases || !rec.date) continue;
      const publishedMs = new Date(rec.date).getTime();
      if (isNaN(publishedMs) || publishedMs < cutoff) continue;
      items.push({
        title: `${rec.diseases}${rec.country ? ` - ${rec.country}` : ''}`,
        link: rec.link || '',
        desc: rec.summary ? rec.summary.slice(0, 300) : '',
        publishedMs,
        sourceName: 'ThinkGlobalHealth',
        _country: rec.country || '',
        _disease: rec.diseases || '',
        _location: rec.place_name || rec.country || '',
      });
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
    fetchRssItems(OUTBREAK_NEWS_FEED, 'Outbreak News Today', true),
    fetchThinkGlobalHealth(),
  ]);
  console.log(`[Disease] Sources: WHO=${whoItems.length} CDC=${cdcItems.length} ONT=${outbreakNewsItems.length} TGH=${tghItems.length}`);
  const allItems = [...tghItems, ...whoItems, ...cdcItems, ...outbreakNewsItems];

  const diseaseKeywords = ['outbreak', 'disease', 'virus', 'fever', 'flu', 'ebola', 'mpox',
    'cholera', 'dengue', 'measles', 'polio', 'plague', 'avian', 'h5n1', 'epidemic',
    'infection', 'pathogen', 'rabies', 'meningitis', 'hepatitis', 'nipah', 'marburg',
    'diphtheria', 'chikungunya', 'rift valley', 'influenza', 'botulism'];

  const relevant = allItems.filter(item => {
    const text = `${item.title} ${item.desc}`.toLowerCase();
    return diseaseKeywords.some(k => text.includes(k));
  });

  const outbreaks = relevant.map((item) => {
    // TGH items have pre-parsed country/disease/location from the bundle data.
    const location = item._location || extractLocationFromTitle(item.title);
    const disease = item._disease || detectDisease(item.title);
    // Use pre-parsed country name for TGH; otherwise extract from title location.
    const countryCode = item._country
      ? (extractCountryCodeFull(item._country) || extractCountryCodeFull(location || item.title))
      : extractCountryCodeFull(location || `${item.title} ${item.desc}`);
    return {
      id: `${item.sourceName.toLowerCase()}-${stableHash(item.link || item.title)}-${item.publishedMs}`,
      disease,
      location,
      countryCode,
      alertLevel: detectAlertLevel(item.title, item.desc),
      summary: item.desc,
      sourceUrl: item.link,
      publishedAt: item.publishedMs,
      sourceName: item.sourceName,
    };
  });

  outbreaks.sort((a, b) => b.publishedAt - a.publishedAt);

  // Deduplicate by disease+country combination (keep most recent per pair).
  // "Unknown Disease" events are not collapsed — use the unique id to preserve distinct alerts.
  const seen = new Set();
  const deduped = outbreaks.filter(o => {
    const key = o.disease === 'Unknown Disease' ? o.id : `${o.disease}:${o.countryCode || o.location}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { outbreaks: deduped.slice(0, 50), fetchedAt: Date.now() };
}

function validate(data) {
  return Array.isArray(data?.outbreaks) && data.outbreaks.length >= 1;
}

runSeed('health', 'disease-outbreaks', CANONICAL_KEY, fetchDiseaseOutbreaks, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'who-api-cdc-ont-v4',
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
