/**
 * Location-based proximity alert filtering
 *
 * During a personal emergency, a global dashboard showing 200 events worldwide
 * is overwhelming. This utility filters alerts to a user-configurable radius
 * around their home location (or current GPS position).
 *
 * Features:
 *  - Haversine distance calculation for any lat/lon pair
 *  - User home location stored in localStorage
 *  - Optional live GPS position
 *  - Radius presets: 50km (city), 250km (region), 1000km (country)
 *  - Generic filter function works with any alert type that has lat/lon
 *
 * Storage key: 'wm_proximity_config'
 */

export interface UserLocation {
  lat: number;
  lon: number;
  label: string;        // e.g. "New York, NY" or "Current Location"
  source: 'manual' | 'gps' | 'ip';
  setAt: number;        // unix ms
}

export interface ProximityConfig {
  enabled: boolean;
  radiusKm: number;
  location: UserLocation | null;
}

export const RADIUS_PRESETS = [
  { label: 'City (50 km)', km: 50 },
  { label: 'Region (250 km)', km: 250 },
  { label: 'Country (1000 km)', km: 1000 },
  { label: 'Continent (3000 km)', km: 3000 },
] as const;

const STORAGE_KEY = 'wm_proximity_config';
const DEFAULT_RADIUS_KM = 500;

export function loadProximityConfig(): ProximityConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as ProximityConfig;
  } catch { /* noop */ }
  return { enabled: false, radiusKm: DEFAULT_RADIUS_KM, location: null };
}

export function saveProximityConfig(config: ProximityConfig): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch { /* noop */ }
}

/** Haversine distance in kilometres */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface HasCoordinates {
  lat: number | null;
  lon: number | null;
}

/**
 * Filter a list of alerts to those within the configured radius.
 * Items without coordinates pass through (cannot be filtered).
 */
export function filterByProximity<T extends HasCoordinates>(
  items: T[],
  config: ProximityConfig | null
): T[] {
  if (!config?.enabled || !config.location) return items;
  const { lat: homeLat, lon: homeLon } = config.location;
  return items.filter(item => {
    if (item.lat === null || item.lon === null) return true; // pass through
    const dist = haversineKm(homeLat, homeLon, item.lat, item.lon);
    return dist <= config.radiusKm;
  });
}

/**
 * Get distance from user location to an alert (null if no config or coords).
 */
export function distanceToAlert(
  item: HasCoordinates,
  config: ProximityConfig | null
): number | null {
  if (!config?.location || item.lat === null || item.lon === null) return null;
  return haversineKm(config.location.lat, config.location.lon, item.lat, item.lon);
}

/**
 * Attempt to get current GPS location. Requires user permission.
 */
export async function getCurrentGpsLocation(): Promise<UserLocation> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Geolocation not supported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => {
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          label: `${pos.coords.latitude.toFixed(3)}, ${pos.coords.longitude.toFixed(3)}`,
          source: 'gps',
          setAt: Date.now(),
        });
      },
      err => reject(err),
      { timeout: 10_000, maximumAge: 300_000 }
    );
  });
}

/**
 * Reverse-geocode a lat/lon to a human-readable label using the Nominatim API.
 * Nominatim is free, open, no key required.
 */
export async function reverseGeocode(lat: number, lon: number): Promise<string> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { 'Accept-Language': 'en', 'User-Agent': 'WorldMonitor/1.0' },
    });
    if (!res.ok) throw new Error('Nominatim failed');
    const data = await res.json() as { display_name?: string; address?: { city?: string; state?: string; country?: string } };
    const addr = data.address;
    if (addr) {
      const parts = [addr.city, addr.state, addr.country].filter(Boolean);
      if (parts.length > 0) return parts.join(', ');
    }
    return data.display_name?.split(',').slice(0, 2).join(',').trim() ?? `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
  } catch {
    return `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  }
}

/**
 * Set user home location from GPS + reverse geocode.
 */
export async function setLocationFromGps(): Promise<UserLocation> {
  const location = await getCurrentGpsLocation();
  const label = await reverseGeocode(location.lat, location.lon);
  const labelled: UserLocation = { ...location, label };
  const config = loadProximityConfig();
  saveProximityConfig({ ...config, location: labelled, enabled: true });
  return labelled;
}

/**
 * Set user home location manually.
 */
export function setLocationManual(lat: number, lon: number, label: string): UserLocation {
  const location: UserLocation = { lat, lon, label, source: 'manual', setAt: Date.now() };
  const config = loadProximityConfig();
  saveProximityConfig({ ...config, location, enabled: true });
  return location;
}
