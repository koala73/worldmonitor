#!/usr/bin/env node
/**
 * Export a city-focused travel intelligence snapshot.
 *
 * This is a boundary artifact for 01ontology integration: it emits plain JSON
 * and does not import or call ontology code.
 */

import { writeFile } from 'node:fs/promises';

const UA = 'worldmonitor-travel-snapshot/1.0 (+https://worldmonitor.app)';
const DEFAULT_CITY = 'Munich';

export const CITY_PRESETS = {
  Munich: {
    country: 'Germany',
    places: ['Munich', 'München', 'Altstadt', 'Schwabing', 'Maxvorstadt', 'Marienplatz'],
    queries: [
      'Munich travel disruption OR strike OR closure OR weather OR tourist when:7d',
      'München MVG strike closure museum weather tourist when:7d',
      'Munich airport train disruption tourist when:7d',
    ],
  },
};

function googleNewsRss(query) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
}

export function feedsForCity(city = DEFAULT_CITY) {
  const preset = CITY_PRESETS[city] ?? {
    country: '',
    places: [city],
    queries: [`${city} travel disruption closure weather tourist when:7d`],
  };
  return preset.queries.map((query, index) => ({
    name: `${city} Travel ${index + 1}`,
    url: googleNewsRss(query),
    query,
  }));
}

export async function buildTravelSnapshot({
  city = DEFAULT_CITY,
  fetchedAt = new Date().toISOString(),
  fetchText = fetchRssText,
  maxItems = 25,
} = {}) {
  const feeds = feedsForCity(city);
  const items = [];

  for (const feed of feeds) {
    const xml = await fetchText(feed.url, feed);
    if (!xml) continue;
    const parsed = parseRssXml(xml, feed);
    for (const item of parsed) {
      const normalized = normalizeFeedItem(item, {
        city,
        fetchedAt,
        feed,
      });
      if (isTravelRelevant(normalized, city)) items.push(normalized);
      if (items.length >= maxItems) break;
    }
    if (items.length >= maxItems) break;
  }

  return {
    kind: 'worldmonitor_travel_snapshot',
    city,
    provider: 'worldmonitor',
    fetchedAt,
    feedCount: feeds.length,
    itemCount: items.length,
    items,
  };
}

export async function fetchRssText(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/rss+xml, application/xml, text/xml, */*',
      'Accept-Language': 'en-US,en;q=0.9,de;q=0.8',
    },
  });
  if (!response.ok) return '';
  return await response.text();
}

export function parseRssXml(xml, feed = { name: 'RSS', url: '' }) {
  const itemMatches = [...xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)];
  const entryMatches = itemMatches.length ? [] : [...xml.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/gi)];
  const matches = itemMatches.length ? itemMatches : entryMatches;
  const isAtom = itemMatches.length === 0;

  return matches.map((match) => {
    const block = match[1] ?? '';
    const title = cleanXmlText(extractTag(block, 'title'));
    const link = isAtom
      ? cleanXmlText(extractAtomHref(block))
      : cleanXmlText(extractTag(block, 'link'));
    const summary = cleanXmlText(
      extractTag(block, 'description') || extractTag(block, 'summary') || extractTag(block, 'content'),
    );
    const publishedAt = cleanXmlText(
      extractTag(block, 'pubDate') || extractTag(block, 'published') || extractTag(block, 'updated'),
    );
    const source = cleanXmlText(extractTag(block, 'source')) || feed.name;
    return { title, link: safeHttpUrl(link), summary, publishedAt, source, feedName: feed.name };
  }).filter((item) => item.title || item.summary);
}

export function normalizeFeedItem(item, { city = DEFAULT_CITY, fetchedAt, feed } = {}) {
  const detectedPlaces = detectPlaces(`${item.title ?? ''} ${item.summary ?? ''}`, city);
  return {
    title: item.title || '',
    url: item.link || '',
    summary: item.summary || '',
    source: item.source || feed?.name || 'worldmonitor',
    publishedAt: item.publishedAt || '',
    fetchedAt,
    category: 'travel',
    places: detectedPlaces.length ? detectedPlaces : [city],
    feed: feed?.name || '',
    feedUrl: feed?.url || '',
  };
}

export function isTravelRelevant(item, city = DEFAULT_CITY) {
  const text = `${item.title ?? ''} ${item.summary ?? ''} ${(item.places ?? []).join(' ')}`.toLowerCase();
  if (!text.includes(city.toLowerCase()) && !text.includes('münchen')) return false;
  return [
    'travel',
    'tourist',
    'tourism',
    'strike',
    'closure',
    'closed',
    'weather',
    'storm',
    'snow',
    'rain',
    'airport',
    'train',
    'museum',
    'festival',
    'protest',
    'safety',
    'security',
  ].some((token) => text.includes(token));
}

function detectPlaces(text, city = DEFAULT_CITY) {
  const preset = CITY_PRESETS[city];
  const places = preset?.places ?? [city];
  const haystack = text.toLowerCase();
  return places.filter((place) => haystack.includes(place.toLowerCase()));
}

function extractTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match?.[1] ?? '';
}

function extractAtomHref(block) {
  const match = block.match(/<link[^>]+href=["']([^"']+)["']/i);
  return match?.[1] ?? '';
}

function safeHttpUrl(value) {
  return /^https?:\/\//i.test(value) ? value : '';
}

function cleanXmlText(value) {
  return String(value ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parseArgs(argv) {
  const args = { city: DEFAULT_CITY, output: '', maxItems: 25 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--city') args.city = argv[++i] ?? DEFAULT_CITY;
    else if (arg === '--output') args.output = argv[++i] ?? '';
    else if (arg === '--max-items') args.maxItems = Number(argv[++i] ?? '25');
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = await buildTravelSnapshot({ city: args.city, maxItems: args.maxItems });
  const json = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (args.output) {
    await writeFile(args.output, json, 'utf8');
  } else {
    process.stdout.write(json);
  }
}
