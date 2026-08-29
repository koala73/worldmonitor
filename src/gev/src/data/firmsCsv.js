/**
 * NASA FIRMS area-CSV parsing — pure functions, no Cesium/DOM/network.
 *
 * Upstream: https://firms.modaps.eosdis.nasa.gov/api/area/csv/{KEY}/{SOURCE}/world/{days}
 * VIIRS header (confirmed live 2026-07-16):
 *   latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,
 *   instrument,confidence,version,bright_ti5,frp,daynight
 *
 * Quirks this module owns:
 * - `confidence` is CATEGORICAL for VIIRS (`l`/`n`/`h`) — passed through raw.
 * - `acq_time` is NOT zero-padded ("45" = 00:45 UTC) — kept as-is in records;
 *   {@link acquisitionMsUtc} does the padding.
 * - Upstream errors come back as HTML or plain text ("Invalid MAP_KEY"),
 *   never CSV — {@link isLikelyCsv} gates parsing.
 * - `days=1` means "current UTC day" (nearly empty just after 00:00 UTC), so
 *   callers fetch days=2 and clamp with {@link filterTrailing24h}.
 */

/** Header fields that must all be present for a payload to count as FIRMS CSV. */
const REQUIRED_HEADER_FIELDS = ['latitude', 'longitude', 'acq_date', 'acq_time', 'confidence', 'frp'];

const HOUR_MS = 3600_000;
/** Trailing window size for {@link filterTrailing24h}. */
const WINDOW_MS = 24 * HOUR_MS;
/** Forward slack for {@link filterTrailing24h} (upstream/local clock skew). */
const FORWARD_SLACK_MS = 2 * HOUR_MS;

/**
 * Cheap "is this actually FIRMS CSV?" check. HTML error pages (first
 * non-whitespace char `<`) and text errors like "Invalid MAP_KEY" fail it;
 * any payload whose first line carries the expected header fields passes.
 * @param {string} text - Raw upstream response body.
 * @returns {boolean}
 */
export function isLikelyCsv(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trimStart();
  if (!trimmed || trimmed[0] === '<') return false;
  const headerLine = trimmed.slice(0, trimmed.indexOf('\n') === -1 ? undefined : trimmed.indexOf('\n'))
    .trim().toLowerCase();
  const fields = headerLine.split(',').map((f) => f.trim());
  return REQUIRED_HEADER_FIELDS.every((required) => fields.includes(required));
}

/**
 * Parse a FIRMS area CSV payload into flat detection records.
 *
 * Tolerates CRLF, trailing newlines, and malformed rows (skipped). A
 * header-only payload parses to `[]`. Non-CSV input (HTML/error text — see
 * {@link isLikelyCsv}) returns `null` so callers can distinguish "no fires"
 * from "upstream failure".
 *
 * @param {string} text - Raw CSV payload.
 * @returns {?Array<{lat: number, lon: number, frp: number, confidence: string|number,
 *   brightness: number, brightnessTi5: number, daynight: string, acqDate: string,
 *   acqTime: string, satellite: string, instrument: string}>} Records, or null for non-CSV.
 */
export function parseFirmsCsv(text) {
  if (!isLikelyCsv(text)) return null;
  const lines = text.split('\n');

  // Locate the header (first non-empty line) and build a column index so the
  // parser survives column reordering across FIRMS product versions.
  let headerIndex = 0;
  while (headerIndex < lines.length && !lines[headerIndex].trim()) headerIndex += 1;
  const header = lines[headerIndex].trim().toLowerCase().split(',').map((f) => f.trim());
  const col = new Map(header.map((name, i) => [name, i]));
  const iLat = col.get('latitude');
  const iLon = col.get('longitude');
  const iFrp = col.get('frp');
  const iConfidence = col.get('confidence');
  const iBrightness = col.get('bright_ti4') ?? col.get('brightness');
  const iBrightnessTi5 = col.get('bright_ti5') ?? col.get('bright_t31');
  const iDaynight = col.get('daynight');
  const iAcqDate = col.get('acq_date');
  const iAcqTime = col.get('acq_time');
  const iSatellite = col.get('satellite');
  const iInstrument = col.get('instrument');

  const records = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < header.length) continue; // malformed row — skip
    const lat = Number(parts[iLat]);
    const lon = Number(parts[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    records.push({
      lat,
      lon,
      frp: finiteOrZero(parts[iFrp]),
      // Categorical (l/n/h) or numeric — passed through raw; display
      // normalization happens client-side (normalizeConfidence).
      confidence: cell(parts, iConfidence),
      brightness: finiteOrZero(parts[iBrightness]),
      brightnessTi5: finiteOrZero(parts[iBrightnessTi5]),
      daynight: cell(parts, iDaynight),
      acqDate: cell(parts, iAcqDate),
      acqTime: cell(parts, iAcqTime), // NOT zero-padded — kept verbatim
      satellite: cell(parts, iSatellite),
      instrument: cell(parts, iInstrument),
    });
  }
  return records;
}

/**
 * Convert FIRMS acq_date ("YYYY-MM-DD") + acq_time (unpadded "HHMM", UTC)
 * into epoch milliseconds. "1006" → 10:06Z; "45" → 00:45Z; "0" → 00:00Z.
 * @param {string} acqDate - Acquisition date.
 * @param {string|number} acqTime - Acquisition time, unpadded HHMM.
 * @returns {number} Epoch ms, or NaN when unparseable.
 */
export function acquisitionMsUtc(acqDate, acqTime) {
  if (typeof acqDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(acqDate)) return NaN;
  const timeText = String(acqTime ?? '').trim();
  if (!/^\d{1,4}$/.test(timeText)) return NaN;
  const hhmm = timeText.padStart(4, '0');
  const year = Number(acqDate.slice(0, 4));
  const month = Number(acqDate.slice(5, 7));
  const day = Number(acqDate.slice(8, 10));
  const hours = Number(hhmm.slice(0, 2));
  const minutes = Number(hhmm.slice(2, 4));
  if (month < 1 || month > 12 || day < 1 || day > 31 || hours > 23 || minutes > 59) return NaN;
  return Date.UTC(year, month - 1, day, hours, minutes);
}

/**
 * Keep only records acquired within `[nowMs − 24 h, nowMs + 2 h]` (inclusive).
 * The 2 h forward slack absorbs upstream/local clock skew; records with an
 * unparseable acquisition time are dropped. Timestamps are memoized per
 * unique date:time pair — granule timestamps repeat heavily.
 * @param {Array<{acqDate: string, acqTime: string|number}>} records - Parser records.
 * @param {number} nowMs - Reference epoch milliseconds.
 * @returns {Array<Object>} Filtered records (original objects, order preserved).
 */
export function filterTrailing24h(records, nowMs) {
  if (!Array.isArray(records) || !Number.isFinite(nowMs)) return [];
  const oldest = nowMs - WINDOW_MS;
  const newest = nowMs + FORWARD_SLACK_MS;
  const memo = new Map();
  return records.filter((record) => {
    const key = `${record.acqDate}:${record.acqTime}`;
    let ms = memo.get(key);
    if (ms === undefined) {
      ms = acquisitionMsUtc(record.acqDate, record.acqTime);
      memo.set(key, ms);
    }
    return Number.isFinite(ms) && ms >= oldest && ms <= newest;
  });
}

/** Trimmed string cell at index, '' for missing columns. */
function cell(parts, index) {
  if (index === undefined || parts[index] === undefined) return '';
  return parts[index].trim();
}

/** Numeric cell → finite number, else 0. */
function finiteOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
