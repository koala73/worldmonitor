import { isDesktopRuntime, toApiUrl } from '@/services/runtime';

export type MapView = 'global' | 'america' | 'mena' | 'eu' | 'asia' | 'latam' | 'africa' | 'oceania';

// Region names follow the countries in shared/iso2-to-region.json, with the map
// views' own choices kept: Mexico, the US and Canada are 'america'; the
// Caribbean and Central America are 'latam'; Turkey and the Caucasus are
// 'mena'; Egypt is 'mena' and the Maghreb 'africa'; Central Asia and Siberia
// are 'asia'.

// US, Canadian, Mexican and Greenland zones. Every other America/* zone is in
// the Caribbean, Central America or South America.
const NORTH_AMERICA_ZONE = /^America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Juneau|Sitka|Yakutat|Nome|Metlakatla|Adak|Atka|Boise|Detroit|Menominee|Indiana\/.+|Indianapolis|Fort_Wayne|Knox_IN|Kentucky\/.+|Louisville|North_Dakota\/.+|Shiprock|Toronto|Montreal|Nipigon|Thunder_Bay|Rainy_River|Atikokan|Coral_Harbour|Vancouver|Edmonton|Calgary|Winnipeg|Regina|Swift_Current|Halifax|Glace_Bay|Moncton|Goose_Bay|St_Johns|Blanc-Sablon|Whitehorse|Dawson|Dawson_Creek|Fort_Nelson|Creston|Yellowknife|Inuvik|Cambridge_Bay|Iqaluit|Pangnirtung|Rankin_Inlet|Resolute|Mexico_City|Cancun|Merida|Monterrey|Matamoros|Chihuahua|Ciudad_Juarez|Ojinaga|Mazatlan|Bahia_Banderas|Hermosillo|Tijuana|Ensenada|Santa_Isabel|Nuuk|Godthab|Danmarkshavn|Scoresbysund|Thule|Miquelon)$/;

// Asia/* zones in the Gulf, the Levant, Iran, Iraq and the Caucasus. Every
// other Asia/* zone is 'asia', apart from Cyprus, which is 'eu'.
const MENA_ASIA_ZONES = new Set([
  'Dubai', 'Muscat', 'Riyadh', 'Qatar', 'Bahrain', 'Kuwait', 'Aden', 'Baghdad',
  'Tehran', 'Jerusalem', 'Tel_Aviv', 'Gaza', 'Hebron', 'Beirut', 'Damascus',
  'Amman', 'Istanbul', 'Tbilisi', 'Yerevan', 'Baku',
]);

const ATLANTIC_ZONES: Record<string, MapView> = {
  Reykjavik: 'eu', Azores: 'eu', Madeira: 'eu', Canary: 'eu', Faroe: 'eu', Faeroe: 'eu',
  Jan_Mayen: 'eu', Bermuda: 'america', Cape_Verde: 'africa', St_Helena: 'africa',
  Stanley: 'latam', South_Georgia: 'latam',
};

const INDIAN_ZONES: Record<string, MapView> = {
  Maldives: 'asia', Chagos: 'asia', Christmas: 'asia', Cocos: 'asia',
  Mauritius: 'africa', Reunion: 'africa', Mayotte: 'africa', Comoro: 'africa',
  Antananarivo: 'africa', Mahe: 'africa',
};

