#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, httpsProxyFetchRaw } from './_seed-utils.mjs';
import { resolveProxyStringConnect } from './_proxy-utils.cjs';

loadEnvFile(import.meta.url);

export const CANONICAL_KEY = 'energy:intelligence:feed:v1';
export const INTELLIGENCE_TTL_SECONDS = 86400; // 24h = 4× 6h interval (gold standard: TTL ≥ 3× interval)
const MAX_ITEMS = 30;
const RSS_MAX_BYTES = 500_000;
const AGE_LIMIT_MS = 30 * 24 * 3600 * 1000; // 30 days

// Note: IEA removed public RSS feeds (https://www.iea.org/rss/*.xml returns 404).
// OPEC RSS is Cloudflare-protected — direct fetch from Railway gets 403; proxy fallback required.
// OilPrice.com provides reliable energy intelligence coverage as primary source.
const FEEDS = [
  { url: 'https://oilprice.com/rss/main',        source: 'OilPrice', label: 'oilprice-main'  },
  { url: 'https://www.opec.org/opec_web/en/press_room/rss.htm', source: 'OPEC', label: 'opec-press' },
];

export const ENERGY_KEYWORDS = [
  'oil', 'gas', 'lng', 'coal', 'energy', 'opec', 'refinery', 'petroleum',
  'electricity', 'power', 'renewable', 'nuclear', 'barrel', 'crude',
  'storage', 'pipeline', 'fuel', 'carbon', 'emissions',
];

export function stableHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&lsquo;|&rsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"');
}

function extractTag(block, tagName) {
  const re = new RegExp(`<${tagName}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tagName}>`, 'i');
  return (block.match(re) || [])[1]?.trim() || '';
}

function cleanSummary(raw) {
  return decodeHtmlEntities(raw).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function parseDateMs(block) {
  const raw = extractTag(block, 'pubDate')
    || extractTag(block, 'published')
    || extractTag(block, 'updated')
    || extractTag(block, 'dc:date');
  if (!raw) return 0;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function extractLink(block) {
  const direct = extractTag(block, 'link');
  if (direct) return decodeHtmlEntities(direct).trim();
  const href = (block.match(/<link[^>]*\bhref=(["'])(.*?)\1[^>]*\/?>/i) || [])[2] || '';
  return decodeHtmlEntities(href).trim();
}

export function parseRssItems(xml, source) {
  const bounded = xml.length > RSS_MAX_BYTES ? xml.slice(0, RSS_MAX_BYTES) : xml;
  const items = [];
  const seenIds = new Set();

  const pushParsedItem = (block, summaryTags) => {
    const title = decodeHtmlEntities(extractTag(block, 'title'));
    const url = extractLink(block);
    const publishedAt = parseDateMs(block);
    const rawSummary = summaryTags.map((tag) => extractTag(block, tag)).find(Boolean) || '';
    if (!title || !url || !publishedAt) return;

    const id = `${source.toLowerCase()}-${stableHash(url)}-${publishedAt}`;
    if (seenIds.has(id)) return;
    seenIds.add(id);

    items.push({
      id,
      title,
      url,
      source,
      publishedAt,
      summary: cleanSummary(rawSummary),
    });
  };

  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRe.exec(bounded)) !== null) {
    pushParsedItem(match[1], ['description', 'summary', 'content:encoded']);
  }

  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  while ((match = entryRe.exec(bounded)) !== null) {
    pushParsedItem(match[1], ['summary', 'content']);
  }

  return items;
}

export function filterEnergyRelevant(items) {
  return items.filter((item) => {
    const text = `${item.title} ${item.summary}`.toLowerCase();
    return ENERGY_KEYWORDS.some((kw) => text.includes(kw));
  });
}

export function deduplicateByUrl(items) {
  const byUrl = new Map();
  for (const item of items) {
    const key = stableHash(item.url);
    const existing = byUrl.get(key);
    if (!existing || item.publishedAt > existing.publishedAt) {
      byUrl.set(key, item);
    }
  }
  return Array.from(byUrl.values());
}

async function fetchFeedDirect(feed) {
  const resp = await fetch(feed.url, {
    headers: {
      Accept: 'application/rss+xml, application/xml, text/xml, */*',
      'User-Agent': CHROME_UA,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.text();
}

async function fetchFeed(feed) {
  try {
    let xml;
    try {
      xml = await fetchFeedDirect(feed);
    } catch (directErr) {
      const proxyAuth = resolveProxyStringConnect();
      if (!proxyAuth) throw directErr;
      console.warn(`[EnergyIntel] ${feed.label} direct failed (${directErr.message}), retrying via proxy`);
      const { buffer } = await httpsProxyFetchRaw(feed.url, proxyAuth, {
        accept: 'application/rss+xml, application/xml, text/xml, */*',
        timeoutMs: 15_000,
      });
      xml = buffer.toString('utf8');
    }
    const items = parseRssItems(xml, feed.source);
    console.log(`[EnergyIntel] ${feed.label}: ${items.length} raw items`);
    return items;
  } catch (e) {
    console.warn(`[EnergyIntel] ${feed.label} fetch error:`, e?.message || e);
    return [];
  }
}

async function fetchEnergyIntelligence() {
  const settled = await Promise.allSettled(FEEDS.map(fetchFeed));
  const allItems = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') allItems.push(...result.value);
  }

  if (allItems.length === 0) {
    throw new Error('All energy intelligence feeds returned 0 items');
  }

  const now = Date.now();
  const recent = allItems.filter((item) => item.publishedAt >= now - AGE_LIMIT_MS);

  const relevant = filterEnergyRelevant(recent);

  const deduped = deduplicateByUrl(relevant);

  deduped.sort((a, b) => b.publishedAt - a.publishedAt);

  const limited = deduped.slice(0, MAX_ITEMS);

  console.log(`[EnergyIntel] ${allItems.length} raw → ${recent.length} recent → ${relevant.length} relevant → ${deduped.length} deduped → ${limited.length} final`);

  return { items: limited, fetchedAt: now, count: limited.length };
}

export function validate(data) {
  return Array.isArray(data?.items) && data.items.length >= 3;
}

export { CANONICAL_KEY as ENERGY_INTELLIGENCE_KEY };

if (process.argv[1]?.endsWith('seed-energy-intelligence.mjs')) {
  runSeed('energy', 'intelligence', CANONICAL_KEY, fetchEnergyIntelligence, {
    validateFn: validate,
    ttlSeconds: INTELLIGENCE_TTL_SECONDS,
    sourceVersion: 'energy-intel-rss-v1',
    recordCount: (data) => data?.items?.length || 0,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
