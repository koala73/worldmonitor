#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FEEDS_PATH = join(__dirname, '..', 'src', 'config', 'feeds.ts');

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const FETCH_TIMEOUT = 15_000;
const CONCURRENCY = 10;
const STALE_DAYS = 30;

function extractFeeds() {
  const src = readFileSync(FEEDS_PATH, 'utf8');
  const feeds = [];
  const seen = new Set();

  // Match rss('url') or railwayRss('url') — capture raw URL
  const rssUrlRe = /(?:rss|railwayRss)\(\s*'([^']+)'\s*\)/g;
  // Match name: 'X' or name: "X" — handles escaped apostrophes (L\'Orient-Le Jour)
  const nameRe = /name:\s*(?:'((?:[^'\\]|\\.)*)'|"([^"]+)")/;
  // Match lang key like `en: rss(`, `fr: rss(` — find all on a line with positions
  const langKeyAllRe = /(?:^|[\s{,])([a-z]{2}):\s*(?:rss|railwayRss)\(/g;

  const lines = src.split('\n');
  let currentName = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const nameMatch = line.match(nameRe);
    if (nameMatch) currentName = nameMatch[1] || nameMatch[2];

    // Build position→lang map for this line
    const langMap = [];
    let lm;
    langKeyAllRe.lastIndex = 0;
    while ((lm = langKeyAllRe.exec(line)) !== null) {
      langMap.push({ pos: lm.index, lang: lm[1] });
    }

    let m;
    rssUrlRe.lastIndex = 0;
    while ((m = rssUrlRe.exec(line)) !== null) {
      const rawUrl = m[1];
      const rssPos = m.index;

      // Find the closest preceding lang key for this rss() call
      let lang = null;
      for (let k = langMap.length - 1; k >= 0; k--) {
        if (langMap[k].pos < rssPos) { lang = langMap[k].lang; break; }
      }

      const label = lang ? `${currentName} [${lang}]` : currentName;
      const key = `${label}|${rawUrl}`;

      if (!seen.has(key)) {
        seen.add(key);
        feeds.push({ name: label || 'Unknown', url: rawUrl });
      }
    }
  }

  // Also pick up non-rss() URLs like '/api/fwdstart'
  const directUrlRe = /name:\s*'([^']+)'[^}]*url:\s*'(\/[^']+)'/g;
  let dm;
  while ((dm = directUrlRe.exec(src)) !== null) {
    const key = `${dm[1]}|${dm[2]}`;
    if (!seen.has(key)) {
      seen.add(key);
      feeds.push({ name: dm[1], url: dm[2], isLocal: true });
    }
  }

  return feeds;
}

async function fetchFeed(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': CHROME_UA, 'Accept': 'application/rss+xml, application/xml, text/xml, */*' },
      redirect: 'follow',
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseNewestDate(xml) {
  const parser = new XMLParser({ ignoreAttributes: false });
  const doc = parser.parse(xml);

  const dates = [];

  // RSS 2.0
  const channel = doc?.rss?.channel;
  if (channel) {
    const items = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];
    for (const item of items) {
      if (item.pubDate) dates.push(new Date(item.pubDate));
    }
  }

  // Atom
  const atomFeed = doc?.feed;
  if (atomFeed) {
    const entries = Array.isArray(atomFeed.entry) ? atomFeed.entry : atomFeed.entry ? [atomFeed.entry] : [];
    for (const entry of entries) {
      const d = entry.updated || entry.published;
      if (d) dates.push(new Date(d));
    }
  }

  // RDF (RSS 1.0)
  const rdf = doc?.['rdf:RDF'];
  if (rdf) {
    const items = Array.isArray(rdf.item) ? rdf.item : rdf.item ? [rdf.item] : [];
    for (const item of items) {
      const d = item['dc:date'] || item.pubDate;
      if (d) dates.push(new Date(d));
    }
  }

  const valid = dates.filter(d => !isNaN(d.getTime()));
  if (valid.length === 0) return null;
  return new Date(Math.max(...valid.map(d => d.getTime())));
}

async function validateFeed(feed) {
  if (feed.isLocal) {
    return { ...feed, status: 'SKIP', detail: 'Local API endpoint' };
  }

  try {
    const xml = await fetchFeed(feed.url);
    const newest = parseNewestDate(xml);

    if (!newest) {
      return { ...feed, status: 'EMPTY', detail: 'No parseable dates' };
    }

    const age = Date.now() - newest.getTime();
    const staleCutoff = STALE_DAYS * 24 * 60 * 60 * 1000;

    if (age > staleCutoff) {
      return { ...feed, status: 'STALE', detail: newest.toISOString().slice(0, 10), newest };
    }

    return { ...feed, status: 'OK', newest };
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Timeout (15s)' : err.message;
    return { ...feed, status: 'DEAD', detail: msg };
  }
}

async function runBatch(items, fn, concurrency) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function pad(str, len) {
  return str.length > len ? str.slice(0, len - 1) + '…' : str.padEnd(len);
}

async function main() {
  const feeds = extractFeeds();
  console.log(`Validating ${feeds.length} RSS feeds (${CONCURRENCY} concurrent, ${FETCH_TIMEOUT / 1000}s timeout)...\n`);

  const results = await runBatch(feeds, validateFeed, CONCURRENCY);

  const ok = results.filter(r => r.status === 'OK');
  const stale = results.filter(r => r.status === 'STALE');
  const dead = results.filter(r => r.status === 'DEAD');
  const empty = results.filter(r => r.status === 'EMPTY');
  const skipped = results.filter(r => r.status === 'SKIP');

  if (stale.length) {
    stale.sort((a, b) => a.newest - b.newest);
    console.log(`STALE (newest item > ${STALE_DAYS} days):`);
    console.log(`  ${pad('Feed Name', 35)} | ${pad('Newest Item', 12)} | URL`);
    console.log(`  ${'-'.repeat(35)} | ${'-'.repeat(12)} | ---`);
    for (const r of stale) {
      console.log(`  ${pad(r.name, 35)} | ${pad(r.detail, 12)} | ${r.url}`);
    }
    console.log();
  }

  if (dead.length) {
    console.log('DEAD (fetch/parse failed):');
    console.log(`  ${pad('Feed Name', 35)} | ${pad('Error', 20)} | URL`);
    console.log(`  ${'-'.repeat(35)} | ${'-'.repeat(20)} | ---`);
    for (const r of dead) {
      console.log(`  ${pad(r.name, 35)} | ${pad(r.detail, 20)} | ${r.url}`);
    }
    console.log();
  }

  if (empty.length) {
    console.log('EMPTY (no items/dates found):');
    console.log(`  ${pad('Feed Name', 35)} | URL`);
    console.log(`  ${'-'.repeat(35)} | ---`);
    for (const r of empty) {
      console.log(`  ${pad(r.name, 35)} | ${r.url}`);
    }
    console.log();
  }

  console.log(`Summary: ${ok.length} OK, ${stale.length} stale, ${dead.length} dead, ${empty.length} empty` +
    (skipped.length ? `, ${skipped.length} skipped` : ''));

  if (stale.length || dead.length) process.exit(1);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(2);
});
