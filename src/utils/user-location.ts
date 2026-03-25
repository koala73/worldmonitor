import { isDesktopRuntime, toApiUrl } from '@/services/runtime';

type MapView = 'global' | 'america' | 'mena' | 'eu' | 'asia' | 'latam' | 'africa' | 'oceania';

const ASIA_EAST_TIMEZONES = new Set([
  'Asia/Tokyo', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Hong_Kong',
  'Asia/Taipei', 'Asia/Singapore',
]);

function timezoneToRegion(tz: string): MapView | null {
  if (ASIA_EAST_TIMEZONES.has(tz)) return 'asia';
  const prefix = tz.split('/')[0];
  switch (prefix) {
    case 'America':
    case 'US':
    case 'Canada':
      return 'america';
    case 'Europe':
      return 'eu';
    case 'Africa':
      return 'africa';
    case 'Asia':
      return 'mena';
    case 'Australia':
    case 'Pacific':
      return 'oceania';
    default:
      return null;
  }
}

function coordsToRegion(lat: number, lon: number): MapView {
  if (lat > 15 && lon > 60 && lon < 150) return 'asia';
  if (lat > 10 && lat < 45 && lon > 25 && lon < 65) return 'mena';
  if (lat > -40 && lat < 40 && lon > -25 && lon < 55) return 'africa';
  if (lat > 35 && lat < 72 && lon > -25 && lon < 45) return 'eu';
  if (lat > -60 && lat < 15 && lon > -90 && lon < -30) return 'latam';
  if (lat > 15 && lon > -170 && lon < -50) return 'america';
  if (lat < 0 && lon > 100) return 'oceania';
  return 'global';
}

function getGeolocationPosition(timeout: number): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      timeout,
      maximumAge: 300_000,
    });
  });
}

const TIMEZONE_TO_COUNTRY: Record<string, string> = {
  'Europe/Berlin': 'DE', 'Europe/Vienna': 'AT', 'Europe/Zurich': 'CH',
  'Europe/London': 'GB', 'Europe/Paris': 'FR', 'Europe/Madrid': 'ES',
  'Europe/Rome': 'IT', 'Europe/Amsterdam': 'NL', 'Europe/Brussels': 'BE',
  'Europe/Lisbon': 'PT', 'Europe/Stockholm': 'SE', 'Europe/Oslo': 'NO',
  'Europe/Copenhagen': 'DK', 'Europe/Helsinki': 'FI', 'Europe/Warsaw': 'PL',
  'Europe/Prague': 'CZ', 'Europe/Budapest': 'HU', 'Europe/Bucharest': 'RO',
  'Europe/Athens': 'GR', 'Europe/Dublin': 'IE',
  'Europe/Istanbul': 'TR', 'Europe/Moscow': 'RU', 'Europe/Kiev': 'UA',
  'Europe/Kyiv': 'UA', 'Europe/Belgrade': 'RS', 'Europe/Zagreb': 'HR',
  'Europe/Sofia': 'BG', 'Europe/Bratislava': 'SK', 'Europe/Ljubljana': 'SI',
  'Europe/Tallinn': 'EE', 'Europe/Riga': 'LV', 'Europe/Vilnius': 'LT',
  'Europe/Luxembourg': 'LU',
  'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US',
  'America/Los_Angeles': 'US', 'America/Phoenix': 'US', 'America/Anchorage': 'US',
  'Pacific/Honolulu': 'US', 'America/Toronto': 'CA', 'America/Vancouver': 'CA',
  'America/Edmonton': 'CA', 'America/Winnipeg': 'CA', 'America/Halifax': 'CA',
  'America/Mexico_City': 'MX', 'America/Sao_Paulo': 'BR', 'America/Argentina/Buenos_Aires': 'AR',
  'America/Bogota': 'CO', 'America/Lima': 'PE', 'America/Santiago': 'CL',
  'Asia/Tokyo': 'JP', 'Asia/Seoul': 'KR', 'Asia/Shanghai': 'CN',
  'Asia/Hong_Kong': 'HK', 'Asia/Taipei': 'TW', 'Asia/Singapore': 'SG',
  'Asia/Kolkata': 'IN', 'Asia/Dubai': 'AE', 'Asia/Riyadh': 'SA',
  'Asia/Jerusalem': 'IL', 'Asia/Bangkok': 'TH', 'Asia/Jakarta': 'ID',
  'Asia/Kuala_Lumpur': 'MY', 'Asia/Manila': 'PH', 'Asia/Karachi': 'PK',
  'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU', 'Australia/Perth': 'AU',
  'Pacific/Auckland': 'NZ', 'Africa/Cairo': 'EG', 'Africa/Lagos': 'NG',
  'Africa/Johannesburg': 'ZA', 'Africa/Nairobi': 'KE', 'Africa/Casablanca': 'MA',
};

