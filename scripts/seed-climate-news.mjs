#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'climate:news-intelligence:v1';
const CACHE_TTL = 5400; // 90min = 3× 30-min relay interval (gold standard: TTL ≥ 3× interval)
const MAX_ITEMS = 100;
const RSS_MAX_BYTES = 500_000;

const FEEDS = [
  { sourceName: 'Carbon Brief', url: 'https://www.carbonbrief.org/feed' },
  { sourceName: 'The Guardian Environment', url: 'https://www.theguardian.com/environment/climate-crisis/rss' },
  { sourceName: 'ReliefWeb Disasters', url: 'https://reliefweb.int/updates/rss.xml?content=reports&country=0&theme=4590' },
  { sourceName: 'NASA Earth Observatory', url: 'https://earthobservatory.nasa.gov/feeds/earth-observatory.rss' },
  { sourceName: 'NOAA Climate News', url: 'https://www.noaa.gov/taxonomy/term/28/rss' },
  { sourceName: 'Phys.org Earth Science', url: 'https://phys.org/rss-feed/earth-news/earth-sciences/' },
  { sourceName: 'Copernicus/ECMWF', url: 'https://atmosphere.copernicus.eu/rss' },
  { sourceName: 'Inside Climate News', url: 'https://insideclimatenews.org/feed/' },
  { sourceName: 'Climate Central', url: 'https://www.climatecentral.org/rss' },
];

function stableHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
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

function parseRssItems(xml, sourceName) {
  const bounded = xml.length > RSS_MAX_BYTES ? xml.slice(0, RSS_MAX_BYTES) : xml;
  const items = [];
  const seenIds = new Set();

  const pushParsedItem = (block, summaryTags) => {
    const title = decodeHtmlEntities(extractTag(block, 'title'));
    const url = extractLink(block);
    const publishedAt = parseDateMs(block);
    const rawSummary = summaryTags.map((tag) => extractTag(block, tag)).find(Boolean) || '';
    if (!title || !url || !publishedAt) return;

    const id = `${stableHash(url)}-${publishedAt}`;
    if (seenIds.has(id)) return;
    seenIds.add(id);

    items.push({
      id,
      title,
      url,
      sourceName,
      publishedAt,
      summary: cleanSummary(rawSummary),
    });
  };

  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRe.exec(bounded)) !== null) {
    pushParsedItem(match[1], ['description', 'summary', 'content:encoded']);
  }

  // Parse Atom entries per-feed as well; do not gate on RSS <item> presence.
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  while ((match = entryRe.exec(bounded)) !== null) {
    pushParsedItem(match[1], ['summary', 'content']);
  }

  return items;
}

async function fetchFeed(feed) {
  try {
    const resp = await fetch(feed.url, {
      headers: {
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
        'User-Agent': CHROME_UA,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      console.warn(`[ClimateNews] ${feed.sourceName} HTTP ${resp.status}`);
      return [];
    }
    const xml = await resp.text();
    const items = parseRssItems(xml, feed.sourceName);
    console.log(`[ClimateNews] ${feed.sourceName}: ${items.length} items`);
    return items;
  } catch (e) {
    console.warn(`[ClimateNews] ${feed.sourceName} fetch error:`, e?.message || e);
    return [];
  }
}

async function fetchClimateNews() {
  const settled = await Promise.allSettled(FEEDS.map(fetchFeed));
  const allItems = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') allItems.push(...result.value);
  }

  allItems.sort((a, b) => b.publishedAt - a.publishedAt);

  // Deduplicate by URL hash, keep newest occurrence.
  const seenUrlHashes = new Set();
  const deduped = [];
  for (const item of allItems) {
    const urlHash = stableHash(item.url);
    if (seenUrlHashes.has(urlHash)) continue;
    seenUrlHashes.add(urlHash);
    deduped.push(item);
    if (deduped.length >= MAX_ITEMS) break;
  }

  return { items: deduped, fetchedAt: Date.now() };
}

function validate(data) {
  return Array.isArray(data?.items) && data.items.length >= 1;
}

runSeed('climate', 'news-intelligence', CANONICAL_KEY, fetchClimateNews, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'climate-rss-v1',
  recordCount: (data) => data?.items?.length || 0,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
