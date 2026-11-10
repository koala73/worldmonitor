#!/usr/bin/env node

import { loadEnvFile, loadSharedConfig, CHROME_UA, runSeed } from './_seed-utils.mjs';
import { decodeHtmlEntities } from './_html-entities.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'intelligence:advisories:v1';
const BOOTSTRAP_KEY = 'intelligence:advisories-bootstrap:v1';
const TTL = 10800; // 180min — 2h buffer over 1h cron cadence (was 120min = exactly 1h buffer)
// How many advisories per source are STORED in the news list. This is a
// payload bound, never a coverage bound: buildByCountryMap indexes the full
// fetch, so raising or lowering this cannot change which countries have a
// travel level.
const PER_SOURCE_DISPLAY_LIMIT = 15;
// Travel-advisory feeds are country registers, not sparse event feeds. The US
// and Australian registers each cover far more than 100 countries, so require
// that floor before replacing the last-good global level index. This still
// tolerates normal source differences while rejecting a partial-feed blackout.
export const MIN_ADVISORY_COUNTRY_COVERAGE = 100;
// Two MiB accepts the current ~1.1 MiB State Department register while still
// bounding an allowed upstream's processing and memory use before XML parsing.
export const MAX_ADVISORY_FEED_BYTES = 2 * 1024 * 1024;

const ALLOWED_DOMAINS = new Set(loadSharedConfig('rss-allowed-domains.json'));

const ADVISORY_FEEDS = [
  { name: 'US State Dept', sourceCountry: 'US', sourceCategory: 'travel-advisory', url: 'https://travel.state.gov/_res/rss/TAsTWs.xml', levelParser: 'us' },
  { name: 'Australia DFAT Smartraveller', sourceCountry: 'AU', sourceCategory: 'travel-advisory', url: 'https://www.smartraveller.gov.au/countries/documents/index.rss', levelParser: 'au' },
  { name: 'UK FCDO', sourceCountry: 'UK', sourceCategory: 'travel-advisory', url: 'https://www.gov.uk/foreign-travel-advice.atom', register: 'uk' },
  { name: 'US Embassy Thailand', sourceCountry: 'US', sourceCategory: 'travel-advisory', url: 'https://th.usembassy.gov/category/alert/feed/', targetCountry: 'TH' },
  { name: 'US Embassy UAE', sourceCountry: 'US', sourceCategory: 'travel-advisory', url: 'https://ae.usembassy.gov/category/alert/feed/', targetCountry: 'AE' },
  { name: 'US Embassy Germany', sourceCountry: 'US', sourceCategory: 'travel-advisory', url: 'https://de.usembassy.gov/category/alert/feed/', targetCountry: 'DE' },
  { name: 'US Embassy Ukraine', sourceCountry: 'US', sourceCategory: 'travel-advisory', url: 'https://ua.usembassy.gov/category/alert/feed/', targetCountry: 'UA' },
  { name: 'US Embassy Mexico', sourceCountry: 'US', sourceCategory: 'travel-advisory', url: 'https://mx.usembassy.gov/category/alert/feed/', targetCountry: 'MX' },
  { name: 'US Embassy India', sourceCountry: 'US', sourceCategory: 'travel-advisory', url: 'https://in.usembassy.gov/category/alert/feed/', targetCountry: 'IN' },
  { name: 'US Embassy Pakistan', sourceCountry: 'US', sourceCategory: 'travel-advisory', url: 'https://pk.usembassy.gov/category/alert/feed/', targetCountry: 'PK' },
  { name: 'US Embassy Colombia', sourceCountry: 'US', sourceCategory: 'travel-advisory', url: 'https://co.usembassy.gov/category/alert/feed/', targetCountry: 'CO' },
  { name: 'US Embassy Poland', sourceCountry: 'US', sourceCategory: 'travel-advisory', url: 'https://pl.usembassy.gov/category/alert/feed/', targetCountry: 'PL' },
  { name: 'US Embassy Bangladesh', sourceCountry: 'US', sourceCategory: 'travel-advisory', url: 'https://bd.usembassy.gov/category/alert/feed/', targetCountry: 'BD' },
  { name: 'US Embassy Italy', sourceCountry: 'US', sourceCategory: 'travel-advisory', url: 'https://it.usembassy.gov/category/alert/feed/', targetCountry: 'IT' },
  { name: 'US Embassy Dominican Republic', sourceCountry: 'US', sourceCategory: 'travel-advisory', url: 'https://do.usembassy.gov/category/alert/feed/', targetCountry: 'DO' },
  { name: 'US Embassy Myanmar', sourceCountry: 'US', sourceCategory: 'travel-advisory', url: 'https://mm.usembassy.gov/category/alert/feed/', targetCountry: 'MM' },
  { name: 'CDC Travel Notices', sourceCountry: 'US', sourceCategory: 'health', url: 'https://wwwnc.cdc.gov/travel/rss/notices.xml', register: 'cdc' },
  { name: 'ECDC Epidemiological Updates', sourceCountry: 'EU', sourceCategory: 'health', url: 'https://www.ecdc.europa.eu/en/taxonomy/term/1310/feed' },
  { name: 'ECDC Threats Report', sourceCountry: 'EU', sourceCategory: 'health', url: 'https://www.ecdc.europa.eu/en/taxonomy/term/1505/feed' },
  { name: 'ECDC Risk Assessments', sourceCountry: 'EU', sourceCategory: 'health', url: 'https://www.ecdc.europa.eu/en/taxonomy/term/1295/feed' },
  { name: 'ECDC Avian Influenza', sourceCountry: 'EU', sourceCategory: 'health', url: 'https://www.ecdc.europa.eu/en/taxonomy/term/323/feed' },
  { name: 'ECDC Publications', sourceCountry: 'EU', sourceCategory: 'health', url: 'https://www.ecdc.europa.eu/en/taxonomy/term/1244/feed' },
  { name: 'WHO News', sourceCountry: 'INT', sourceCategory: 'health', url: 'https://www.who.int/rss-feeds/news-english.xml' },
  { name: 'WHO Africa Emergencies', sourceCountry: 'INT', sourceCategory: 'health', url: 'https://www.afro.who.int/rss/emergencies.xml' },
];

