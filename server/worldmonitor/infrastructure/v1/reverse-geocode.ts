import type {
  InfrastructureServiceHandler,
  ServerContext,
  ReverseGeocodeRequest,
  ReverseGeocodeResponse,
} from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';
import { getCachedJson, setCachedJson } from '../../../_shared/redis';

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/reverse';
const CHROME_UA = 'WorldMonitor/2.0 (https://worldmonitor.app)';

interface ReverseCacheEntry {
  country?: string;
  code?: string;
  displayName?: string;
}

interface NominatimResponse {
  display_name?: string;
  address?: {
    country?: string;
    country_code?: string;
  };
}

function isValidCoordinates(lat: number, lon: number): boolean {
  return Number.isFinite(lat)
    && Number.isFinite(lon)
    && lat >= -90
    && lat <= 90
    && lon >= -180
    && lon <= 180;
}

function normalizeCacheEntry(entry: ReverseCacheEntry | null): ReverseGeocodeResponse | null {
  if (!entry) return null;
  return {
    country: entry.country || '',
    code: entry.code || '',
    displayName: entry.displayName || '',
    error: '',
  };
}

/**
 * ReverseGeocode resolves coordinates to a country/address with caching.
 */
export const reverseGeocode: InfrastructureServiceHandler['reverseGeocode'] = async (
  _ctx: ServerContext,
  req: ReverseGeocodeRequest,
): Promise<ReverseGeocodeResponse> => {
  const { lat, lon } = req;
  if (!isValidCoordinates(lat, lon)) {
    return {
      country: '',
      code: '',
      displayName: '',
      error: 'valid lat (-90..90) and lon (-180..180) required',
    };
  }

  const cacheKey = `geocode:${lat.toFixed(1)},${lon.toFixed(1)}`;

  const cached = await getCachedJson(cacheKey);
  if (cached && typeof cached === 'object') {
    const normalized = normalizeCacheEntry(cached as ReverseCacheEntry);
    if (normalized) return normalized;
  }

  try {
    const resp = await fetch(
      `${NOMINATIM_BASE}?lat=${lat}&lon=${lon}&format=json&zoom=3&accept-language=en`,
      {
        headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      },
    );

    if (!resp.ok) {
      return { country: '', code: '', displayName: '', error: `Nominatim HTTP ${resp.status}` };
    }

    const data = (await resp.json()) as NominatimResponse;
    const country = data.address?.country || '';
    const code = (data.address?.country_code || '').toUpperCase();
    const displayName = data.display_name || country || '';

    const result: ReverseCacheEntry = { country, code, displayName };
    await setCachedJson(cacheKey, result, 604800);

    return { country, code, displayName, error: '' };
  } catch (err) {
    return { country: '', code: '', displayName: '', error: String(err) };
  }
};
