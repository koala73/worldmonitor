/**
 * ListFireDetections RPC -- proxies the NASA FIRMS CSV API.
 *
 * Fetches active fire detections from all 9 monitored regions in parallel
 * and transforms the FIRMS CSV rows into proto-shaped FireDetection objects.
 *
 * Gracefully degrades to empty results when NASA_FIRMS_API_KEY is not set.
 */

declare const process: { env: Record<string, string | undefined> };

import type {
  WildfireServiceHandler,
  ServerContext,
  ListFireDetectionsRequest,
  ListFireDetectionsResponse,
  FireConfidence,
} from '../../../../src/generated/server/worldmonitor/wildfire/v1/service_server';

import { CHROME_UA } from '../../../_shared/constants';
import { getCachedJson, setCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'wildfire:fires:v1';
const REDIS_CACHE_TTL = 3600; // 1h — NASA FIRMS VIIRS NRT updates every ~3 hours

const FIRMS_SOURCE = 'VIIRS_SNPP_NRT';

/** Bounding boxes as west,south,east,north */
const MONITORED_REGIONS: Record<string, string> = {
  'Ukraine': '22,44,40,53',
  'Russia': '20,50,180,82',
  'Iran': '44,25,63,40',
  'Israel/Gaza': '34,29,36,34',
  'Syria': '35,32,42,37',
  'Taiwan': '119,21,123,26',
  'North Korea': '124,37,131,43',
  'Saudi Arabia': '34,16,56,32',
  'Turkey': '26,36,45,42',
};

/** Map VIIRS confidence letters to proto enum values. */
function mapConfidence(c: string): FireConfidence {
  switch (c.toLowerCase()) {
    case 'h':
      return 'FIRE_CONFIDENCE_HIGH';
    case 'n':
      return 'FIRE_CONFIDENCE_NOMINAL';
    case 'l':
      return 'FIRE_CONFIDENCE_LOW';
    default:
      return 'FIRE_CONFIDENCE_UNSPECIFIED';
  }
}

/** Parse a FIRMS CSV response into an array of row objects keyed by header name. */
function parseCSV(csv: string): Record<string, string>[] {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0]!.split(',').map((h) => h.trim());
  const results: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i]!.split(',').map((v) => v.trim());
    if (vals.length < headers.length) continue;

    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = vals[idx]!;
    });
    results.push(row);
  }

  return results;
}

/**
 * Parse FIRMS acq_date (YYYY-MM-DD) + acq_time (HHMM) into Unix epoch
 * milliseconds.
 */
function parseDetectedAt(acqDate: string, acqTime: string): number {
  const padded = acqTime.padStart(4, '0');
  const hours = padded.slice(0, 2);
  const minutes = padded.slice(2);
  return new Date(`${acqDate}T${hours}:${minutes}:00Z`).getTime();
}

export const listFireDetections: WildfireServiceHandler['listFireDetections'] = async (
  _ctx: ServerContext,
  _req: ListFireDetectionsRequest,
): Promise<ListFireDetectionsResponse> => {
  const apiKey =
    process.env.NASA_FIRMS_API_KEY || process.env.FIRMS_API_KEY || '';

  // Graceful degradation: return empty list when API key is not configured
  if (!apiKey) {
    return { fireDetections: [], pagination: undefined };
  }

  // Redis shared cache (cross-instance)
  const cached = (await getCachedJson(REDIS_CACHE_KEY)) as ListFireDetectionsResponse | null;
  if (cached?.fireDetections?.length) return cached;

  const entries = Object.entries(MONITORED_REGIONS);

  const results = await Promise.allSettled(
    entries.map(async ([regionName, bbox]) => {
      const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${apiKey}/${FIRMS_SOURCE}/${bbox}/1`;
      const res = await fetch(url, {
        headers: { Accept: 'text/csv', 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        throw new Error(`FIRMS ${res.status} for ${regionName}`);
      }
      const csv = await res.text();
      const rows = parseCSV(csv);
      return { regionName, rows };
    }),
  );

  const fireDetections: ListFireDetectionsResponse['fireDetections'] = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { regionName, rows } = result.value;
      for (const row of rows) {
        const detectedAt = parseDetectedAt(
          row.acq_date || '',
          row.acq_time || '',
        );
        fireDetections.push({
          id: `${row.latitude ?? ''}-${row.longitude ?? ''}-${row.acq_date ?? ''}-${row.acq_time ?? ''}`,
          location: {
            latitude: parseFloat(row.latitude ?? '0') || 0,
            longitude: parseFloat(row.longitude ?? '0') || 0,
          },
          brightness: parseFloat(row.bright_ti4 ?? '0') || 0,
          frp: parseFloat(row.frp ?? '0') || 0,
          confidence: mapConfidence(row.confidence || ''),
          satellite: row.satellite || '',
          detectedAt,
          region: regionName,
          dayNight: row.daynight || '',
        });
      }
    } else {
      console.error('[FIRMS]', result.reason?.message);
    }
  }

  const result: ListFireDetectionsResponse = { fireDetections, pagination: undefined };
  if (fireDetections.length > 0) {
    setCachedJson(REDIS_CACHE_KEY, result, REDIS_CACHE_TTL).catch(() => {});
  }
  return result;
};
