#!/usr/bin/env node
// @ts-check

import { pathToFileURL } from 'node:url';
import { CHROME_UA } from './_seed-utils.mjs';

const FEED_TIMEOUT_MS = 15_000;
const XML_ACCEPT = 'application/atom+xml, application/rss+xml, application/xml, text/xml, */*';
const SEC_USER_AGENT = 'WorldMonitor/2.0 (monitor@worldmonitor.app)';
const DEFAULT_FETCH = (...args) => globalThis.fetch(...args);

const REGULATORY_FEEDS = [
  { agency: 'SEC', url: 'https://www.sec.gov/news/pressreleases.rss', userAgent: SEC_USER_AGENT },
  { agency: 'CFTC', url: 'https://www.cftc.gov/RSS/RSSENF/rssenf.xml' },
  { agency: 'CFTC', url: 'https://www.cftc.gov/RSS/RSSGP/rssgp.xml' },
  { agency: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
  { agency: 'FDIC', url: 'https://public.govdelivery.com/topics/USFDIC_26/feed.rss' },
  // FINRA still publishes this RSS endpoint over plain HTTP; HTTPS requests fail
  // from both Node fetch and curl in validation, so keep the official feed URL
  // and periodically recheck whether HTTPS starts working.
  { agency: 'FINRA', url: 'http://feeds.finra.org/FINRANotices' },
];

function decodeEntities(input) {
  if (!input) return '';
  const named = input
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ');

  return named
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function stripHtml(input) {
  const unwrapped = String(input || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  const decoded = decodeEntities(unwrapped);
  return decoded.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function getTagValue(block, tagName) {
  const match = block.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return stripHtml(match?.[1] || '');
}

function extractAtomLink(block) {
  const linkTags = [...block.matchAll(/<link\b([^>]*)\/?>/gi)];
  if (linkTags.length === 0) return '';

  for (const [, attrs] of linkTags) {
    const href = attrs.match(/\bhref=["']([^"']+)["']/i)?.[1];
    const rel = attrs.match(/\brel=["']([^"']+)["']/i)?.[1]?.toLowerCase() || '';
    if (href && (!rel || rel === 'alternate')) return decodeEntities(href.trim());
  }

  for (const [, attrs] of linkTags) {
    const href = attrs.match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (href) return decodeEntities(href.trim());
  }

  return '';
}

function resolveFeedLink(link, feedUrl) {
  if (!link) return '';
  try {
    return new URL(link).href;
  } catch {}
  try {
    return new URL(link, feedUrl).href;
  } catch {
    return '';
  }
}

function canonicalizeLink(link, feedUrl = '') {
  const resolved = resolveFeedLink(link, feedUrl);
  if (!resolved) return '';
  try {
    const url = new URL(resolved);
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

function toIsoDate(rawDate) {
  const value = stripHtml(rawDate);
  if (!value) return '';
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : '';
}

function slugifyTitle(title) {
  return stripHtml(title)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function yyyymmdd(isoDate) {
  return String(isoDate || '').slice(0, 10).replace(/-/g, '');
}

function hhmmss(isoDate) {
  return String(isoDate || '').slice(11, 19).replace(/:/g, '');
}

function buildActionId(agency, title, publishedAt) {
  const agencySlug = slugifyTitle(agency) || 'agency';
  const titleSlug = slugifyTitle(title) || 'untitled';
  const datePart = yyyymmdd(publishedAt) || 'undated';
  const timePart = hhmmss(publishedAt) || '000000';
  return `${agencySlug}-${titleSlug}-${datePart}-${timePart}`;
}

function parseRssItems(xml, feedUrl) {
  const items = [];
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = getTagValue(block, 'title');
    const description = getTagValue(block, 'description');
    const link = canonicalizeLink(getTagValue(block, 'link'), feedUrl);
    const publishedAt = toIsoDate(getTagValue(block, 'pubDate') || getTagValue(block, 'updated'));
    items.push({ title, description, link, publishedAt });
  }
  return items;
}

function parseAtomEntries(xml, feedUrl) {
  const entries = [];
  const entryRegex = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = getTagValue(block, 'title');
    const description = getTagValue(block, 'summary') || getTagValue(block, 'content');
    const link = canonicalizeLink(extractAtomLink(block), feedUrl);
    const publishedAt = toIsoDate(
      getTagValue(block, 'updated') || getTagValue(block, 'published') || getTagValue(block, 'pubDate')
    );
    entries.push({ title, description, link, publishedAt });
  }
  return entries;
}

function parseFeed(xml, feedUrl) {
  if (/<entry\b/i.test(xml)) return parseAtomEntries(xml, feedUrl);
  return parseRssItems(xml, feedUrl);
}

function normalizeFeedItems(items, agency) {
  return items
    .filter((item) => item.title && item.link && item.publishedAt)
    .map((item) => ({
      id: buildActionId(agency, item.title, item.publishedAt),
      agency,
      title: item.title,
      description: item.description || '',
      link: item.link,
      publishedAt: item.publishedAt,
    }));
}

function dedupeAndSortActions(actions) {
  const seen = new Set();
  const deduped = [];
  for (const action of actions) {
    const key = canonicalizeLink(action.link);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push({ ...action, link: key });
  }

  deduped.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  return deduped;
}

async function fetchFeed(feed, fetchImpl = DEFAULT_FETCH) {
  const headers = {
    Accept: XML_ACCEPT,
    'User-Agent': feed.userAgent || CHROME_UA,
  };

  const response = await fetchImpl(feed.url, {
    headers,
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`${feed.agency}: HTTP ${response.status}`);
  }

  const xml = await response.text();
  const parsed = parseFeed(xml, feed.url);
  return normalizeFeedItems(parsed, feed.agency);
}

async function fetchAllFeeds(fetchImpl = DEFAULT_FETCH, feeds = REGULATORY_FEEDS) {
  const results = await Promise.allSettled(feeds.map((feed) => fetchFeed(feed, fetchImpl)));
  const actions = [];
  let successCount = 0;

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const feed = feeds[index];
    if (result.status === 'fulfilled') {
      successCount += 1;
      actions.push(...result.value);
      continue;
    }
    console.error(`[regulatory] ${feed.agency}: ${result.reason?.message || result.reason}`);
  }

  if (successCount === 0) {
    throw new Error('All regulatory feeds failed');
  }

  return dedupeAndSortActions(actions);
}

async function main(fetchImpl = DEFAULT_FETCH) {
  const actions = await fetchAllFeeds(fetchImpl);
  process.stdout.write(`${JSON.stringify(actions, null, 2)}\n`);
  return actions;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error(`FETCH FAILED: ${err.message || err}`);
    process.exit(1);
  });
}

export {
  CHROME_UA,
  FEED_TIMEOUT_MS,
  REGULATORY_FEEDS,
  SEC_USER_AGENT,
  buildActionId,
  canonicalizeLink,
  decodeEntities,
  dedupeAndSortActions,
  extractAtomLink,
  fetchAllFeeds,
  fetchFeed,
  getTagValue,
  main,
  normalizeFeedItems,
  parseAtomEntries,
  parseFeed,
  parseRssItems,
  resolveFeedLink,
  slugifyTitle,
  stripHtml,
  toIsoDate,
};
