import { decodeHtmlEntities } from './_html-entities.mjs';
// Pure, import-safe shared parser: accepts both the published compact seendate
// and the ISO form legacy snapshots carry, so the article window/sort survives
// the format change (#5863 review).
import { gdeltSeenDateToMs } from './_conflict-gdelt.mjs';
// Pure data, no imports: this file's source is a `make generate` input, so
// its import closure is a proto-freshness input too (#7748 review).
import { GDELT_FIPS_TO_ISO2 } from './_gdelt-country-codes.mjs';
import { inflateRawSync } from 'node:zlib';

const GDELT_STORAGE_ORIGIN = 'https://storage.googleapis.com/data.gdeltproject.org';
const ARTICLE_WINDOW_MS = 24 * 60 * 60 * 1000;
const TIMELINE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ARTICLES_PER_TOPIC = 10;
// Per-country article index (#7748). The crawlable corpus freezes weekly, and
// a small country may see one English article a week, so the window is a
// week rather than the topics' day. Ten rows per country bound the key at
// roughly 250 countries x 10 rows x ~250 bytes, far under the 5MB write
// ceiling; the read side (freeze, search route) keeps at most five.
export const GDELT_COUNTRY_INDEX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_ARTICLES_PER_COUNTRY = 10;
// A record naming more countries than this is a roundup ("Pacific leaders
// meet"). It is indexed under its primary country only: filing it under every
// country it names would hand each small country the same unrelated story,
// the contamination class that put a UN world-map vote on Togo's page.
const MAX_COUNTRIES_PER_INDEXED_RECORD = 3;
const MAX_INDEX_TITLE_CHARS = 200;
// A URL is a link, not text: it cannot be truncated, so an over-long one is
// refused. Bounds the key's worst case (the 5MB write ceiling) against a
// tail of tracking-parameter URLs that would otherwise persist for a week.
const MAX_INDEX_URL_CHARS = 512;
const MAX_SOURCE_URLS = 5;
const MAX_GKG_ZIP_BYTES = 15_000_000;
// A real 15-minute GKG cohort measures ~17.7MB uncompressed (5.7MB zipped,
// measured 2026-07-30). 40MB keeps >2x headroom for spike days while cutting
// the worst-case catch-up footprint (8 files at concurrency 4) from ~400MB to
// ~160MB — the exit-137 class this cap exists to bound (#5864).
const MAX_GKG_CSV_BYTES = 40_000_000;
const MAX_EXPORT_ZIP_BYTES = 5_000_000;
const MAX_EXPORT_CSV_BYTES = 30_000_000;

export const GDELT_BULK_TOPICS = Object.freeze([
  {
    id: 'military',
    pattern: /\b(?:MILITARY|ARMEDCONFLICT|AIRSTRIKE|NAVAL|TROOP|WARFARE|DEFENSE)\b/i,
  },
  {
    id: 'cyber',
    pattern: /\b(?:CYBER(?:_ATTACK|_SECURITY)?|RANSOMWARE|HACKING|DATA BREACH|APT)\b/i,
  },
  {
    id: 'nuclear',
    pattern: /\b(?:NUCLEAR|URANIUM|IAEA|PLUTONIUM|WMD)\b/i,
  },
  {
    id: 'sanctions',
    pattern: /\b(?:SANCTIONS?|EMBARGO|TRADE WAR|TARIFF|ECONOMIC PRESSURE)\b/i,
  },
  {
    id: 'intelligence',
    pattern: /\b(?:INTELLIGENCE|ESPIONAGE|SPY|COVERT|SURVEILLANCE)\b/i,
  },
  {
    id: 'maritime',
    pattern: /\b(?:MARITIME|NAVAL|PIRACY|BLOCKADE|WARSHIP|HORMUZ|SOUTH CHINA SEA)\b/i,
  },
]);

