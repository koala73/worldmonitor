#!/usr/bin/env node

import { loadEnvFile, loadSharedConfig, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'intelligence:advisories:v1';
const BOOTSTRAP_KEY = 'intelligence:advisories-bootstrap:v1';
const TTL = 10800; // 180min — 2h buffer over 1h cron cadence (was 120min = exactly 1h buffer)

const ALLOWED_DOMAINS = new Set(loadSharedConfig('rss-allowed-domains.json'));

const ADVISORY_FEEDS = [
  { name: 'US State Dept', sourceCountry: 'US', url: 'https://travel.state.gov/_res/rss/TAsTWs.xml', levelParser: 'us' },
{ name: 'UK FCDO', sourceCountry: 'UK', url: 'https://www.gov.uk/foreign-travel-advice.atom' },
  { name: 'US Embassy Thailand', sourceCountry: 'US', url: 'https://th.usembassy.gov/category/alert/feed/', targetCountry: 'TH' },
  { name: 'US Embassy UAE', sourceCountry: 'US', url: 'https://ae.usembassy.gov/category/alert/feed/', targetCountry: 'AE' },
  { name: 'US Embassy Germany', sourceCountry: 'US', url: 'https://de.usembassy.gov/category/alert/feed/', targetCountry: 'DE' },
  { name: 'US Embassy Ukraine', sourceCountry: 'US', url: 'https://ua.usembassy.gov/category/alert/feed/', targetCountry: 'UA' },
  { name: 'US Embassy Mexico', sourceCountry: 'US', url: 'https://mx.usembassy.gov/category/alert/feed/', targetCountry: 'MX' },
  { name: 'US Embassy India', sourceCountry: 'US', url: 'https://in.usembassy.gov/category/alert/feed/', targetCountry: 'IN' },
  { name: 'US Embassy Pakistan', sourceCountry: 'US', url: 'https://pk.usembassy.gov/category/alert/feed/', targetCountry: 'PK' },
  { name: 'US Embassy Colombia', sourceCountry: 'US', url: 'https://co.usembassy.gov/category/alert/feed/', targetCountry: 'CO' },
  { name: 'US Embassy Poland', sourceCountry: 'US', url: 'https://pl.usembassy.gov/category/alert/feed/', targetCountry: 'PL' },
  { name: 'US Embassy Bangladesh', sourceCountry: 'US', url: 'https://bd.usembassy.gov/category/alert/feed/', targetCountry: 'BD' },
  { name: 'US Embassy Italy', sourceCountry: 'US', url: 'https://it.usembassy.gov/category/alert/feed/', targetCountry: 'IT' },
  { name: 'US Embassy Dominican Republic', sourceCountry: 'US', url: 'https://do.usembassy.gov/category/alert/feed/', targetCountry: 'DO' },
  { name: 'US Embassy Myanmar', sourceCountry: 'US', url: 'https://mm.usembassy.gov/category/alert/feed/', targetCountry: 'MM' },
  { name: 'CDC Travel Notices', sourceCountry: 'US', url: 'https://wwwnc.cdc.gov/travel/rss/notices.xml' },
  { name: 'ECDC Epidemiological Updates', sourceCountry: 'EU', url: 'https://www.ecdc.europa.eu/en/taxonomy/term/1310/feed' },
  { name: 'ECDC Threats Report', sourceCountry: 'EU', url: 'https://www.ecdc.europa.eu/en/taxonomy/term/1505/feed' },
  { name: 'ECDC Risk Assessments', sourceCountry: 'EU', url: 'https://www.ecdc.europa.eu/en/taxonomy/term/1295/feed' },
  { name: 'ECDC Avian Influenza', sourceCountry: 'EU', url: 'https://www.ecdc.europa.eu/en/taxonomy/term/323/feed' },
  { name: 'ECDC Publications', sourceCountry: 'EU', url: 'https://www.ecdc.europa.eu/en/taxonomy/term/1244/feed' },
  { name: 'WHO News', sourceCountry: 'INT', url: 'https://www.who.int/rss-feeds/news-english.xml' },
  { name: 'WHO Africa Emergencies', sourceCountry: 'INT', url: 'https://www.afro.who.int/rss/emergencies.xml' },
];

const RELAY_URL = process.env.RELAY_URL || 'https://proxy.worldmonitor.app';

function parseUsLevel(title) {
  const m = title.match(/Level (\d)/i);
  if (!m) return 'info';
  return { '4': 'do-not-travel', '3': 'reconsider', '2': 'caution', '1': 'normal' }[m[1]] || 'info';
}

function parseAuLevel(title) {
  const l = title.toLowerCase();
  if (l.includes('do not travel')) return 'do-not-travel';
  if (l.includes('reconsider')) return 'reconsider';
  if (l.includes('high degree of caution') || l.includes('high degree')) return 'caution';
  return 'info';
}

function parseLevel(title, parser) {
  if (parser === 'us') return parseUsLevel(title);
  if (parser === 'au') return parseAuLevel(title);
  return 'info';
}

const COUNTRY_NAMES = loadSharedConfig('country-names.json');
const SORTED_COUNTRY_ENTRIES = Object.entries(COUNTRY_NAMES).sort((a, b) => b[0].length - a[0].length);
// Reverse map: ISO2 → display name (title-cased from the config keys).
const BY_COUNTRY_NAME = Object.fromEntries(
  Object.entries(COUNTRY_NAMES).map(([name, code]) => [
    code,
    name.replace(/\b\w/g, (c) => c.toUpperCase()),
  ]),
);

function extractCountry(title, feed) {
  if (feed.targetCountry) return feed.targetCountry;
  if (feed.sourceCountry === 'EU' || feed.sourceCountry === 'INT') return undefined;
  const normalized = title.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase()
    .replace(/['.(),/-]/g, ' ').replace(/\s+/g, ' ');
  for (const [name, code] of SORTED_COUNTRY_ENTRIES) {
    if (normalized.includes(name)) return code;
  }
  return undefined;
}

function isValidUrl(link) {
  if (!link) return false;
  try {
    const u = new URL(link);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

function stripHtml(html) {
  return html.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"').replace(/&#8221;/g, '"').replace(/\s+/g, ' ').trim();
}

function parseRssItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = stripHtml((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const link = stripHtml((block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || '');
    const pubDate = stripHtml((block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || [])[1] || '');
    items.push({ title, link, pubDate });
  }
  return items;
}

function parseAtomEntries(xml) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = stripHtml((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const linkMatch = block.match(/<link[^>]*href=["']([^"']+)["']/i);
    const link = linkMatch ? linkMatch[1] : '';
    const updated = stripHtml((block.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i) || [])[1] || '');
    const published = stripHtml((block.match(/<published[^>]*>([\s\S]*?)<\/published>/i) || [])[1] || '');
    entries.push({ title, link, pubDate: updated || published });
  }
  return entries;
}

function parseFeed(xml) {
  if (xml.includes('<entry>') || xml.includes('<entry ')) return parseAtomEntries(xml);
  return parseRssItems(xml);
}

function rssProxyUrl(feedUrl) {
  const domain = new URL(feedUrl).hostname;
  if (!ALLOWED_DOMAINS.has(domain)) {
    console.warn(`  Skipping disallowed domain: ${domain}`);
    return null;
  }
  return `${RELAY_URL}/rss?url=${encodeURIComponent(feedUrl)}`;
}

async function fetchFeed(feed) {
  const proxyUrl = rssProxyUrl(feed.url);
  if (!proxyUrl) return [];

  try {
    const resp = await fetch(proxyUrl, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      console.warn(`  ${feed.name}: HTTP ${resp.status}`);
      return [];
    }
    const xml = await resp.text();
    const items = parseFeed(xml).slice(0, 15);
    return items
      .filter(item => item.title && isValidUrl(item.link))
      .map(item => ({
        title: item.title,
        link: item.link,
        pubDate: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
        source: feed.name,
        sourceCountry: feed.sourceCountry,
        level: parseLevel(item.title, feed.levelParser),
        country: extractCountry(item.title, feed) || '',
      }));
  } catch (e) {
    console.warn(`  ${feed.name}: ${e.message}`);
    return [];
  }
}

function buildByCountryMap(advisories) {
  const map = {};
  for (const a of advisories) {
    if (!a.country || !a.level || a.level === 'info') continue;
    const existing = map[a.country];
    const rank = { 'do-not-travel': 4, reconsider: 3, caution: 2, normal: 1 };
    if (!existing || (rank[a.level] || 0) > (rank[existing] || 0)) {
      map[a.country] = a.level;
    }
  }
  return map;
}

async function fetchAll() {
  const results = await Promise.allSettled(ADVISORY_FEEDS.map(fetchFeed));
  const all = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') all.push(...r.value);
    else console.warn(`  Feed ${ADVISORY_FEEDS[i]?.name || i} failed: ${r.reason?.message || r.reason}`);
  }

  const seen = new Set();
  const deduped = all.filter(a => {
    const key = a.title.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  deduped.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());

  const byCountry = buildByCountryMap(deduped);
  const report = { byCountry, byCountryName: BY_COUNTRY_NAME, advisories: deduped, fetchedAt: new Date().toISOString() };

  console.log(`  ${deduped.length} advisories, ${Object.keys(byCountry).length} countries with levels`);

  return report;
}

function validate(data) {
  return Array.isArray(data?.advisories) && data.advisories.length > 0;
}

runSeed('intelligence', 'advisories', CANONICAL_KEY, fetchAll, {
  validateFn: validate,
  ttlSeconds: TTL,
  recordCount: (d) => d?.advisories?.length || 0,
  sourceVersion: 'rss-feeds',
  extraKeys: [{ key: BOOTSTRAP_KEY, transform: (d) => d, ttl: TTL }],
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