const RELAY_URL = process.env.RELAY_URL || 'https://proxy.worldmonitor.app';

export function parseUsLevel(title) {
  const m = title.match(/Level (\d)/i);
  if (!m) return 'info';
  return { '4': 'do-not-travel', '3': 'reconsider', '2': 'caution', '1': 'normal' }[m[1]] || 'info';
}

// Smartraveller publishes each destination's overall advice twice inside
// <ta:warnings>: as a label (<dc:description>) and as <ta:level>N/5</ta:level>.
// The five-point scale counts "No travel advice" as 1/5, so the four advice
// levels are 2/5..5/5 (checked against the live feed 2026-10-23: 2/5 "Exercise
// normal safety precautions" ... 5/5 "Do not travel"). The label is read first
// because it names the level outright. A bare number names no scale, so it
// falls through to the item text rather than being guessed.
const AU_ADVICE_LABELS = [
  ['do not travel', 'do-not-travel'],
  ['reconsider your need to travel', 'reconsider'],
  ['exercise a high degree of caution', 'caution'],
  ['exercise normal safety precautions', 'normal'],
];
const AU_FIVE_POINT_LEVELS = { '5': 'do-not-travel', '4': 'reconsider', '3': 'caution', '2': 'normal' };

export function parseAuLevel(item) {
  const label = String(item.advisoryLabel || '').trim().toLowerCase();
  for (const [text, level] of AU_ADVICE_LABELS) {
    if (label === text) return level;
  }
  const fivePoint = String(item.advisoryLevel || '').trim().match(/^([1-5])\/5$/);
  if (fivePoint) return AU_FIVE_POINT_LEVELS[fivePoint[1]] || 'info';

  const l = `${item.title || ''} ${item.description || ''}`.toLowerCase();
  if (l.includes('do not travel')) return 'do-not-travel';
  if (l.includes('reconsider')) return 'reconsider';
  if (l.includes('high degree of caution') || l.includes('high degree')) return 'caution';
  if (l.includes('normal safety precautions') || l.includes('normal precautions')) return 'normal';
  return 'info';
}