const UNREST_THEMES = new Set(['PROTEST', 'STRIKE', 'VIOLENT_UNREST']);
const POSITIVE_THEMES = new Set([
  'SOC_INNOVATION',
  'EDUCATION',
  'MEDICAL',
  'TOURISM',
  'WB_1765_CULTURE_HERITAGE_AND_SUSTAINABLE_TOURISM',
  'PEACEKEEPING',
]);

export function isGdeltGeoMaterializationRecord(record) {
  if (!Array.isArray(record?.themes) || !Array.isArray(record?.locations)) return false;
  if (record.themes.some((theme) => UNREST_THEMES.has(theme))) return true;
  return record.tone > 2 && record.themes.some((theme) => POSITIVE_THEMES.has(theme));
}

// Keep in sync with CATEGORY_KEYWORDS in src/services/positive-classifier.ts —
// the two lists have ALREADY diverged (the TS copy carries extra terms such as
// 'therapy', 'cancer', 'disease', 'reef'), so identical source text can be
// labelled differently by the producer and the client classifier (#5864).
const POSITIVE_CATEGORY_KEYWORDS = [
  ['clinical trial', 'science-health'], ['study finds', 'science-health'],
  ['researchers', 'science-health'], ['scientists', 'science-health'],
  ['breakthrough', 'science-health'], ['discovery', 'science-health'],
  ['cure', 'science-health'], ['vaccine', 'science-health'],
  ['treatment', 'science-health'], ['medical', 'science-health'],
  ['endangered species', 'nature-wildlife'], ['conservation', 'nature-wildlife'],
  ['wildlife', 'nature-wildlife'], ['species', 'nature-wildlife'],
  ['marine', 'nature-wildlife'], ['forest', 'nature-wildlife'],
  ['renewable', 'climate-wins'], ['solar', 'climate-wins'],
  ['wind energy', 'climate-wins'], ['electric vehicle', 'climate-wins'],
  ['emissions', 'climate-wins'], ['carbon', 'climate-wins'],
  ['clean energy', 'climate-wins'], ['climate', 'climate-wins'],
  ['robot', 'innovation-tech'], ['technology', 'innovation-tech'],
  ['startup', 'innovation-tech'], ['innovation', 'innovation-tech'],
  ['artificial intelligence', 'innovation-tech'],
  ['volunteer', 'humanity-kindness'], ['donated', 'humanity-kindness'],
  ['charity', 'humanity-kindness'], ['rescued', 'humanity-kindness'],
  ['hero', 'humanity-kindness'], ['kindness', 'humanity-kindness'],
  [' art ', 'culture-community'], ['music', 'culture-community'],
  ['festival', 'culture-community'], ['education', 'culture-community'],
];

function boundedPositiveInteger(value, label, max) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`invalid GDELT ${label}: ${value}`);
  }
  return parsed;
}

function parseDescriptor(line) {
  const [sizeRaw, md5Raw, urlRaw, ...extra] = line.split(/\s+/);
  if (!sizeRaw || !md5Raw || !urlRaw || extra.length) {
    throw new Error('malformed GDELT bulk manifest line');
  }
  const md5 = md5Raw.toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(md5)) throw new Error('invalid GDELT bulk checksum');

  const url = new URL(urlRaw);
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'data.gdeltproject.org' || url.port) {
    throw new Error(`untrusted GDELT bulk URL: ${urlRaw}`);
  }
  const match = url.pathname.match(
    /^\/gdeltv2\/(\d{14})\.(gkg\.csv|export\.CSV)\.zip$/,
  );
  if (!match || url.search || url.hash) throw new Error(`invalid GDELT bulk path: ${urlRaw}`);
  const kind = match[2].toLowerCase().startsWith('gkg') ? 'gkg' : 'export';
  const maxBytes = kind === 'gkg' ? 15_000_000 : 5_000_000;
  return {
    kind,
    timestamp: match[1],
    size: boundedPositiveInteger(sizeRaw, `${kind} ZIP size`, maxBytes),
    md5,
    url: `${GDELT_STORAGE_ORIGIN}${url.pathname}`,
  };
}

