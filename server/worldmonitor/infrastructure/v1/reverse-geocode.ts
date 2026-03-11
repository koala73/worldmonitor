import type {
  InfrastructureServiceHandler,
  ServerContext,
  ReverseGeocodeRequest,
  ReverseGeocodeResponse,
} from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';
import { getCachedJson, setCachedJson } from '../../../_shared/redis';

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/reverse';
const CHROME_UA = 'WorldMonitor/2.0 (https://worldmonitor.app)';

/**
 * ReverseGeocode resolves coordinates to a country/address with caching.
 */
export const reverseGeocode: InfrastructureServiceHandler['reverseGeocode'] = async (
  _ctx: ServerContext,
  req: ReverseGeocodeRequest,
): Promise<ReverseGeocodeResponse> => {
  const { lat, lon } = req;
  const cacheKey = `geocode:${lat.toFixed(1)},${lon.toFixed(1)}`;

  // 1. Try Cache
  try {
    const cached = await getCachedJson(cacheKey, true) as any;
    if (cached) {
      return {
        country: cached.country || '',
        code: cached.code || '',
        displayName: cached.displayName || '',
        error: '',
      };
    }
  } catch { /* skip */ }

  // 2. Fetch Fresh
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

    const data = await resp.json();
    const country = data.address?.country || '';
    const code = (data.address?.country_code || '').toUpperCase();
    const displayName = data.display_name || country || '';

    const result = { country, code, displayName };
    
    // Fire-and-forget cache update
    setCachedJson(cacheKey, result, 604800).catch(() => {});

    return { ...result, error: '' };
  } catch (err) {
    return { country: '', code: '', displayName: '', error: String(err) };
  }
};
