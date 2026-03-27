#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'health:disease-outbreaks:v1';
const CACHE_TTL = 86400; // 24h — daily seed

// WHO Disease Outbreak News RSS
const WHO_FEED = 'https://www.who.int/rss-feeds/news-releases.rss';
// ProMED RSS
const PROMED_FEED = 'https://promedmail.org/feed/';

const COUNTRY_CODE_MAP = {
  'china': 'CN', 'india': 'IN', 'brazil': 'BR', 'russia': 'RU',
  'usa': 'US', 'united states': 'US', 'france': 'FR', 'germany': 'DE',
  'uk': 'GB', 'united kingdom': 'GB', 'japan': 'JP', 'nigeria': 'NG',
  'congo': 'CD', 'drc': 'CD', 'kenya': 'KE', 'indonesia': 'ID',
  'philippines': 'PH', 'thailand': 'TH', 'vietnam': 'VN', 'pakistan': 'PK',
  'bangladesh': 'BD', 'egypt': 'EG', 'south africa': 'ZA', 'mexico': 'MX',
  'colombia': 'CO', 'sudan': 'SD', 'ethiopia': 'ET', 'myanmar': 'MM',
  'cambodia': 'KH', 'laos': 'LA', 'mali': 'ML', 'guinea': 'GN',
  'liberia': 'LR', 'sierra leone': 'SL', 'ghana': 'GH', 'senegal': 'SN',
  'tanzania': 'TZ', 'mozambique': 'MZ', 'zambia': 'ZM', 'zimbabwe': 'ZW',
  'malawi': 'MW', 'angola': 'AO', 'chad': 'TD', 'niger': 'NE',
  'cameroon': 'CM', 'somalia': 'SO', 'yemen': 'YE', 'iraq': 'IQ',
};

function extractCountryCode(text) {
  const lower = text.toLowerCase();
  for (const [country, code] of Object.entries(COUNTRY_CODE_MAP)) {
    if (lower.includes(country)) return code;
  }
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
    const xml = await resp.text();
    const items = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRe.exec(xml)) !== null) {
      const block = match[1];
      const title = (block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/) || [])[1]?.trim() || '';
      const link = (block.match(/<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/link>/) || [])[1]?.trim() || '';
      const desc = (block.match(/<description>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/description>/) || [])[1]?.replace(/<[^>]+>/g, '').trim().slice(0, 300) || '';
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
  const [whoItems, promedItems] = await Promise.all([
    fetchRssItems(WHO_FEED, 'WHO'),
    fetchRssItems(PROMED_FEED, 'ProMED'),
  ]);

  const allItems = [...whoItems, ...promedItems];
  const diseaseKeywords = ['outbreak', 'disease', 'virus', 'fever', 'flu', 'ebola', 'mpox',
    'cholera', 'dengue', 'measles', 'polio', 'plague', 'avian', 'h5n1', 'epidemic',
    'infection', 'pathogen', 'rabies', 'meningitis', 'hepatitis', 'nipah', 'marburg'];

  const relevant = allItems.filter(item => {
    const text = `${item.title} ${item.desc}`.toLowerCase();
    return diseaseKeywords.some(k => text.includes(k));
  });

  const outbreaks = relevant.map((item, i) => ({
    id: `${item.sourceName.toLowerCase()}-${i}-${item.publishedMs}`,
    disease: detectDisease(item.title),
    location: '',
    countryCode: extractCountryCode(`${item.title} ${item.desc}`),
    alertLevel: detectAlertLevel(item.title, item.desc),
    summary: item.desc.slice(0, 300),
    sourceUrl: item.link,
    publishedAt: item.publishedMs,
    sourceName: item.sourceName,
  }));

  outbreaks.sort((a, b) => b.publishedAt - a.publishedAt);

  return { outbreaks: outbreaks.slice(0, 50), fetchedAt: Date.now() };
}

function validate(data) {
  return Array.isArray(data?.outbreaks);
}

runSeed('health', 'disease-outbreaks', CANONICAL_KEY, fetchDiseaseOutbreaks, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'who-promed-rss-v1',
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