export function parseGdeltBulkDescriptors(
  manifest,
  { afterTimestamp = '', maxPerKind = 8 } = {},
) {
  const byKind = { gkg: [], export: [] };
  for (const rawLine of String(manifest || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/\.(?:gkg\.csv|export\.CSV)\.zip$/i.test(line)) continue;
    let descriptor;
    try {
      descriptor = parseDescriptor(line);
    } catch (error) {
      // A suffix-range response starts at an arbitrary byte and therefore its
      // first line is often truncated. Ignore only that incomplete fragment;
      // a full-looking descriptor still fails closed on bad size/hash/origin.
      if (!/^\d+\s+[a-f0-9]{32}\s+/i.test(line)) continue;
      throw error;
    }
    const kindCursor = typeof afterTimestamp === 'object'
      ? afterTimestamp?.[descriptor.kind]
      : afterTimestamp;
    if (kindCursor && descriptor.timestamp <= kindCursor) continue;
    byKind[descriptor.kind].push(descriptor);
  }
  return Object.values(byKind)
    .flatMap((descriptors) => descriptors
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .slice(-Math.max(1, maxPerKind)))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp)
      || a.kind.localeCompare(b.kind) * -1);
}

export function extractGdeltBulkCsv(zipBytes, descriptor) {
  const zip = Buffer.isBuffer(zipBytes) ? zipBytes : Buffer.from(zipBytes || []);
  if (zip.length < 30 || zip.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('invalid GDELT bulk ZIP header');
  }
  const flags = zip.readUInt16LE(6);
  if (flags & 0x1) throw new Error('encrypted GDELT bulk ZIP is unsupported');
  if (flags & 0x8) throw new Error('streaming GDELT bulk ZIP is unsupported');

  const maxZipBytes = descriptor.kind === 'gkg' ? MAX_GKG_ZIP_BYTES : MAX_EXPORT_ZIP_BYTES;
  const maxCsvBytes = descriptor.kind === 'gkg' ? MAX_GKG_CSV_BYTES : MAX_EXPORT_CSV_BYTES;
  const method = zip.readUInt16LE(8);
  const compressedSize = boundedPositiveInteger(
    zip.readUInt32LE(18),
    'bulk ZIP compressed size',
    maxZipBytes,
  );
  const uncompressedSize = boundedPositiveInteger(
    zip.readUInt32LE(22),
    'bulk ZIP uncompressed size',
    maxCsvBytes,
  );
  const filenameLength = zip.readUInt16LE(26);
  const extraLength = zip.readUInt16LE(28);
  const dataStart = 30 + filenameLength + extraLength;
  const dataEnd = dataStart + compressedSize;
  if (dataStart > zip.length || dataEnd > zip.length) {
    throw new Error('truncated GDELT bulk ZIP');
  }

  const suffix = descriptor.kind === 'gkg' ? 'gkg.csv' : 'export.CSV';
  const expectedFilename = `${descriptor.timestamp}.${suffix}`;
  const filename = zip.subarray(30, 30 + filenameLength).toString('utf8');
  if (filename !== expectedFilename) {
    throw new Error(`unexpected GDELT bulk filename: ${filename}`);
  }
  const compressed = zip.subarray(dataStart, dataEnd);
  const csv = method === 8
    ? inflateRawSync(compressed, { maxOutputLength: maxCsvBytes })
    : (method === 0 ? Buffer.from(compressed) : null);
  if (!csv) throw new Error(`unsupported GDELT bulk ZIP compression method: ${method}`);
  if (csv.length !== uncompressedSize) {
    throw new Error(`GDELT bulk size mismatch: expected ${uncompressedSize}, got ${csv.length}`);
  }
  return csv.toString('utf8');
}

function safeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function timestampToIso(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 14) return '';
  const iso = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
    + `T${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14)}.000Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : '';
}

// Caps bound the persisted state payload: recentGkgBatches retains thousands of
// records, and writeExtraKey has no byte ceiling, so one degenerate row could
// push the state key past Upstash's limit AFTER the products published —
// freezing the cursor in a fail-after-publish loop (#5863 review).
const MAX_RECORD_THEMES = 60;
const MAX_RECORD_LOCATIONS = 20;
const MAX_LOCATION_NAME_CHARS = 200;

function parseThemes(value) {
  return [...new Set(String(value || '')
    .split(';')
    .map((entry) => entry.split(',')[0]?.trim())
    .filter(Boolean))].slice(0, MAX_RECORD_THEMES);
}

function parseLocations(value) {
  const locations = [];
  const seen = new Set();
  for (const entry of String(value || '').split(';')) {
    const fields = entry.split('#');
    if (fields.length < 7) continue;
    if (locations.length >= MAX_RECORD_LOCATIONS) break;
    const name = fields[1]?.trim().slice(0, MAX_LOCATION_NAME_CHARS);
    const countryCode = fields[2]?.trim();
    const latitude = Number(fields[4]);
    const longitude = Number(fields[5]);
    if (
      !name
      || !Number.isFinite(latitude)
      || !Number.isFinite(longitude)
      || latitude < -90
      || latitude > 90
      || longitude < -180
      || longitude > 180
    ) continue;
    const key = `${latitude}:${longitude}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    locations.push({ name, countryCode, latitude, longitude });
  }
  return locations;
}

