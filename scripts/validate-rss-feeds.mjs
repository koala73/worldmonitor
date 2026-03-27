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
const MONTH_INDEX = {
  jan: 0, january: 0, janv: 0, janvier: 0, ene: 0, enero: 0,
  feb: 1, february: 1, fev: 1, fév: 1, fevrier: 1, février: 1, febr: 1, febrero: 1,
  mar: 2, march: 2, mars: 2, marzo: 2,
  apr: 3, april: 3, avr: 3, avril: 3, abr: 3, abril: 3,
  may: 4, mai: 4, mayo: 4,
  jun: 5, june: 5, juin: 5, junio: 5,
  jul: 6, july: 6, juil: 6, juillet: 6, julio: 6,
  aug: 7, august: 7, aout: 7, août: 7, ago: 7, agosto: 7,
  sep: 8, sept: 8, september: 8, septembre: 8, septiembre: 8,
  oct: 9, october: 9, octobre: 9, octubre: 9,
  nov: 10, november: 10, novembre: 10, noviembre: 10,
  dec: 11, december: 11, decembre: 11, décembre: 11, dic: 11, diciembre: 11,
};

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
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: false,
  });
  const doc = parser.parse(xml);

  const dates = [];
  const addDate = (value) => {
    if (value == null) return;
    const values = Array.isArray(value) ? value : [value];
    for (const raw of values) {
      const parsed = parseFeedDate(raw);
      if (parsed) dates.push(parsed);
    }
  };

  // RSS 2.0
  const channel = doc?.rss?.channel;
  if (channel) {
    addDate(channel.pubDate);
    addDate(channel.lastBuildDate);
    addDate(channel['dc:date']);
    addDate(channel.updated);

    const items = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];
    for (const item of items) {
      addDate(item.pubDate);
      addDate(item['dc:date']);
      addDate(item.updated);
      addDate(item.published);
      addDate(item['atom:updated']);
      addDate(item['atom:published']);
    }
  }

  // Atom
  const atomFeed = doc?.feed;
  if (atomFeed) {
    addDate(atomFeed.updated);
    addDate(atomFeed.published);
    addDate(atomFeed['atom:updated']);
    addDate(atomFeed['atom:published']);

    const entries = Array.isArray(atomFeed.entry) ? atomFeed.entry : atomFeed.entry ? [atomFeed.entry] : [];
    for (const entry of entries) {
      addDate(entry.updated);
      addDate(entry.published);
      addDate(entry['atom:updated']);
      addDate(entry['atom:published']);
      addDate(entry['dc:date']);
    }
  }

  // RDF (RSS 1.0)
  const rdf = doc?.['rdf:RDF'];
  if (rdf) {
    addDate(rdf['dc:date']);
    addDate(rdf.pubDate);
    addDate(rdf.lastBuildDate);
    const items = Array.isArray(rdf.item) ? rdf.item : rdf.item ? [rdf.item] : [];
    for (const item of items) {
      addDate(item['dc:date']);
      addDate(item.pubDate);
      addDate(item.updated);
    }
  }

  const valid = dates.filter(d => !Number.isNaN(d.getTime()));
  if (valid.length === 0) return null;
  return new Date(Math.max(...valid.map(d => d.getTime())));
}

function parseFeedDate(rawDate) {
  if (rawDate instanceof Date) {
    return Number.isNaN(rawDate.getTime()) ? null : rawDate;
  }

  if (typeof rawDate !== 'string' && typeof rawDate !== 'number') {
    return null;
  }

  const input = String(rawDate).trim();
  if (!input) return null;

  const nativeDate = new Date(input);
  if (!Number.isNaN(nativeDate.getTime())) {
    return nativeDate;
  }

  // Example: "26-03-24  15:10" (yy-mm-dd hh:mm)
  const compactMatch = input.match(/^(\d{2})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (compactMatch) {
    const yearShort = Number.parseInt(compactMatch[1], 10);
    const year = yearShort >= 70 ? 1900 + yearShort : 2000 + yearShort;
    const month = Number.parseInt(compactMatch[2], 10) - 1;
    const day = Number.parseInt(compactMatch[3], 10);
    const hour = Number.parseInt(compactMatch[4], 10);
    const minute = Number.parseInt(compactMatch[5], 10);
    return new Date(Date.UTC(year, month, day, hour, minute));
  }

  // Example: "Mardi, mars 24, 2026 - 16:38"
  const localizedMatch = input.match(/^[^,]+,\s*([^\s,]+)\s+(\d{1,2}),\s*(\d{4})\s*-\s*(\d{1,2}):(\d{2})$/u);
  if (localizedMatch) {
    const rawMonth = localizedMatch[1]
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '');
    const month = MONTH_INDEX[rawMonth] ?? MONTH_INDEX[rawMonth.slice(0, 3)];
    if (month != null) {
      const day = Number.parseInt(localizedMatch[2], 10);
      const year = Number.parseInt(localizedMatch[3], 10);
      const hour = Number.parseInt(localizedMatch[4], 10);
      const minute = Number.parseInt(localizedMatch[5], 10);
      return new Date(Date.UTC(year, month, day, hour, minute));
    }
  }

  return null;
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