export function timezoneToRegion(tz: string): MapView | null {
  const slash = tz.indexOf('/');
  const prefix = slash < 0 ? tz : tz.slice(0, slash);
  const city = slash < 0 ? '' : tz.slice(slash + 1);
  switch (prefix) {
    case 'America':
      return NORTH_AMERICA_ZONE.test(tz) ? 'america' : 'latam';
    case 'US':
    case 'Canada':
    case 'Mexico':
      return 'america';
    case 'Brazil':
    case 'Chile':
      return 'latam';
    case 'Europe':
      if (city === 'Istanbul') return 'mena';
      return 'eu';
    case 'Arctic':
      return 'eu';
    case 'Africa':
      return city === 'Cairo' ? 'mena' : 'africa';
    case 'Asia':
      if (city === 'Nicosia' || city === 'Famagusta') return 'eu';
      return MENA_ASIA_ZONES.has(city) ? 'mena' : 'asia';
    case 'Atlantic':
      return ATLANTIC_ZONES[city] ?? null;
    case 'Indian':
      return INDIAN_ZONES[city] ?? null;
    case 'Australia':
      return 'oceania';
    case 'Pacific':
      if (city === 'Honolulu' || city === 'Johnston') return 'america';
      if (city === 'Galapagos' || city === 'Easter') return 'latam';
      return 'oceania';
    default:
      return null;
  }
}

// Southern Europe and the North African shore share 35-38°N west of 25°E.
// Morocco tops out below 36.0°N (Spain's Tarifa is 36.01°N), Algeria below
// 37.1°N (Spain's Águilas is 37.4°N), and Tunisia from 8°E below 37.6°N (Cape
// Serrat 37.22°N, Ras Ben Sakka 37.35°N, La Galite 37.53°N; Sardinia starts at
// 38.86°N, and Sicily and Pantelleria lie east of 11.5°E).
function isNorthAfricanCoast(lat: number, lon: number): boolean {
  if (lon < -1.8) return lat < 36.0;
  if (lon < 8.0) return lat < 37.1;
  if (lon < 11.5) return lat < 37.6;
  return false;
}

// European land inside the Middle East box (10-45°N, 25-60°E). The lines follow
// the Greek and Bulgarian borders with Turkey (Edirne and Kırklareli are
// Turkish, Burgas and Malko Tarnovo Bulgarian), the Black Sea (Turkey's coast
// stays south of 42.15°N, so Crimea, Romania and Bulgaria are north of it) and
// the Greater Caucasus (Sochi, Vladikavkaz, Grozny and Derbent are Russian;
// Sukhumi, Tbilisi and Baku are not). The boxes after them are Cyprus and the
// Greek islands off Turkey's coast.
function isEuropeInMenaBox(lat: number, lon: number): boolean {
  if (lon < 26.3 && lat > 40.6) return true;
  if (lon >= 26.3 && lon < 28.3 && lat > 41.7 + (lon - 26.3) * 0.176) return true;
  if (lon >= 28.3 && lon < 39.9 && lat > 42.15) return true;
  if (lon >= 39.9 && lon < 42 && lat > 43.4) return true;
  if (lon >= 42 && lon < 46 && lat > 42.8) return true;
  if (lon >= 46 && lon < 49.5 && lat > 41.9) return true;
  if (lat > 34.5 && lat < 35.75 && lon > 32.2 && lon < 34.65) return true; // Cyprus
  if (lat < 34.8) return false;
  if (lon < 26.0) return true; // western Aegean, Lemnos, western Crete
  if (lat < 35.7 && lon < 26.4) return true; // eastern Crete
  if (lat > 38.95 && lat < 39.45 && lon < 26.65) return true; // Lesbos
  if (lat > 38.15 && lat < 38.62 && lon < 26.2) return true; // Chios
  if (lat > 37.55 && lat < 37.82 && lon < 27.08) return true; // Samos, Ikaria
  if (lat > 36.7 && lat < 37.5 && lon < 27.05) return true; // Kalymnos to Agathonisi
  if (lat > 36.7 && lat < 36.95 && lon < 27.33) return true; // Kos
  return lat < 36.62 && lon < 28.3; // Rhodes, Karpathos, Symi
}

// African land inside the Middle East box: the Horn below 12.5°N and west of
// 51.6°E (Arabia ends at 12.6°N; Yemen's Socotra lies east of Cape
// Guardafui), and Sudan and Eritrea west of a line down the Red Sea (Port
// Sudan and Massawa are west of it; Jeddah, Jizan and Hodeidah east).
function isAfricaInMenaBox(lat: number, lon: number): boolean {
  if (lat < 12.5 && lon < 51.6) return true;
  return lat < 22 && lon < 38 + 0.55 * (22 - lat);
}

