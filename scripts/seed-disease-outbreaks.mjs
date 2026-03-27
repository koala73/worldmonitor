#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
import { extractCountryCode } from './shared/geo-extract.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'health:disease-outbreaks:v1';
const CACHE_TTL = 86400; // 24h — daily seed

// WHO Disease Outbreak News RSS (specific DON feed, not general news)
const WHO_FEED = 'https://www.who.int/feeds/entity/csr/don/en/rss.xml';
// ProMED RSS — promedmail.org/feed/ returns HTML 404; omitted until a valid feed URL is confirmed
// const PROMED_FEED = 'https://promedmail.org/feed/';

const RSS_MAX_BYTES = 500_000; // guard against oversized responses before regex

function stableHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
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
    'nipah', 'rift valley', 'crimean-congo', 'leishmaniasis', 'malaria'];
  for (const d of known) {
    if (lower.includes(d)) return d.charAt(0).toUpperCase() + d.slice(1);
  }
  return 'Unknown Disease';
}

async function fetchRssItems(url, sourceName) {
  try {
    const resp = await fetch(url, {
      headers: { Accept: 'application/rss+xml, application/xml, text/xml', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) { console.warn(`[Disease] ${sourceName} HTTP ${resp.status}`); return []; }
    const raw = await resp.text();
    const xml = raw.length > RSS_MAX_BYTES ? raw.slice(0, RSS_MAX_BYTES) : raw;
    const items = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRe.exec(xml)) !== null) {
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

async function fetchDiseaseOutbreaks() {
  const whoItems = await fetchRssItems(WHO_FEED, 'WHO');

  const diseaseKeywords = ['outbreak', 'disease', 'virus', 'fever', 'flu', 'ebola', 'mpox',
    'cholera', 'dengue', 'measles', 'polio', 'plague', 'avian', 'h5n1', 'epidemic',
    'infection', 'pathogen', 'rabies', 'meningitis', 'hepatitis', 'nipah', 'marburg'];

  const relevant = whoItems.filter(item => {
    const text = `${item.title} ${item.desc}`.toLowerCase();
    return diseaseKeywords.some(k => text.includes(k));
  });

  const outbreaks = relevant.map((item) => ({
    id: `${item.sourceName.toLowerCase()}-${stableHash(item.link || item.title)}-${item.publishedMs}`,
    disease: detectDisease(item.title),
    countryCode: extractCountryCode(`${item.title} ${item.desc}`) ?? '',
    alertLevel: detectAlertLevel(item.title, item.desc),
    summary: item.desc,
    sourceUrl: item.link,
    publishedAt: item.publishedMs,
    sourceName: item.sourceName,
  }));

  outbreaks.sort((a, b) => b.publishedAt - a.publishedAt);

  return { outbreaks: outbreaks.slice(0, 50), fetchedAt: Date.now() };
}

function validate(data) {
  return Array.isArray(data?.outbreaks) && data.outbreaks.length >= 1;
}

runSeed('health', 'disease-outbreaks', CANONICAL_KEY, fetchDiseaseOutbreaks, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'who-don-rss-v2',
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