function pageTitle(extras) {
  const match = String(extras || '').match(/<PAGE_TITLE>([\s\S]*?)<\/PAGE_TITLE>/i);
  return decodeHtmlEntities(match?.[1] || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

export function parseGdeltGkgCsv(csv) {
  const records = [];
  const seen = new Set();
  for (const line of String(csv || '').split(/\r?\n/)) {
    if (!line) continue;
    const fields = line.split('\t');
    if (fields.length < 27) continue;
    const id = fields[0]?.trim();
    const date = timestampToIso(fields[1]);
    const url = safeHttpUrl(fields[4]);
    const title = pageTitle(fields[26]);
    if (!id || seen.has(id) || !date || !url || !title) continue;
    seen.add(id);
    const tone = Number(String(fields[15] || '').split(',')[0]);
    records.push({
      id,
      date,
      url,
      source: String(fields[3] || new URL(url).hostname).slice(0, 200),
      title,
      image: safeHttpUrl(fields[18]),
      tone: Number.isFinite(tone) ? tone : 0,
      themes: parseThemes(fields[8]),
      // fields[9] = V1LOCATIONS (Type#FullName#CC#ADM1#Lat#Lon#FeatureID) — the
      // 7-field layout parseLocations reads. fields[10] (V2ENHANCEDLOCATIONS)
      // inserts ADM2 before Lat, so reading it here put the admin code in
      // latitude and the real latitude in longitude: on a live cohort every one
      // of 2831 parsed locations landed at latitude 0 (#5863 review, P0).
      locations: parseLocations(fields[9]),
    });
  }
  return records;
}

function recordMatchesTopic(record, topic) {
  return topic.pattern.test(`${record.themes.join(' ')} ${record.title}`);
}

// Exported for tests: the published article shape is a cross-layer contract
// (src/services/gdelt-intel.ts parses `date` positionally).
// GDELT compact seendate ('YYYYMMDDTHHMMSSZ'). src/services/gdelt-intel.ts's
// formatArticleDate slices this positionally, so publishing an ISO string there
// blanked every UI age label (#5863 review).
function toSeenDate(iso) {
  const digits = String(iso || '').replace(/\D/g, '');
  if (digits.length < 14) return '';
  return `${digits.slice(0, 8)}T${digits.slice(8, 14)}Z`;
}

export function toArticle(record) {
  return {
    title: record.title,
    url: record.url,
    source: record.source,
    date: toSeenDate(record.date),
    image: record.image,
    language: 'English',
    tone: record.tone,
  };
}

function mergeArticles(
  currentRecords,
  previousArticles,
  nowMs,
  limit = MAX_ARTICLES_PER_TOPIC,
) {
  const cutoff = nowMs - ARTICLE_WINDOW_MS;
  const byUrl = new Map();
  for (const article of [
    ...currentRecords.map(toArticle),
    ...(Array.isArray(previousArticles) ? previousArticles : []),
  ]) {
    const dateMs = gdeltSeenDateToMs(article?.date);
    if (!article?.url || !Number.isFinite(dateMs) || dateMs < cutoff || byUrl.has(article.url)) continue;
    byUrl.set(article.url, article);
  }
  return [...byUrl.values()]
    .sort((a, b) => gdeltSeenDateToMs(b.date) - gdeltSeenDateToMs(a.date)
      || a.url.localeCompare(b.url))
    .slice(0, limit);
}

// ASCII-folded, lowercased words: the same token space for a GKG location
// name ("Koror, Palau") and a page title, so the title check below needs no
// matcher import (this file ships to Railway with only scripts/ packaged).
function normalizeIndexText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// The country names GKG itself attaches to a record's locations for one
// code: the last comma segment of each location's full name ("Koror, Palau"
// -> "palau", "Palau" -> "palau").
function locationCountryNames(record, code) {
  const names = new Set();
  for (const location of Array.isArray(record?.locations) ? record.locations : []) {
    const iso2 = GDELT_FIPS_TO_ISO2[String(location?.countryCode || '').trim().toUpperCase()];
    if (iso2 !== code) continue;
    const segment = String(location?.name || '').split(',').at(-1);
    const name = normalizeIndexText(segment);
    if (name.length >= 3) names.add(name);
  }
  return names;
}

// Whether the record's TITLE names the country, by GKG's own name for it.
// The read side applies the shared matcher (aliases, demonyms) before a row
// is published; this cheaper check only orders the index so the rows the
// reader can publish are never evicted by location-only mentions ("Port
// expansion approved" filed under Palau by a Koror dateline). It recalls
// less than the matcher — "Palauan senate" is a location-only row here and
// a publishable one there — which costs a row its rank, never its slot.
function titleNamesCountry(title, names) {
  if (names.size === 0) return false;
  const haystack = ` ${normalizeIndexText(title)} `;
  for (const name of names) {
    if (haystack.includes(` ${name} `)) return true;
  }
  return false;
}

// Countries a GKG record names through V1LOCATIONS, FIPS mapped to ISO-2.
// The primary country is the one with the most location mentions (ties go to
// the first named); a record is indexed under a non-primary country only when
// it names few countries in total. The read side still requires the title to
// mention the country (shared/country-mention.js) before publishing a row —
// this pass only decides which rows are worth a slot in the index, and
// which of them rank first.
export function recordCountryMentions(record) {
  const counts = new Map();
  for (const location of Array.isArray(record?.locations) ? record.locations : []) {
    const iso2 = GDELT_FIPS_TO_ISO2[String(location?.countryCode || '').trim().toUpperCase()];
    if (!iso2) continue;
    counts.set(iso2, (counts.get(iso2) ?? 0) + 1);
  }
  if (counts.size === 0) return [];
  let primary = '';
  let primaryCount = 0;
  for (const [code, count] of counts) {
    if (count > primaryCount) {
      primary = code;
      primaryCount = count;
    }
  }
  const countryCount = counts.size;
  return [...counts.keys()]
    .filter((code) => code === primary || countryCount <= MAX_COUNTRIES_PER_INDEXED_RECORD)
    .map((code) => ({
      code,
      primary: code === primary,
      countryCount,
      titleMention: titleNamesCountry(record.title, locationCountryNames(record, code)),
    }));
}

function countryIndexRow(record, mention) {
  return {
    title: String(record.title || '').slice(0, MAX_INDEX_TITLE_CHARS),
    url: record.url,
    source: record.source,
    date: toSeenDate(record.date),
    tone: Number.isFinite(record.tone) ? record.tone : 0,
    primary: mention.primary,
    countryCount: mention.countryCount,
    titleMention: mention.titleMention,
  };
}

function isCountryIndexRow(row, cutoffMs) {
  if (!row || typeof row !== 'object') return false;
  if (typeof row.url !== 'string' || !row.url || row.url.length > MAX_INDEX_URL_CHARS) return false;
  if (typeof row.title !== 'string' || !row.title) return false;
  const dateMs = gdeltSeenDateToMs(row.date);
  return Number.isFinite(dateMs) && dateMs >= cutoffMs;
}

// Title mentions first (the rows a reader can publish), then primary
// mentions, then newest. Without the first tier, ten fresh datelines from a
// country evict the one article actually about it (review of #7748).
function compareCountryIndexRows(a, b) {
  return Number(Boolean(b.titleMention)) - Number(Boolean(a.titleMention))
    || Number(Boolean(b.primary)) - Number(Boolean(a.primary))
    || gdeltSeenDateToMs(b.date) - gdeltSeenDateToMs(a.date)
    || a.url.localeCompare(b.url);
}

/**
 * Rolling per-country index of GKG articles: `byCountry[ISO2]` holds up to
 * MAX_ARTICLES_PER_COUNTRY rows inside GDELT_COUNTRY_INDEX_WINDOW_MS, title
 * mentions first, then primary mentions, newest first within a tier. Fresh
 * records win a URL tie against the previous index so a re-seen article
 * carries its latest title.
 */
export function buildGdeltCountryIndex({ records, previous = null, nowMs = Date.now() }) {
  const cutoff = nowMs - GDELT_COUNTRY_INDEX_WINDOW_MS;
  const fresh = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (!record?.url || !record?.title) continue;
    for (const mention of recordCountryMentions(record)) {
      const rows = fresh.get(mention.code) ?? [];
      rows.push(countryIndexRow(record, mention));
      fresh.set(mention.code, rows);
    }
  }
  const previousByCountry = previous?.byCountry && typeof previous.byCountry === 'object'
    ? previous.byCountry
    : {};
  const codes = [...new Set([...fresh.keys(), ...Object.keys(previousByCountry)])].sort();
  const byCountry = {};
  for (const code of codes) {
    const byUrl = new Map();
    const candidates = [
      ...(fresh.get(code) ?? []),
      ...(Array.isArray(previousByCountry[code]) ? previousByCountry[code] : []),
    ];
    for (const row of candidates) {
      if (!isCountryIndexRow(row, cutoff) || byUrl.has(row.url)) continue;
      byUrl.set(row.url, row);
    }
    const rows = [...byUrl.values()].sort(compareCountryIndexRows).slice(0, MAX_ARTICLES_PER_COUNTRY);
    if (rows.length > 0) byCountry[code] = rows;
  }
  return {
    byCountry,
    windowMs: GDELT_COUNTRY_INDEX_WINDOW_MS,
    fetchedAt: new Date(nowMs).toISOString(),
  };
}

function mergeTimeline(previousPoints, currentPoints, nowMs) {
  const cutoff = nowMs - TIMELINE_WINDOW_MS;
  const byDate = new Map();
  for (const point of [
    ...(Array.isArray(previousPoints) ? previousPoints : []),
    ...currentPoints,
  ]) {
    const dateMs = Date.parse(point?.date);
    if (!Number.isFinite(dateMs) || dateMs < cutoff || typeof point?.value !== 'number') continue;
    byDate.set(point.date, point);
  }
  return [...byDate.values()].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

function newestTimelinePointDate(...series) {
  let newestDate = '';
  let newestMs = -Infinity;
  for (const points of series) {
    for (const point of Array.isArray(points) ? points : []) {
      const dateMs = Date.parse(point?.date);
      if (!Number.isFinite(dateMs) || dateMs <= newestMs) continue;
      newestDate = point.date;
      newestMs = dateMs;
    }
  }
  return newestDate;
}

function timelineSeriesFetchedAt(current, previous, merged, series) {
  const newestCurrentDate = newestTimelinePointDate(current);
  if (newestCurrentDate) return newestCurrentDate;
  const seriesFetchedAt = previous?.[`${series}FetchedAt`];
  if (Number.isFinite(Date.parse(seriesFetchedAt))) return seriesFetchedAt;
  if (Number.isFinite(Date.parse(previous?.fetchedAt))) return previous.fetchedAt;
  return newestTimelinePointDate(merged);
}

function classifyPositiveName(name) {
  const lower = ` ${name.toLowerCase()} `;
  for (const [keyword, category] of POSITIVE_CATEGORY_KEYWORDS) {
    if (lower.includes(keyword)) return category;
  }
  return 'humanity-kindness';
}

function aggregateGeo(records, { minimumCount, predicate, positive = false }) {
  const buckets = new Map();
  const seenUrlLocations = new Set();
  for (const record of records.filter(predicate)) {
    for (const location of record.locations) {
      const key = `${location.latitude.toFixed(1)}:${location.longitude.toFixed(1)}`;
      const dedupeKey = `${record.url}|${key}`;
      if (seenUrlLocations.has(dedupeKey)) continue;
      seenUrlLocations.add(dedupeKey);
      const bucket = buckets.get(key) ?? {
        ...location,
        records: [],
        sourceUrls: [],
      };
      bucket.records.push(record);
      if (!bucket.sourceUrls.includes(record.url) && bucket.sourceUrls.length < MAX_SOURCE_URLS) {
        bucket.sourceUrls.push(record.url);
      }
      buckets.set(key, bucket);
    }
  }

  return [...buckets.values()].flatMap((bucket) => {
    if (bucket.records.length < minimumCount) return [];
    const count = bucket.records.length;
    const occurredAt = Math.max(
      ...bucket.records.map((record) => Date.parse(record.date)).filter(Number.isFinite),
    );
    if (positive) {
      const label = `${bucket.records[0].title} ${bucket.name}`;
      return [{
        latitude: bucket.latitude,
        longitude: bucket.longitude,
        name: bucket.name.slice(0, 200),
        category: classifyPositiveName(label),
        count,
        timestamp: occurredAt,
      }];
    }
    const country = bucket.name.split(',').at(-1)?.trim() || bucket.name;
    const worstTone = Math.min(...bucket.records.map((record) => record.tone));
    return [{
      id: `gdelt-bulk-${bucket.latitude.toFixed(2)}-${bucket.longitude.toFixed(2)}-${occurredAt}`,
      title: `${bucket.name} (${count} reports)`,
      summary: 'Unverified media signal. This location is mentioned in unrest-related articles; a local event is not verified.',
      eventType: 'UNREST_EVENT_TYPE_UNSPECIFIED',
      city: bucket.name.split(',')[0]?.trim() || '',
      country,
      region: '',
      location: { latitude: bucket.latitude, longitude: bucket.longitude },
      occurredAt,
      severity: 'SEVERITY_LEVEL_UNSPECIFIED',
      fatalities: 0,
      sources: ['GDELT'],
      sourceType: 'UNREST_SOURCE_TYPE_GDELT',
      tags: [],
      actors: [],
      confidence: 'CONFIDENCE_LEVEL_LOW',
      sourceUrls: bucket.sourceUrls,
      tone: worstTone,
    }];
  });
}

export function materializeGdeltBulk({
  batches,
  geoRecords,
  previous = {},
  nowMs = Date.now(),
}) {
  const safeBatches = (Array.isArray(batches) ? batches : [])
    .filter((batch) => /^\d{14}$/.test(batch?.timestamp) && Array.isArray(batch?.records))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const allRecords = safeBatches.flatMap((batch) => batch.records);
  const geoSourceRecords = Array.isArray(geoRecords) ? geoRecords : allRecords;
  const previousTopicMap = new Map(
    (previous.intel?.topics ?? []).map((topic) => [topic.id, topic]),
  );
  const matchingRecordsByTopic = new Map(
    GDELT_BULK_TOPICS.map((topic) => [topic.id, []]),
  );
  const timelinePointsByTopic = new Map(
    GDELT_BULK_TOPICS.map((topic) => [topic.id, { tone: [], vol: [] }]),
  );
  const newestDateByTopic = new Map();
  let freshTopicCount = 0;
  for (const batch of safeBatches) {
    const batchStats = new Map(
      GDELT_BULK_TOPICS.map((topic) => [topic.id, { count: 0, toneTotal: 0 }]),
    );
    for (const record of batch.records) {
      let matchesAnyTopic = false;
      for (const topic of GDELT_BULK_TOPICS) {
        if (!recordMatchesTopic(record, topic)) continue;
        matchesAnyTopic = true;
        matchingRecordsByTopic.get(topic.id).push(record);
        const stats = batchStats.get(topic.id);
        stats.count += 1;
        stats.toneTotal += record.tone;
        if (record.date > (newestDateByTopic.get(topic.id) ?? '')) {
          newestDateByTopic.set(topic.id, record.date);
        }
      }
      if (matchesAnyTopic) freshTopicCount += 1;
    }
    const date = timestampToIso(batch.timestamp);
    for (const topic of GDELT_BULK_TOPICS) {
      const stats = batchStats.get(topic.id);
      if (stats.count === 0) continue;
      const points = timelinePointsByTopic.get(topic.id);
      points.tone.push({
        date,
        value: Number((stats.toneTotal / stats.count).toFixed(4)),
      });
      points.vol.push({ date, value: stats.count });
    }
  }
  const timelines = {};
  const topics = GDELT_BULK_TOPICS.map((topic) => {
    const matchingRecords = matchingRecordsByTopic.get(topic.id);
    const previousTopic = previousTopicMap.get(topic.id);
    const articles = mergeArticles(matchingRecords, previousTopic?.articles, nowMs);
    const current = timelinePointsByTopic.get(topic.id);
    const previousTimeline = previous.timelines?.[topic.id] ?? {};
    const mergedTimeline = {
      tone: mergeTimeline(previousTimeline.tone, current.tone, nowMs),
      vol: mergeTimeline(previousTimeline.vol, current.vol, nowMs),
    };
    const toneFetchedAt = timelineSeriesFetchedAt(
      current.tone,
      previousTimeline,
      mergedTimeline.tone,
      'tone',
    );
    const volFetchedAt = timelineSeriesFetchedAt(
      current.vol,
      previousTimeline,
      mergedTimeline.vol,
      'vol',
    );
    timelines[topic.id] = {
      ...mergedTimeline,
      toneFetchedAt,
      volFetchedAt,
      fetchedAt: [toneFetchedAt, volFetchedAt]
        .filter((value) => Number.isFinite(Date.parse(value)))
        .sort((a, b) => Date.parse(a) - Date.parse(b))
        .at(-1),
    };
    return {
      id: topic.id,
      articles,
      fetchedAt: newestDateByTopic.get(topic.id)
        || previousTopic?.fetchedAt
        || new Date(nowMs).toISOString(),
    };
  });

  const unrest = aggregateGeo(geoSourceRecords, {
    minimumCount: 5,
    predicate: (record) => record.themes.some((theme) => UNREST_THEMES.has(theme)),
  });
  const positive = aggregateGeo(geoSourceRecords, {
    minimumCount: 3,
    predicate: (record) =>
      record.tone > 2 && record.themes.some((theme) => POSITIVE_THEMES.has(theme)),
    positive: true,
  });
  const cursor = safeBatches.map((batch) => batch.timestamp).sort().at(-1) || '';
  const referenceArticles = mergeArticles(
    allRecords,
    previous.reference?.articles,
    nowMs,
    500,
  );
  const countryIndex = buildGdeltCountryIndex({
    records: allRecords,
    previous: previous.countryIndex,
    nowMs,
  });
  return {
    cursor,
    freshTopicCount,
    intel: { topics, fetchedAt: new Date(nowMs).toISOString() },
    timelines,
    unrest: { events: unrest, fetchedAt: nowMs },
    positive: { events: positive, fetchedAt: nowMs },
    reference: { articles: referenceArticles, fetchedAt: nowMs },
    countryIndex,
  };
}