// Kazakhstan west of 60°E (Atyrau, Oral, Aktobe; Astrakhan and Orenburg are
// Russian) and Turkmenistan (Ashgabat is north of Iran's Bojnurd and Mashhad).
function isCentralAsiaWestOf60(lat: number, lon: number): boolean {
  if (lon < 49.5 || lon > 60 || lat >= 51.5) return false;
  return lat >= 42 || (lat >= 37.7 && lon >= 52.5);
}

function isOceania(lat: number, lon: number): boolean {
  if (lat <= -60) return false;
  if (lat < -10.6 && lon > 110) return true; // Australia, New Zealand
  if (lat < 0 && (lon >= 141 || lon <= -130)) return true; // PNG to Polynesia
  if (lat >= 0 && lat < 23 && lon > 130) return true; // Palau, Guam, Micronesia
  return lat >= 0 && lat < 10 && lon < -150; // Line Islands
}

function isLatinAmerica(lat: number, lon: number): boolean {
  if (lat <= -60 || lon >= -30 || lon <= -115) return false;
  // Central America: Mexico reaches 14.5°N only at the Suchiate (92.2°W), and
  // Guatemala's Petén, Belize and the Bay Islands run up to 17.82°N east of
  // 90.98°W. Northern Belize follows the Río Hondo up to Corozal (Chetumal is
  // Mexican), and Ambergris Caye stops south of Mexico's Xcalak.
  if (lat < 14.5) return true;
  if (lat < 16.07 && lon > -92.2) return true;
  if (lat < 17.82 && lon > -90.98) return true;
  if (lon > -89.15 && lon < -88.3 && lat < 17.82 + (lon + 89.15) * 0.79) return true;
  if (lon >= -88.3 && lon < -87.4 && lat < 18.15) return true;
  // The Caribbean (Key West is 24.55°N, Cancún 86.85°W) and the Bahamas
  // (Florida's coast is west of 79.35°W).
  if (lat >= 10 && lat < 23.6 && lon > -85.2 && lon < -59) return true;
  return lat > 20.9 && lat < 27.3 && lon > -79.35 && lon < -72.7;
}

