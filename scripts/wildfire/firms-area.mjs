import { CHROME_UA, sleep } from '../_seed-utils.mjs';

export const FIRMS_API_BASE_URLS = Object.freeze([
  'https://firms.modaps.eosdis.nasa.gov',
  'https://firms2.modaps.eosdis.nasa.gov',
]);

export const FIRMS_SOURCES = Object.freeze([
  'VIIRS_SNPP_NRT',
  'VIIRS_NOAA20_NRT',
  'VIIRS_NOAA21_NRT',
]);

export const MONITORED_REGIONS = Object.freeze({
  Ukraine: '22,44,40,53',
  Russia: '20,50,180,82',
  Iran: '44,25,63,40',
  'Israel/Gaza': '34,29,36,34',
  Syria: '35,32,42,37',
  Taiwan: '119,21,123,26',
  'North Korea': '124,37,131,43',
  'Saudi Arabia': '34,16,56,32',
  Turkey: '26,36,45,42',
});

const REQUEST_PACE_MS = 6_000;

function mapConfidence(value) {
  switch ((value || '').toLowerCase()) {
    case 'h': return 'FIRE_CONFIDENCE_HIGH';
    case 'n': return 'FIRE_CONFIDENCE_NOMINAL';
    case 'l': return 'FIRE_CONFIDENCE_LOW';
    default: return 'FIRE_CONFIDENCE_UNSPECIFIED';
  }
}

function parseCsv(csv) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((header) => header.trim());
  const results = [];
  for (let index = 1; index < lines.length; index++) {
    const values = lines[index].split(',').map((value) => value.trim());
    if (values.length < headers.length) continue;
    const row = {};
    headers.forEach((header, column) => { row[header] = values[column]; });
    results.push(row);
  }
  return results;
}

function parseDetectedAt(acqDate, acqTime) {
  const padded = (acqTime || '').padStart(4, '0');
  const hours = padded.slice(0, 2);
  const minutes = padded.slice(2);
  return new Date(`${acqDate}T${hours}:${minutes}:00Z`).getTime();
}

function safeFailureReason(error) {
  if (Number.isInteger(error?.status)) return `HTTP ${error.status}`;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  return 'request error';
}

function buildAreaUrl(baseUrl, apiKey, source, bbox) {
  return `${baseUrl}/api/area/csv/${apiKey}/${source}/${bbox}/1`;
}

export async function fetchFirmsRegionSource(apiKey, regionName, bbox, source, {
  fetchFn = globalThis.fetch,
  sleepFn = sleep,
  logger = console,
} = {}) {
  const failures = [];
  // A valid primary MAP_KEY can be rejected by the secondary. Give a transient
  // primary failure one more paced attempt before declaring this slot missing.
  const attempts = [...FIRMS_API_BASE_URLS, FIRMS_API_BASE_URLS[0]];
  const labels = ['primary', 'secondary', 'primary retry'];
  for (let index = 0; index < attempts.length; index++) {
    const baseUrl = attempts[index];
    try {
      const response = await fetchFn(buildAreaUrl(baseUrl, apiKey, source, bbox), {
        headers: { Accept: 'text/csv', 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const error = new Error('FIRMS request failed');
        error.status = response.status;
        throw error;
      }
      return parseCsv(await response.text());
    } catch (error) {
      const endpoint = labels[index];
      failures.push(`${endpoint} ${safeFailureReason(error)}`);
      if (index + 1 < attempts.length) {
        logger.warn(`  [FIRMS] ${source}/${regionName}: ${failures.at(-1)}; trying ${labels[index + 1]}`);
        await sleepFn(REQUEST_PACE_MS);
      }
    }
  }
  throw new Error(`FIRMS ${source}/${regionName} failed (${failures.join(', ')})`);
}

export async function fetchAllFirmsRegions(apiKey, {
  fetchFn = globalThis.fetch,
  sleepFn = sleep,
  logger = console,
} = {}) {
  const seen = new Set();
  const fireDetections = [];
  let fulfilled = 0;
  let failed = 0;

  for (const source of FIRMS_SOURCES) {
    for (const [regionName, bbox] of Object.entries(MONITORED_REGIONS)) {
      try {
        const rows = await fetchFirmsRegionSource(apiKey, regionName, bbox, source, {
          fetchFn,
          sleepFn,
          logger,
        });
        fulfilled++;
        for (const row of rows) {
          const id = `${row.latitude ?? ''}-${row.longitude ?? ''}-${row.acq_date ?? ''}-${row.acq_time ?? ''}`;
          if (seen.has(id)) continue;
          seen.add(id);
          const detectedAt = parseDetectedAt(row.acq_date || '', row.acq_time || '');
          const brightness = parseFloat(row.bright_ti4 ?? '0') || 0;
          const frp = parseFloat(row.frp ?? '0') || 0;
          fireDetections.push({
            id,
            location: {
              latitude: parseFloat(row.latitude ?? '0') || 0,
              longitude: parseFloat(row.longitude ?? '0') || 0,
            },
            brightness,
            frp,
            confidence: mapConfidence(row.confidence || ''),
            satellite: row.satellite || '',
            detectedAt,
            region: regionName,
            dayNight: row.daynight || '',
            possibleExplosion: frp > 80 && brightness > 380,
            source: 'firms',
            kind: 'active',
            emergency: true,
          });
        }
      } catch (error) {
        failed++;
        logger.error(`  [FIRMS] ${source}/${regionName}: ${error.message || error}`);
      }
      // Keep the existing bounded cadence. NASA accounts in transactions, not
      // raw requests, so this pace limits traffic without claiming a per-minute
      // request quota.
      await sleepFn(REQUEST_PACE_MS);
    }
    logger.log(`  ${source}: ${fireDetections.length} total (${fulfilled} ok, ${failed} failed)`);
  }

  return {
    fireDetections,
    pagination: undefined,
    _firmsFulfilledCalls: fulfilled,
    _firmsFailedCalls: failed,
  };
}
