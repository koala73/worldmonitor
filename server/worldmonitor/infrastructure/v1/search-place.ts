import type {
  InfrastructureServiceHandler,
  ServerContext,
  SearchPlaceRequest,
  SearchPlaceResponse,
  PlaceMatch,
} from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';
import { ApiError, ValidationError } from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';
import { cachedFetchJsonWithMeta } from '../../../_shared/redis';
import { checkScopedRateLimit, readTrustedRateLimitPrincipal } from '../../../_shared/rate-limit';
import { getClientRateLimitKey } from '../../../_shared/client-ip';
import { sha256Hex } from '../../../_shared/hash';
import { isOrbitalWatchEnabled } from '../../orbital/v1/dark-launch';

const NOMINATIM_SEARCH = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'WorldMonitor/2.0 (https://worldmonitor.app)';
const MAX_RESULTS = 5;
const MIN_QUERY_CHARS = 2;
const MAX_QUERY_CHARS = 200;
const FOUND_TTL_SECONDS = 604_800;
const NOT_FOUND_TTL_SECONDS = 86_400;
// Nominatim's usage policy caps the whole application at one request per second, so name
// search spends the same fail-closed bucket as reverse geocoding.
const PROVIDER_RATE_LIMIT_SCOPE = 'reverse-geocode';
const PROVIDER_RATE_LIMIT_IDENTIFIER = 'global';
// A never-searched name always misses the cache, so one caller may spend only a small share of that bucket.
const CALLER_MISS_SCOPE = 'search-place-provider:caller';
const CALLER_MISS_LIMIT = 6;

/** A refusal of one caller's own budget: it must not arm the shared per-name backoff or reach callers coalesced behind it. */
class CallerBudgetRefusal extends ApiError {
  constructor(statusCode: number, message: string) {
    super(statusCode, message, '');
    this.name = 'CallerBudgetRefusal';
  }
}

export const isCallerBudgetRefusal = (error: unknown): boolean => error instanceof CallerBudgetRefusal;

interface NominatimPlace {
  lat?: string;
  lon?: string;
  display_name?: string;
  type?: string;
  addresstype?: string;
}

/** Case and spacing variants of one name share a cache entry. */
export function normalizePlaceQuery(raw: string): string {
  return raw.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The name is caller text, so the key carries a fixed-width digest of it. */
export const placeSearchCacheKey = async (query: string) => `geocode:search:v2:${await sha256Hex(query)}`;

function toMatch(place: NominatimPlace): PlaceMatch | null {
  const lat = Number(place.lat);
  const lon = Number(place.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const name = (place.display_name ?? '').trim();
  if (!name) return null;
  return { name, lat, lon, kind: place.addresstype || place.type || '' };
}

/**
 * The per-caller miss budget must name the caller. A batched sub-request re-derives its IP from the
 * platform egress, so the gateway-stamped principal (client copies are stripped) is preferred.
 */
export function placeSearchCallerKey(request: Request): string {
  const principal = readTrustedRateLimitPrincipal(request.headers);
  if (principal.principalUserId) return `principal:${principal.principalScope ?? 'session'}:${principal.principalUserId}`;
  return `ip:${getClientRateLimitKey(request)}`;
}

async function fetchPlaces(query: string, caller: string): Promise<PlaceMatch[] | null> {
  const callerLimit = await checkScopedRateLimit(CALLER_MISS_SCOPE, CALLER_MISS_LIMIT, '60 s', caller);
  if (callerLimit.degraded) throw new CallerBudgetRefusal(503, 'Rate-limit service temporarily unavailable');
  if (!callerLimit.allowed) throw new CallerBudgetRefusal(429, 'Too many requests');
  const providerLimit = await checkScopedRateLimit(PROVIDER_RATE_LIMIT_SCOPE, 1, '1 s', PROVIDER_RATE_LIMIT_IDENTIFIER);
  if (providerLimit.degraded) throw new ApiError(503, 'Rate-limit service temporarily unavailable', '');
  if (!providerLimit.allowed) throw new ApiError(429, 'Too many requests', '');

  const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: String(MAX_RESULTS), 'accept-language': 'en' });
  const resp = await fetch(`${NOMINATIM_SEARCH}?${params}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`Nominatim search HTTP ${resp.status}`);
  const body: unknown = await resp.json();
  const places = (Array.isArray(body) ? body : [])
    .map((place) => toMatch(place as NominatimPlace))
    .filter((match): match is PlaceMatch => match !== null)
    .slice(0, MAX_RESULTS);
  return places.length > 0 ? places : null;
}

/** SearchPlace resolves a submitted place name through OpenStreetMap Nominatim, cached per normalised name. */
export const searchPlace: InfrastructureServiceHandler['searchPlace'] = async (
  ctx: ServerContext,
  req: SearchPlaceRequest,
): Promise<SearchPlaceResponse> => {
  // Place search exists for the Orbital Watch lookup, so it ships dark with it (#10710).
  if (!isOrbitalWatchEnabled()) throw new ApiError(404, 'Not found', '');
  const query = normalizePlaceQuery(req.q ?? '');
  if (query.length < MIN_QUERY_CHARS || query.length > MAX_QUERY_CHARS) {
    throw new ValidationError([{ field: 'q', description: `must be ${MIN_QUERY_CHARS} to ${MAX_QUERY_CHARS} characters` }]);
  }
  try {
    const { data: places } = await cachedFetchJsonWithMeta<PlaceMatch[]>(await placeSearchCacheKey(query), FOUND_TTL_SECONDS,
      () => fetchPlaces(query, placeSearchCallerKey(ctx.request)),
      NOT_FOUND_TTL_SECONDS, { cacheFetcherErrors: false, isCallerLocalError: isCallerBudgetRefusal });
    return { places: places ?? [], error: '' };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return { places: [], error: 'Place search failed' };
  }
};