export function coordsToRegion(lat: number, lon: number): MapView {
  // Atlantic islands of Portugal and Spain: Azores, Madeira, Canaries.
  if (lat > 36.8 && lat < 39.8 && lon > -31.4 && lon < -24.9) return 'eu';
  if (lat > 32.3 && lat < 33.2 && lon > -17.4 && lon < -16.2) return 'eu';
  if (lat > 27.5 && lat < 29.5 && lon > -18.3 && lon < -13.3) return 'eu';
  if (isOceania(lat, lon)) return 'oceania';
  if (isLatinAmerica(lat, lon)) return 'latam';
  // Greenland's east coast (Iceland is 63.2-66.7°N, 24.6-13.4°W).
  const iceland = lat > 63.2 && lat < 66.7 && lon > -24.6 && lon < -13.4;
  if (lat > 59.5 && lon >= -75 && lon < -11 && !iceland) return 'america';
  if (lat > 14.5 && lon >= -180 && lon < -50) return 'america';
  if (isCentralAsiaWestOf60(lat, lon)) return 'asia';
  if (lat > 15 && lon > 60) return 'asia';
  if (lat > -10.6 && lat <= 15 && lon > 65 && lon < 141) return 'asia';
  if (lat > 10 && lat < 45 && lon > 25 && lon <= 60) {
    if (isEuropeInMenaBox(lat, lon)) return 'eu';
    if (isAfricaInMenaBox(lat, lon)) return 'africa';
    return 'mena';
  }
  if (lat > 35 && lat < 82 && lon > -25 && lon <= 60 && !isNorthAfricanCoast(lat, lon)) return 'eu';
  if (lat > -40 && lat < 40 && lon > -26 && lon < 55) return 'africa';
  if (lat > -40 && lat < 0 && lon >= 55 && lon < 64) return 'africa'; // Mascarenes
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

/**
 * Shared position-request budget for dashboard startup (#7778). Both the
 * initial-region and precise-coordinate consumers race the same in-flight
 * geolocation call against this budget (5,000 ms) so a granted lookup issues
 * exactly one physical request instead of two overlapping ones. Kept in this
 * module (not a startup framework) alongside the existing location utility.
 */
export const SHARED_POSITION_TIMEOUT_MS = 5000;

/**
 * Single in-flight position request shared by the region and precise-coordinate
 * consumers. The entry is cleared on success AND failure so a later explicit
 * attempt (e.g. a user-triggered recenter) can retry instead of reusing a
 * settled rejection. Module state is keyed per page lifetime, which also
 * bounds the "one automatic recenter per startup" rule in App startup flow.
 */
let _sharedPositionRequest: Promise<GeolocationPosition> | null = null;

function sharedGeolocationRequest(): Promise<GeolocationPosition> | null {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return null;
  if (!_sharedPositionRequest) {
    const request = getGeolocationPosition(SHARED_POSITION_TIMEOUT_MS);
    _sharedPositionRequest = request;
    // Clear on settle so a later explicit attempt can retry. Attach the
    // clearing handler to a derived promise so the shared request itself
    // keeps its original fulfillment value for every consumer.
    void request.then(
      () => { if (_sharedPositionRequest === request) _sharedPositionRequest = null; },
      () => { if (_sharedPositionRequest === request) _sharedPositionRequest = null; },
    );
  }
  return _sharedPositionRequest;
}

/** Test hook: drop the cached in-flight request between deterministic cases. */
export function __resetSharedPositionRequestForTests(): void {
  _sharedPositionRequest = null;
}

/**
 * Synchronous initial-region guess that never touches permission or position
 * APIs: usable cached region, else usable cached coordinates, else timezone,
 * else global. Layout and map construction use this so readiness does not wait
 * for the asynchronous position work. Desktop map startup stays global.
 */
export function initialRegionFromCache(isMobile: boolean): MapView {
  if (!isMobile) return 'global';
  const cached = getCachedRegion();
  if (cached) return cached;
  const cachedPos = getCachedCoords();
  if (cachedPos) {
    const region = coordsToRegion(cachedPos.lat, cachedPos.lon);
    cacheRegion(region);
    return region;
  }
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return timezoneToRegion(tz) ?? 'global';
  } catch {
    return 'global';
  }
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

export async function resolvePreciseUserCoordinates(timeout = 5000): Promise<PreciseCoordinates | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return null;
  const cached = getCachedCoords();
  if (cached) return cached;
  // Never trigger a geolocation permission prompt on page load — only use precise
  // coordinates when the user has ALREADY granted permission (e.g. a prior visit).
  // Otherwise fall back to the timezone-based region (resolveUserRegion). This
  // avoids the on-load prompt (poor UX, almost always denied) and the Lighthouse
  // "Requests the geolocation permission on page load" Best-Practices penalty.
  try {
    if (!navigator.permissions) return null;
    const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
    if (status.state !== 'granted') return null;
  } catch {
    return null; // permissions.query unsupported → stay silent, no prompt
  }
  try {
    const request = sharedGeolocationRequest();
    if (!request) return null;
    const pos = timeout === SHARED_POSITION_TIMEOUT_MS
      ? await request
      : await Promise.race([
        request,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('position-timeout')), timeout);
        }),
      ]);
    const coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    cacheCoords(coords);
    return coords;
  } catch {
    return null;
  }
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
      // Share the single in-flight request with the precise-coordinate
      // consumer (#7778) instead of issuing a second overlapping lookup.
      const request = sharedGeolocationRequest();
      if (!request) return tzRegion;
      const pos = await request;
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
