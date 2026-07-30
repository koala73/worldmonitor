// Resilient GDELT conflict-event fallback using the official 15-minute bulk
// event export. The DOC API is aggressively per-IP throttled; the bulk stream
// is a single global stream and therefore remains usable when country-by-country
// DOC queries all return 429.

import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { GDELT_COUNTRY_NAMES, gdeltSeenDateToIso } from './_conflict-gdelt.mjs';
import { allSettledWithConcurrency } from './_seed-utils.mjs';

const GDELT_STORAGE_ORIGIN = 'https://storage.googleapis.com/data.gdeltproject.org';
export const GDELT_MASTER_FILELIST_URL = `${GDELT_STORAGE_ORIGIN}/gdeltv2/masterfilelist.txt`;
export const GDELT_MAX_EXPORT_ZIP_BYTES = 5_000_000;
export const GDELT_MAX_EXPORT_CSV_BYTES = 30_000_000;
export const GDELT_ROLLING_WINDOW_MAX_EVENTS = 5_000;

const MASTER_TAIL_BYTES = 16_384;
const RECENT_EXPORT_COUNT = 8;
const EXPORT_FETCH_CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 20_000;
export const GDELT_ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
export const GDELT_BULK_WORST_NETWORK_MS = REQUEST_TIMEOUT_MS
  * (1 + Math.ceil(RECENT_EXPORT_COUNT / EXPORT_FETCH_CONCURRENCY));
const USER_AGENT = 'WorldMonitor/1.0 (+https://www.worldmonitor.app)';
const MATERIAL_VIOLENCE_ROOT_CODES = new Set(['18', '19', '20']);

// GDELT ActionGeo_CountryCode uses FIPS 10-4 rather than ISO-2.
// Palestine can appear as either Gaza (GZ) or West Bank (WE).
export const GDELT_FIPS_TO_ISO2 = Object.freeze({
  AF: 'AF', SY: 'SY', UP: 'UA', SU: 'SD', OD: 'SS', SO: 'SO', CG: 'CD',
  BM: 'MM', YM: 'YE', ET: 'ET', IZ: 'IQ', GZ: 'PS', WE: 'PS', LY: 'LY',
  ML: 'ML', UV: 'BF', NG: 'NE', NI: 'NG', CM: 'CM', MZ: 'MZ', HA: 'HT',
});

function boundedPositiveInteger(value, label, max) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`invalid GDELT ${label}: ${value}`);
  }
  return parsed;
}

function parseExportDescriptorLine(exportLine) {
  const [sizeRaw, md5Raw, urlRaw, ...extra] = exportLine.split(/\s+/);
  if (!sizeRaw || !md5Raw || !urlRaw || extra.length) {
    throw new Error('malformed GDELT event export manifest line');
  }
  const size = boundedPositiveInteger(sizeRaw, 'event export size', GDELT_MAX_EXPORT_ZIP_BYTES);
  const md5 = md5Raw.toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(md5)) throw new Error('invalid GDELT event export checksum');

  const url = new URL(urlRaw);
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'data.gdeltproject.org' || url.port) {
    throw new Error(`untrusted GDELT event export URL: ${urlRaw}`);
  }
  const match = url.pathname.match(/^\/gdeltv2\/(\d{14})\.export\.CSV\.zip$/);
  if (!match || url.search || url.hash) throw new Error(`invalid GDELT event export path: ${urlRaw}`);

  return {
    size,
    md5,
    url: `${GDELT_STORAGE_ORIGIN}${url.pathname}`,
    exportTimestamp: match[1],
  };
}

export function parseGdeltRecentExports(manifest, limit = RECENT_EXPORT_COUNT) {
  const descriptors = [];
  for (const line of String(manifest || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/\.export\.CSV\.zip$/i.test(trimmed)) continue;
    try {
      descriptors.push(parseExportDescriptorLine(trimmed));
    } catch (error) {
      // A suffix range can begin mid-line. Ignore that incomplete fragment,
      // but fail closed for any full-looking descriptor that violates the
      // checksum/size/URL allowlist.
      if (!/^\d+\s+[a-f0-9]{32}\s+/i.test(trimmed)) continue;
      throw error;
    }
  }
  if (!descriptors.length) throw new Error('GDELT master manifest tail has no valid event exports');
  return descriptors
    .sort((a, b) => a.exportTimestamp.localeCompare(b.exportTimestamp))
    .slice(-Math.max(1, limit));
}