function parseLevel(item, parser) {
  if (parser === 'us') return parseUsLevel(item.title || '');
  if (parser === 'au') return parseAuLevel(item);
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
  // Apostrophes are deleted, not spaced: the country keys spell
  // "democratic peoples republic of korea", and a space left "republic of
  // korea" (KR) as the longest match for Smartraveller's North Korea title.
  const normalized = title.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase()
    .replace(/['\u2019]/g, '').replace(/[.(),/-]/g, ' ').replace(/\s+/g, ' ');
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
  const stripped = html.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '');
  return decodeHtmlEntities(stripped).replace(/\s+/g, ' ').trim();
}

export function parseRssItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = stripHtml((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const link = stripHtml((block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || '');
    const description = stripHtml((block.match(/<description[^>]*>([\s\S]*?)<\/description>/i) || [])[1] || '');
    const pubDate = stripHtml((block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || [])[1] || '');
    const advisoryLevel = stripHtml((block.match(/<ta:level[^>]*>([\s\S]*?)<\/ta:level>/i) || [])[1] || '');
    const warnings = (block.match(/<ta:warnings[^>]*>([\s\S]*?)<\/ta:warnings>/i) || [])[1] || '';
    const advisoryLabel = stripHtml((warnings.match(/<dc:description>([\s\S]*?)<\/dc:description>/i) || [])[1] || '');
    items.push({ title, link, description, pubDate, advisoryLevel, advisoryLabel });
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
    const description = stripHtml((block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i) || [])[1] || '');
    const updated = stripHtml((block.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i) || [])[1] || '');
    const published = stripHtml((block.match(/<published[^>]*>([\s\S]*?)<\/published>/i) || [])[1] || '');
    entries.push({ title, link, description, pubDate: updated || published });
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

export async function readBoundedFeedText(response, maxBytes = MAX_ADVISORY_FEED_BYTES) {
  const advertisedLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
    try { await response.body?.cancel?.(); } catch { /* reject even if cancellation fails */ }
    throw new Error('RESPONSE_TOO_LARGE');
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('RESPONSE_TOO_LARGE');
    return text;
  }

  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

// `doFetch` is injectable so a test can drive this whole path — including the
// no-truncation guarantee below — without network access.
export async function fetchFeed(feed, doFetch = fetch) {
  const proxyUrl = rssProxyUrl(feed.url);
  if (!proxyUrl) return [];

  try {
    const resp = await doFetch(proxyUrl, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      console.warn(`  ${feed.name}: HTTP ${resp.status}`);
      return [];
    }
    const xml = await readBoundedFeedText(resp);
    // There is no item-count cut here: truncating before the country index is
    // built made the US State Dept register — one standing advisory per
    // country, ~219 items — contribute only its first 15 countries. The
    // bounded source read above protects processing resources; fetchAll bounds
    // what gets STORED instead.
    return mapFeedItems(parseFeed(xml), feed);
  } catch (e) {
    console.warn(`  ${feed.name}: ${e.message}`);
    return [];
  }
}

// Smartraveller stamps every item in Canberra time ("20 Oct 2026 23:00:00
// AEDT"), and Date does not know those zone names. Unparseable dates used to
// throw from toISOString() and drop the whole feed; they now fall back to the
// fetch time, the same as an item with no date.
const ZONE_OFFSETS = { AEST: '+1000', AEDT: '+1100' };

function parseFeedDate(pubDate) {
  const normalized = String(pubDate || '').trim().replace(/\b(AEST|AEDT)$/, (zone) => ZONE_OFFSETS[zone]);
  const parsed = normalized ? new Date(normalized) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function toIsoDate(pubDate) {
  return parseFeedDate(pubDate) ?? new Date().toISOString();
}

// Carried on a register item until fetchAll has built the per-register index,
// then stripped from the stored news list. It is the feed's own date, or ''
// when the feed gave none: the fetch-time fallback in `pubDate` would publish
// "updated today" for an advisory nobody touched.
const REGISTER_UPDATED_FIELD = '_registerUpdatedAt';

/**
 * Normalise one feed's raw items into advisory records.
 *
 * Retains every item from a bounded source response: the country-level index
 * must see everything a register feed publishes, while fetchAll decides how
 * many records to store in the news list.
 */
export function mapFeedItems(items, feed) {
  return items
    .filter(item => item.title && isValidUrl(item.link))
    .map(item => ({
      title: item.title,
      link: item.link,
      pubDate: toIsoDate(item.pubDate),
      source: feed.name,
      sourceCountry: feed.sourceCountry,
      level: parseLevel(item, feed.levelParser),
      country: extractCountry(item.title, feed) || '',
      ...(feed.levelParser || feed.register === 'cdc' ? { [REGISTER_UPDATED_FIELD]: parseFeedDate(item.pubDate) ?? '' } : {}),
    }));
}

const LEVEL_RANK = { 'do-not-travel': 4, reconsider: 3, caution: 2, normal: 1 };

/**
 * Each government register's own level per country, for pages that show the
 * US and Australian advice side by side. `byCountry` keeps the stricter of the
 * two and cannot say whose advice it is. A register that lists a country twice
 * keeps its most recently dated entry.
 *
 * Entries keep the advisory item shape, so the RPC reuses SecurityAdvisoryItem
 * (public/openapi.json has no room for a second schema). Unlike the news list,
 * `pubDate` is the feed's own date or '' when it gave none.
 */
export function buildRegisterLevels(feeds, itemsByFeed) {
  const byKey = new Map();
  feeds.forEach((feed, i) => {
    if (!feed.levelParser) return;
    for (const item of itemsByFeed[i] || []) {
      if (!item.country || !LEVEL_RANK[item.level]) continue;
      const entry = {
        title: item.title,
        link: item.link,
        pubDate: item[REGISTER_UPDATED_FIELD] || '',
        source: feed.name,
        sourceCountry: feed.sourceCountry,
        level: item.level,
        country: item.country,
      };
      const key = `${entry.sourceCountry}:${entry.country}`;
      const existing = byKey.get(key);
      if (!existing || entry.pubDate > existing.pubDate) byKey.set(key, entry);
    }
  });
  return [...byKey.values()].sort((a, b) =>
    a.sourceCountry.localeCompare(b.sourceCountry) || a.country.localeCompare(b.country));
}

// The FCDO's Atom feed lists only recently edited pages and carries no
// warning. Each destination's warning is `details.alert_status` on its GOV.UK
// Content API page: zero or more of these four, strongest first. A register
// row's level joins the ones present with '+', or is 'none'.
export const UK_ALERTS = Object.freeze({
  avoid_all_travel_to_whole_country: 'all-whole',
  avoid_all_but_essential_travel_to_whole_country: 'essential-whole',
  avoid_all_travel_to_parts: 'all-parts',
  avoid_all_but_essential_travel_to_parts: 'essential-parts',
});
const UK_INDEX_URL = 'https://www.gov.uk/api/content/foreign-travel-advice';
// The FCDO lists ~226 destinations. Fewer means the index was cut short.
export const MIN_UK_DESTINATIONS = 150;
// FCDO names that are not a country-names.json key. Overseas departments and
// territories the registry has no code for (Réunion, St Maarten, ...) are
// skipped rather than folded into France or the Netherlands.
const UK_NAME_CODES = Object.freeze({
  'myanmar burma': 'MM',
  'antarctica british antarctic territory': 'AQ',
  'cook islands tokelau and niue': 'CK',
  'south georgia and the south sandwich islands': 'GS',
  macao: 'MO',
});

function normalizeName(name) {
  return String(name).normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase()
    .replace(/['’]/g, '').replace(/[.(),/&-]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The register level for one destination's alert_status, or null for a value this parser does not know. */
export function ukLevel(alertStatus) {
  if (!Array.isArray(alertStatus)) return null;
  if (alertStatus.some((alert) => !Object.hasOwn(UK_ALERTS, alert))) return null;
  const present = Object.keys(UK_ALERTS).filter((alert) => alertStatus.includes(alert)).map((alert) => UK_ALERTS[alert]);
  return present.length ? present.join('+') : 'none';
}

function codeFor(table, name) {
  const code = Object.hasOwn(table, name) ? table[name] : '';
  return /^[A-Z]{2}$/.test(code) ? code : '';
}

function countryNameCode(normalized) {
  return codeFor(COUNTRY_NAMES, normalized) || codeFor(COUNTRY_NAMES, normalized.replace(/^the /, ''));
}

export function ukCountryCode(name) {
  const normalized = normalizeName(name);
  return codeFor(UK_NAME_CODES, normalized) || countryNameCode(normalized);
}

async function getJson(url, doFetch, deadlineAtMs) {
  for (let attempt = 0; ; attempt += 1) {
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) throw new Error('ran out of time');
    try {
      const resp = await doFetch(url, {
        headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(Math.min(15_000, remainingMs)),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return JSON.parse(await readBoundedFeedText(resp));
    } catch (error) {
      if (attempt >= 1) throw error;
    }
  }
}

const UK_BUDGET_MS = 120_000;
// Leaves the seed time to publish the other registers after the UK read gives up.
const UK_DEADLINE_MARGIN_MS = 30_000;

/**
 * The FCDO's warning for every destination it lists, as register rows. All or
 * nothing: a destination that failed to load would read as "no UK advice", so
 * any failure, or running past deadlineAtMs, returns [] and source health
 * reports the UK register missing.
 */
export async function fetchUkRegister(doFetch = fetch, deadlineAtMs = Date.now() + UK_BUDGET_MS) {
  try {
    const index = await getJson(UK_INDEX_URL, doFetch, deadlineAtMs);
    const pages = (index?.links?.children || []).filter((child) => typeof child?.base_path === 'string' && child.base_path.startsWith('/foreign-travel-advice/'));
    if (pages.length < MIN_UK_DESTINATIONS) throw new Error(`index lists ${pages.length} destinations`);
    const rows = new Array(pages.length);
    let next = 0;
    let failed = false;
    const worker = async () => {
      while (next < pages.length && !failed) {
        const i = next++;
        const page = pages[i];
        const doc = await getJson(`https://www.gov.uk/api/content${page.base_path}`, doFetch, deadlineAtMs).catch((error) => {
          failed = true;
          throw error;
        });
        const name = doc?.details?.country?.name || page.details?.country?.name || doc?.title || '';
        const level = ukLevel(doc?.details?.alert_status ?? []);
        if (!level) throw new Error(`${page.base_path}: unknown alert_status ${JSON.stringify(doc?.details?.alert_status)}`);
        rows[i] = {
          title: name,
          link: `https://www.gov.uk${page.base_path}`,
          pubDate: parseFeedDate(doc?.public_updated_at) ?? '',
          source: 'UK FCDO',
          sourceCountry: 'UK',
          level,
          country: ukCountryCode(name),
        };
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    const coded = rows.filter((row) => row.country);
    // Two destinations can share a code (none do today); keep the stricter.
    const byCode = new Map();
    for (const row of coded) {
      const existing = byCode.get(row.country);
      if (!existing || ukSeverity(row.level) > ukSeverity(existing.level)) byCode.set(row.country, row);
    }
    return [...byCode.values()].sort((a, b) => a.country.localeCompare(b.country));
  } catch (error) {
    console.warn(`  UK FCDO register: ${error.message}`);
    return [];
  }
}

const UK_SEVERITY = { 'all-whole': 4, 'essential-whole': 3, 'all-parts': 2, 'essential-parts': 1 };
function ukSeverity(level) {
  return UK_SEVERITY[level.split('+')[0]] || 0;
}

// CDC titles read "Level N - <disease> in <places>", where places can list
// several countries ("Burkina Faso, Côte d’Ivoire, and Ghana") or name a
// region of one ("Ituri and Nord-Kivu Provinces of the Democratic Republic of
// the Congo"). Global and regional notices ("Global Dengue", "Sub-Saharan
// Africa") name no country and are not tied to one.
const CDC_TITLE = /^Level ([1-4]) - .+? in (.+)$/;

function regionOfCountryCode(normalized) {
  const entry = SORTED_COUNTRY_ENTRIES.find(([name]) => normalized.endsWith(` of the ${name}`) || normalized.endsWith(` of ${name}`));
  return entry && /^[A-Z]{2}$/.test(entry[1]) ? entry[1] : '';
}

export function cdcNoticeCountries(title) {
  const match = String(title).trim().match(CDC_TITLE);
  if (!match) return { level: '', countries: [] };
  const codes = [];
  const add = (code) => {
    if (code && !codes.includes(code)) codes.push(code);
  };
  // "and" both joins list items and belongs to names ("Trinidad and Tobago"),
  // so each comma piece takes the longest run of parts that is a country name.
  for (const piece of match[2].split(/,\s*(?:and\s+)?/)) {
    const parts = normalizeName(piece).split(' and ');
    let i = 0;
    while (i < parts.length) {
      const runs = [];
      for (let j = parts.length; j > i; j -= 1) runs.push([j, parts.slice(i, j).join(' and ')]);
      const exact = runs.find(([, name]) => countryNameCode(name));
      const found = exact
        ? [exact[0], countryNameCode(exact[1])]
        : runs.map(([j, name]) => [j, regionOfCountryCode(name)]).find(([, code]) => code);
      if (found) add(found[1]);
      i = found ? found[0] : i + 1;
    }
  }
  return { level: `cdc-${match[1]}`, countries: codes };
}

/** One register row per country a CDC travel health notice names. */
export function cdcRegisterRows(items) {
  const rows = [];
  for (const item of items) {
    const { level, countries } = cdcNoticeCountries(item.title);
    for (const country of countries) {
      rows.push({ title: item.title, link: item.link, pubDate: item[REGISTER_UPDATED_FIELD] || '', source: item.source, sourceCountry: item.sourceCountry, level, country });
    }
  }
  return rows.sort((a, b) => a.country.localeCompare(b.country) || b.pubDate.localeCompare(a.pubDate));
}

function withoutRegisterDate({ [REGISTER_UPDATED_FIELD]: _updatedAt, ...advisory }) {
  return advisory;
}

/**
 * Bound the STORED advisory list to `limit` per source, preserving input order
 * (callers sort by recency first). This is the news list's bound only — the
 * country-level index is built from the full set, because one cap cannot serve
 * both a "latest N headlines" list and a complete per-country register.
 */
export function capPerSource(advisories, limit) {
  const kept = [];
  const counts = new Map();
  for (const a of advisories) {
    const n = counts.get(a.source) ?? 0;
    if (n >= limit) continue;
    counts.set(a.source, n + 1);
    kept.push(a);
  }
  return kept;
}

export function buildByCountryMap(advisories) {
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

// Pre-publish diagnostics carried on the fetched report. advisoryPublishTransform
// strips them from both stored keys; advisoryAfterPublish copies them onto
// seed-meta, where api/health.js reads sourceState and errorCode.
export const ADVISORY_SOURCE_HEALTH_FIELD = '_sourceHealth';

// A travel register (a feed with a levelParser) is missing when it contributed
// no levelled country: an HTTP failure, an empty body, and a format change that
// leaves every item at 'info' all look the same to byCountry. The seed still
// publishes while the other register clears MIN_ADVISORY_COUNTRY_COVERAGE, so
// this is what keeps a one-register index from reading as healthy.
function summarizeSourceHealth(feeds, itemsByFeed, ukRows) {
  const missingRegisters = [];
  const emptyFeeds = [];
  feeds.forEach((feed, i) => {
    const items = itemsByFeed[i];
    if (items.length === 0) emptyFeeds.push(feed.name);
    if (feed.levelParser && !items.some((a) => a.country && a.level && a.level !== 'info')) {
      missingRegisters.push(feed.sourceCountry);
    }
    if (feed.register === 'uk' && ukRows.length === 0) missingRegisters.push(feed.sourceCountry);
  });
  return { missingRegisters: [...new Set(missingRegisters)].sort(), emptyFeeds };
}

export function advisoryPublishTransform(data) {
  const { [ADVISORY_SOURCE_HEALTH_FIELD]: _diagnostics, ...published } = data || {};
  return published;
}

// The dashboard bootstrap reads `advisories` and `byCountry` only. The
// per-register levels (~400 rows) serve /tools/travel-advisory-map/ through
// the canonical key and stay out of every dashboard's startup payload.
export function advisoryBootstrapTransform(data) {
  const { registerLevels: _registerLevels, ...bootstrap } = advisoryPublishTransform(data);
  return bootstrap;
}

export async function advisoryAfterPublish(data) {
  const { missingRegisters = [], emptyFeeds = [] } = data?.[ADVISORY_SOURCE_HEALTH_FIELD] || {};
  if (missingRegisters.length === 0) {
    // Explicit undefineds: a validation skip merges the previous seed-meta's
    // diagnostics under this patch, so a recovery must clear the old failure.
    return { freshnessMetaPatch: { sourceState: 'ok', errorCode: undefined, failedSources: undefined, emptyFeeds } };
  }
  return {
    freshnessMetaPatch: {
      sourceState: 'degraded',
      errorCode: `ADVISORY_REGISTER_MISSING_${missingRegisters.join('_')}`,
      failedSources: missingRegisters,
      emptyFeeds,
    },
  };
}

export async function fetchAll({ feeds = ADVISORY_FEEDS, doFetch = fetch, fetchDeadlineAtMs } = {}) {
  const ukDeadline = Math.min(Date.now() + UK_BUDGET_MS, (fetchDeadlineAtMs ?? Infinity) - UK_DEADLINE_MARGIN_MS);
  const ukRegister = feeds.some((feed) => feed.register === 'uk') ? fetchUkRegister(doFetch, ukDeadline) : Promise.resolve([]);
  const results = await Promise.allSettled(feeds.map((feed) => fetchFeed(feed, doFetch)));
  const ukRows = await ukRegister;
  const all = [];
  const itemsByFeed = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    itemsByFeed.push(r.status === 'fulfilled' ? r.value : []);
    if (r.status === 'fulfilled') all.push(...r.value);
    else console.warn(`  Feed ${feeds[i]?.name || i} failed: ${r.reason?.message || r.reason}`);
  }
  const sourceHealth = summarizeSourceHealth(feeds, itemsByFeed, ukRows);
  if (sourceHealth.missingRegisters.length > 0) {
    console.warn(`  Travel registers with no levelled country: ${sourceHealth.missingRegisters.join(', ')}`);
  }

  const seen = new Set();
  const deduped = all.filter(a => {
    const key = a.title.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  deduped.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());

  // Index from EVERYTHING fetched; store a bounded slice. The two have
  // different jobs: `byCountry` answers "what is the travel level for X" and
  // must be complete, while `advisories` is a recency-ordered news list whose
  // size is a payload concern.
  const byCountry = buildByCountryMap(deduped);
  const advisories = capPerSource(deduped, PER_SOURCE_DISPLAY_LIMIT).map(withoutRegisterDate);
  const report = {
    byCountry,
    byCountryName: BY_COUNTRY_NAME,
    // Built per feed, before the cross-feed title dedupe: each register's
    // entry for a country stands on its own. The UK warnings and the CDC's
    // health notices use their own scales and stay out of byCountry.
    registerLevels: [
      ...buildRegisterLevels(feeds, itemsByFeed),
      ...ukRows,
      ...cdcRegisterRows(feeds.flatMap((feed, i) => (feed.register === 'cdc' ? itemsByFeed[i] : []))),
    ],
    advisories,
    fetchedAt: new Date().toISOString(),
    [ADVISORY_SOURCE_HEALTH_FIELD]: sourceHealth,
  };

  console.log(`  ${advisories.length} advisories stored (${deduped.length} fetched), ${Object.keys(byCountry).length} countries with levels`);

  return report;
}

// `advisories.length > 0` alone is not enough. The ~20 health and news feeds
// (WHO, CDC, ECDC, embassy bulletins) emit `level: 'info'`, which
// buildByCountryMap skips, so they satisfy that bound while contributing
// nothing to the level index. When the travel-advisory feeds failed and the
// news feeds did not, the seed published a report with an empty `byCountry` and
// production served `advisoryLevel: ""` for every country — the same symptom
// this file's header describes, recurring because the earlier fix addressed the
// truncation CAUSE and left the OUTCOME unguarded (#7530).
//
// `byCountry` is the reason this key exists: it is the sole source of
// GetCountryRiskResponse.advisoryLevel and of the CII scorer's advisory input.
// A report without one must fail the seed so the previous value lives out its
// TTL, rather than publishing an index that blanks every advisory tile.
export function validateAdvisoryReport(data) {
  if (!Array.isArray(data?.advisories) || data.advisories.length === 0) return false;
  const byCountry = data.byCountry;
  if (!byCountry || typeof byCountry !== 'object' || Array.isArray(byCountry)) return false;
  return Object.keys(byCountry).length >= MIN_ADVISORY_COUNTRY_COVERAGE;
}

export function declareRecords(data) {
  return Array.isArray(data?.advisories) ? data.advisories.length : 0;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ''));
if (isMain) {
  runSeed('intelligence', 'advisories', CANONICAL_KEY, fetchAll, {
    validateFn: validateAdvisoryReport,
    ttlSeconds: TTL,
    recordCount: (d) => d?.advisories?.length || 0,
    sourceVersion: 'rss-feeds',
    publishTransform: advisoryPublishTransform,
    afterPublish: advisoryAfterPublish,
    // A rejected report (no register cleared the coverage floor) skips the
    // publish; this replaces the previous run's sourceState instead of
    // carrying it forward onto the mirrored seed-meta.
    afterValidationSkip: advisoryAfterPublish,
    extraKeys: [{ key: BOOTSTRAP_KEY, transform: advisoryBootstrapTransform, ttl: TTL, declareRecords }],

    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 120,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
