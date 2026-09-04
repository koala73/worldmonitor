import type {
  InfrastructureServiceHandler,
  ServerContext,
  ReverseGeocodeRequest,
  ReverseGeocodeResponse,
} from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';
import { ApiError } from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';
import { getCachedJson, setCachedJson } from '../../../_shared/redis';
import { checkScopedRateLimit } from '../../../_shared/rate-limit';
import { geocodeCacheKey } from '../../../../shared/geocode-cache-key.js';

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/reverse';
const CHROME_UA = 'WorldMonitor/2.0 (https://worldmonitor.app)';
const PROVIDER_RATE_LIMIT_SCOPE = 'reverse-geocode';
const PROVIDER_RATE_LIMIT_IDENTIFIER = 'global';
const PROVIDER_RATE_LIMIT_PER_SECOND = 1;
const PROVIDER_RATE_LIMIT_WINDOW = '1 s' as const;

interface ReverseCacheEntry {
  country?: string;
  code?: string;
  displayName?: string;
  error?: string;
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

  const cacheKey = geocodeCacheKey(lat, lon);

  const cached = await getCachedJson(cacheKey);
  if (cached && typeof cached === 'object') {
    const normalized = normalizeCacheEntry(cached as ReverseCacheEntry);
    if (normalized) return normalized;
  }

  // Shared with api/reverse-geocode.js as the exact Redis bucket
  // `rl:scope:reverse-geocode:global`. Cache hits bypass this provider budget;
  // Redis degradation fails closed so it cannot expose Nominatim to unbounded
  // aggregate traffic from the two routes.
  const providerLimit = await checkScopedRateLimit(
    PROVIDER_RATE_LIMIT_SCOPE,
    PROVIDER_RATE_LIMIT_PER_SECOND,
    PROVIDER_RATE_LIMIT_WINDOW,
    PROVIDER_RATE_LIMIT_IDENTIFIER,
  );
  if (providerLimit.degraded) {
    throw new ApiError(503, 'Rate-limit service temporarily unavailable', '');
  }
  if (!providerLimit.allowed) {
    throw new ApiError(429, 'Too many requests', '');
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

    const result: ReverseCacheEntry = { country, code, displayName, error: '' };
    await setCachedJson(cacheKey, result, 604800);

    return { country, code, displayName, error: '' };
  } catch (err) {
    return { country: '', code: '', displayName: '', error: String(err) };
  }
};