export function extractGdeltExportCsv(zipBytes) {
  const zip = Buffer.isBuffer(zipBytes) ? zipBytes : Buffer.from(zipBytes || []);
  if (zip.length < 30 || zip.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('invalid GDELT event export ZIP header');
  }
  const flags = zip.readUInt16LE(6);
  if (flags & 0x1) throw new Error('encrypted GDELT event export ZIP is unsupported');
  if (flags & 0x8) throw new Error('streaming GDELT event export ZIP is unsupported');

  const method = zip.readUInt16LE(8);
  const compressedSize = boundedPositiveInteger(
    zip.readUInt32LE(18),
    'ZIP compressed size',
    GDELT_MAX_EXPORT_ZIP_BYTES,
  );
  const uncompressedSize = boundedPositiveInteger(
    zip.readUInt32LE(22),
    'ZIP uncompressed size',
    GDELT_MAX_EXPORT_CSV_BYTES,
  );
  const filenameLength = zip.readUInt16LE(26);
  const extraLength = zip.readUInt16LE(28);
  const dataStart = 30 + filenameLength + extraLength;
  const dataEnd = dataStart + compressedSize;
  if (dataStart > zip.length || dataEnd > zip.length) throw new Error('truncated GDELT event export ZIP');

  const filename = zip.subarray(30, 30 + filenameLength).toString('utf8');
  if (!/^\d{14}\.export\.CSV$/.test(filename)) {
    throw new Error(`unexpected GDELT event export filename: ${filename}`);
  }

  const compressed = zip.subarray(dataStart, dataEnd);
  const csv = method === 8
    ? inflateRawSync(compressed, { maxOutputLength: GDELT_MAX_EXPORT_CSV_BYTES })
    : (method === 0 ? Buffer.from(compressed) : null);
  if (!csv) throw new Error(`unsupported GDELT event export ZIP compression method: ${method}`);
  if (csv.length !== uncompressedSize) {
    throw new Error(`GDELT event export size mismatch: expected ${uncompressedSize}, got ${csv.length}`);
  }
  return csv.toString('utf8');
}

function sourceDomain(sourceUrl) {
  try {
    return new URL(sourceUrl).hostname;
  } catch {
    return '';
  }
}

