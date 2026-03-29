/**
 * Global radiation monitoring
 *
 * Sources:
 *  - Safecast: citizen science radiation network, global coverage
 *    https://api.safecast.org/measurements.json — JSON, CORS-enabled, no key
 *  - RadiationMap.net aggregator (falls back to Safecast data)
 *
 * Units: CPM (counts per minute) — converted to µSv/h using standard tube factor
 * Normal background: 5–50 CPM (0.05–0.5 µSv/h)
 * Elevated: 50–300 CPM
 * High: 300–1000 CPM
 * Very high: 1000+ CPM — potential emergency
 */

export interface RadiationReading {
  id: string;
  lat: number;
  lon: number;
  locationName: string;
  countryCode: string;
  cpm: number;                  // counts per minute
  usvh: number;                 // microsieverts per hour (derived)
  level: 'normal' | 'elevated' | 'high' | 'very_high' | 'extreme';
  capturedAt: Date;
  deviceId: string;
  unit: string;
}

export interface RadiationAlert {
  id: string;
  lat: number;
  lon: number;
  locationName: string;
  countryCode: string;
  cpm: number;
  usvh: number;
  level: Exclude<RadiationReading['level'], 'normal' | 'elevated'>;
  capturedAt: Date;
  severity: 'critical' | 'high' | 'medium';
}

// Safecast public API — returns recent measurements globally, CORS-enabled
// Sorted by captured_at desc, filtered to recent 24h readings
const SAFECAST_API = 'https://api.safecast.org/measurements.json?distance=20000000&latitude=0&longitude=0&unit=cpm&order[captured_at]=desc&per_page=100';

const CACHE_TTL_MS = 20 * 60 * 1000; // 20 min
let cache: { readings: RadiationReading[]; fetchedAt: number } | null = null;

// Standard LND 7317 tube conversion factor: 1 CPM ≈ 0.0057 µSv/h
// (widely used in Geiger counters)
const CPM_TO_USVH = 0.0057;

function cpmToLevel(cpm: number): RadiationReading['level'] {
  if (cpm < 50) return 'normal';
  if (cpm < 300) return 'elevated';
  if (cpm < 1000) return 'high';
  if (cpm < 5000) return 'very_high';
  return 'extreme';
}

interface SafecastMeasurement {
  id: number;
  latitude: number | string;
  longitude: number | string;
  captured_at: string;
  value: number | string;
  unit: string;
  location_name?: string;
  country_code?: string;
  device_id?: number | string;
}

export async function fetchRadiationReadings(): Promise<RadiationReading[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.readings;

  try {
    const res = await fetch(SAFECAST_API, {
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return cache?.readings ?? [];

    const data: SafecastMeasurement[] = await res.json();
    if (!Array.isArray(data)) return cache?.readings ?? [];

    const cutoff = Date.now() - 24 * 3_600_000; // last 24 hours only
    const readings: RadiationReading[] = [];

    for (const m of data) {
      const cpm = typeof m.value === 'number' ? m.value : Number.parseFloat(String(m.value));
      if (isNaN(cpm) || cpm <= 0) continue;

      // Normalize to CPM if unit is different
      let normalizedCpm = cpm;
      if (m.unit && m.unit.toLowerCase().includes('usvh')) {
        normalizedCpm = cpm / CPM_TO_USVH;
      }

      const capturedAt = m.captured_at ? new Date(m.captured_at) : new Date();
      if (capturedAt.getTime() < cutoff) continue;

      const lat = typeof m.latitude === 'number' ? m.latitude : Number.parseFloat(String(m.latitude));
      const lon = typeof m.longitude === 'number' ? m.longitude : Number.parseFloat(String(m.longitude));
      if (isNaN(lat) || isNaN(lon)) continue;

      readings.push({
        id: `safecast-${m.id}`,
        lat,
        lon,
        locationName: m.location_name ?? '',
        countryCode: m.country_code ?? '',
        cpm: Math.round(normalizedCpm),
        usvh: Number.parseFloat((normalizedCpm * CPM_TO_USVH).toFixed(3)),
        level: cpmToLevel(normalizedCpm),
        capturedAt,
        deviceId: String(m.device_id ?? ''),
        unit: m.unit ?? 'cpm',
      });
    }

    cache = { readings, fetchedAt: Date.now() };
    return readings;
  } catch {
    return cache?.readings ?? [];
  }
}

/**
 * Returns only elevated/high/very_high/extreme readings as actionable alerts.
 */
export async function fetchRadiationAlerts(): Promise<RadiationAlert[]> {
  const readings = await fetchRadiationReadings();
  return readings
    .filter(r => r.level === 'high' || r.level === 'very_high' || r.level === 'extreme')
    .map(r => ({
      id: r.id,
      lat: r.lat,
      lon: r.lon,
      locationName: r.locationName,
      countryCode: r.countryCode,
      cpm: r.cpm,
      usvh: r.usvh,
      level: r.level as Exclude<RadiationReading['level'], 'normal' | 'elevated'>,
      capturedAt: r.capturedAt,
      severity: r.level === 'extreme' ? 'critical'
        : (r.level === 'very_high' ? 'high'
        : 'medium'),
    }));
}

export function radiationLevelClass(level: RadiationReading['level']): string {
  return {
    normal: 'eq-row',
    elevated: 'eq-row',
    high: 'eq-row eq-moderate',
    very_high: 'eq-row eq-strong',
    extreme: 'eq-row eq-major',
  }[level] ?? 'eq-row';
}

export function cpmLabel(cpm: number): string {
  if (cpm < 50) return 'Normal';
  if (cpm < 300) return 'Elevated';
  if (cpm < 1000) return 'High';
  if (cpm < 5000) return 'Very High';
  return 'Extreme';
}