let _countryPromise: Promise<string | null> | undefined;

async function resolveCountryCodeInternal(): Promise<string | null> {
  if (!isDesktopRuntime()) {
    try {
      const res = await fetch(toApiUrl('/api/geo'), { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json();
        if (data.country && data.country !== 'XX') return data.country;
      }
    } catch { /* fallback to timezone */ }
  }

  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return TIMEZONE_TO_COUNTRY[tz] ?? null;
  } catch {
    return null;
  }
}

export function resolveUserCountryCode(): Promise<string | null> {
  if (!_countryPromise) _countryPromise = resolveCountryCodeInternal();
  return _countryPromise;
}

export interface PreciseCoordinates {
  lat: number;
  lon: number;
}

const SESSION_KEY_COORDS = 'wm-geo-coords';
const SESSION_KEY_REGION = 'wm-geo-region';

function getCachedCoords(): PreciseCoordinates | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY_COORDS);
    if (!raw) return null;
    const { lat, lon } = JSON.parse(raw);
    if (typeof lat === 'number' && typeof lon === 'number') return { lat, lon };
  } catch { /* ignore */ }
  return null;
}

function cacheCoords(coords: PreciseCoordinates): void {
  try { sessionStorage.setItem(SESSION_KEY_COORDS, JSON.stringify(coords)); } catch { /* ignore */ }
}

function getCachedRegion(): MapView | null {
  try {
    const v = sessionStorage.getItem(SESSION_KEY_REGION);
    if (v) return v as MapView;
  } catch { /* ignore */ }
  return null;
}

function cacheRegion(region: MapView): void {
  try { sessionStorage.setItem(SESSION_KEY_REGION, region); } catch { /* ignore */ }
}

export function resolvePreciseUserCoordinates(timeout = 5000): Promise<PreciseCoordinates | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(null);
  const cached = getCachedCoords();
  if (cached) return Promise.resolve(cached);
  return getGeolocationPosition(timeout)
    .then(pos => {
      const coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      cacheCoords(coords);
      return coords;
    })
    .catch(() => null);
}

export async function resolveUserRegion(): Promise<MapView> {
  const cached = getCachedRegion();
  if (cached) return cached;

  // If precise coords already resolved (parallel call or prior page),
  // derive region from them instead of the coarser timezone fallback.
  const cachedPos = getCachedCoords();
  if (cachedPos) {
    const region = coordsToRegion(cachedPos.lat, cachedPos.lon);
    cacheRegion(region);
    return region;
  }

  let tzRegion: MapView = 'global';
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    tzRegion = timezoneToRegion(tz) ?? 'global';
  } catch {
    // Intl unavailable
  }

  try {
    if (typeof navigator === 'undefined' || !navigator.permissions) throw 0;
    const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
    if (status.state === 'granted') {
      const pos = await getGeolocationPosition(3000);
      const region = coordsToRegion(pos.coords.latitude, pos.coords.longitude);
      cacheRegion(region);
      return region;
    }
  } catch {
    // permissions.query unsupported or geolocation failed
  }

  // Don't cache timezone fallback: subsequent variant switches should
  // retry geolocation in case the user has since granted permission.
  return tzRegion;
}