export function gdeltTimestampToMs(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  if (digits.length < 14) return Number.NaN;
  return Date.parse(
    `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
      + `T${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14)}Z`,
  );
}

export function mapGdeltExportToConflictEvents(csv) {
  const events = [];
  const seen = new Set();
  for (const line of String(csv || '').split(/\r?\n/)) {
    if (!line) continue;
    const fields = line.split('\t');
    if (fields.length < 61 || fields[25] !== '1' || fields[29] !== '4') continue;
    if (!MATERIAL_VIOLENCE_ROOT_CODES.has(fields[28])) continue;

    const iso2 = GDELT_FIPS_TO_ISO2[fields[53]];
    const country = GDELT_COUNTRY_NAMES[iso2];
    const id = fields[0];
    const eventDate = gdeltSeenDateToIso(fields[59]);
    const gdeltAddedAt = gdeltTimestampToMs(fields[59]);
    if (!id || seen.has(id) || !country || !eventDate || !Number.isFinite(gdeltAddedAt)) continue;
    seen.add(id);

    const url = fields[60] || '';
    events.push({
      id: `gdelt-event-${id}`,
      eventType: `GDELT ${fields[26] || fields[28] || 'material conflict'}`,
      country,
      event_date: eventDate,
      occurredAt: gdeltAddedAt,
      gdeltAddedAt,
      source: sourceDomain(url),
      url,
    });
  }
  return events;
}

function eventAddedAt(event, fallbackTimestamp) {
  const exact = Number(event?.gdeltAddedAt);
  if (Number.isFinite(exact) && exact > 0) return exact;
  return gdeltTimestampToMs(fallbackTimestamp);
}

export function mergeGdeltBulkRollingWindow(bulk, previousSnapshot, nowMs = Date.now()) {
  const cutoff = nowMs - GDELT_ROLLING_WINDOW_MS;
  const previousIsBulk = previousSnapshot?.source === 'gdelt-bulk'
    && Array.isArray(previousSnapshot.events);
  const previousExportTimestamp = previousSnapshot?.pagination?.exportTimestamp;
  const currentExportTimestamp = bulk?.exportTimestamp;
  const byId = new Map();

  const addEvents = (events, fallbackTimestamp) => {
    for (const event of Array.isArray(events) ? events : []) {
      const addedAt = eventAddedAt(event, fallbackTimestamp);
      if (!event?.id || !Number.isFinite(addedAt) || addedAt < cutoff) continue;
      byId.set(event.id, { ...event, occurredAt: addedAt, gdeltAddedAt: addedAt });
    }
  };

  if (previousIsBulk) addEvents(previousSnapshot.events, previousExportTimestamp);
  // Current exports win on duplicate IDs, though GDELT event IDs are normally
  // first-seen-only and therefore unique across 15-minute export files.
  addEvents(bulk?.events, currentExportTimestamp);

  const currentCoverageStart = gdeltTimestampToMs(
    bulk?.oldestExportTimestamp || currentExportTimestamp,
  );
  const previousCoverageStart = previousIsBulk
    ? Number(previousSnapshot.pagination?.rollingWindowStartedAt)
    : Number.NaN;
  const legacyPreviousCoverageStart = previousIsBulk
    ? gdeltTimestampToMs(previousExportTimestamp) - (RECENT_EXPORT_COUNT * 15 * 60 * 1000)
    : Number.NaN;
  const coverageCandidates = [
    currentCoverageStart,
    previousCoverageStart,
    legacyPreviousCoverageStart,
  ].filter(value => Number.isFinite(value) && value > 0);
  const earliestCoverage = coverageCandidates.length
    ? Math.min(...coverageCandidates)
    : nowMs;
  const rollingWindowStartedAt = Math.max(cutoff, earliestCoverage);
  const events = [...byId.values()]
    .sort((a, b) => b.gdeltAddedAt - a.gdeltAddedAt)
    .slice(0, GDELT_ROLLING_WINDOW_MAX_EVENTS);

  return {
    events,
    rollingWindowStartedAt,
    rollingWindowComplete: rollingWindowStartedAt <= cutoff,
    retainedPreviousEvents: previousIsBulk
      ? events.filter(event => event.gdeltAddedAt < currentCoverageStart).length
      : 0,
  };
}

async function fetchBoundedBuffer(fetchImpl, url, maxBytes, expectedStatus, extraHeaders = {}) {
  const response = await fetchImpl(url, {
    headers: { Accept: '*/*', 'User-Agent': USER_AGENT, ...extraHeaders },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GDELT bulk HTTP ${response.status} for ${url}`);
  if (expectedStatus && response.status !== expectedStatus) {
    throw new Error(`GDELT bulk expected HTTP ${expectedStatus}, got ${response.status} for ${url}`);
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`GDELT bulk response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) throw new Error(`GDELT bulk response has no body for ${url}`);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new Error(`GDELT bulk response exceeds ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

export async function fetchGdeltBulkConflictEvents({ fetchImpl = globalThis.fetch } = {}) {
  const manifestBytes = await fetchBoundedBuffer(
    fetchImpl,
    GDELT_MASTER_FILELIST_URL,
    MASTER_TAIL_BYTES,
    206,
    { Range: `bytes=-${MASTER_TAIL_BYTES}` },
  );
  const descriptors = parseGdeltRecentExports(manifestBytes.toString('utf8'));
  const results = await allSettledWithConcurrency(
    descriptors,
    EXPORT_FETCH_CONCURRENCY,
    async (descriptor) => {
      const zipBytes = await fetchBoundedBuffer(fetchImpl, descriptor.url, GDELT_MAX_EXPORT_ZIP_BYTES);
      if (zipBytes.length !== descriptor.size) {
        throw new Error(`download size mismatch: expected ${descriptor.size}, got ${zipBytes.length}`);
      }
      const actualMd5 = createHash('md5').update(zipBytes).digest('hex');
      if (actualMd5 !== descriptor.md5) throw new Error('checksum mismatch');
      return {
        events: mapGdeltExportToConflictEvents(extractGdeltExportCsv(zipBytes)),
        exportTimestamp: descriptor.exportTimestamp,
      };
    },
  );

  const successful = results.filter(result => result.status === 'fulfilled');
  if (!successful.length) {
    const sample = results.slice(0, 3).map(result => result.reason?.message || result.reason).join(', ');
    throw new Error(`all recent GDELT event exports failed${sample ? `: ${sample}` : ''}`);
  }
  const events = [];
  const seen = new Set();
  for (const result of successful) {
    for (const event of result.value.events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      events.push(event);
    }
  }
  return {
    events,
    oldestExportTimestamp: successful
      .map(result => result.value.exportTimestamp)
      .sort()
      .at(0),
    exportTimestamp: successful
      .map(result => result.value.exportTimestamp)
      .sort()
      .at(-1),
    exportsRequested: descriptors.length,
    exportsSucceeded: successful.length,
  };
}
