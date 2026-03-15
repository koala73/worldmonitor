// Open-Meteo Air Quality API — completely free, no API key, CORS-enabled
// Docs: https://open-meteo.com/en/docs/air-quality-api
// Covers US AQI, European AQI, PM2.5, PM10, ozone, NO2, SO2

export interface AirQualityReading {
  city: string;
  country: string;
  lat: number;
  lon: number;
  aqi: number;               // US AQI 0–500
  aqiLevel: AqiLevel;
  pm25: number | null;       // µg/m³
  pm10: number | null;       // µg/m³
  ozone: number | null;      // µg/m³
  no2: number | null;        // µg/m³
  updatedAt: Date;
}

export type AqiLevel = 'good' | 'moderate' | 'sensitive' | 'unhealthy' | 'very_unhealthy' | 'hazardous';

// Major world cities for global air quality snapshot
const MONITORED_CITIES: Array<{ city: string; country: string; lat: number; lon: number }> = [
  { city: 'New York', country: 'US', lat: 40.71, lon: -74.01 },
  { city: 'Los Angeles', country: 'US', lat: 34.05, lon: -118.24 },
  { city: 'London', country: 'UK', lat: 51.51, lon: -0.13 },
  { city: 'Beijing', country: 'CN', lat: 39.91, lon: 116.39 },
  { city: 'Delhi', country: 'IN', lat: 28.61, lon: 77.21 },
  { city: 'Lahore', country: 'PK', lat: 31.55, lon: 74.34 },
  { city: 'Dhaka', country: 'BD', lat: 23.73, lon: 90.41 },
  { city: 'Tehran', country: 'IR', lat: 35.69, lon: 51.39 },
  { city: 'Cairo', country: 'EG', lat: 30.04, lon: 31.24 },
  { city: 'Jakarta', country: 'ID', lat: -6.21, lon: 106.85 },
  { city: 'Ulaanbaatar', country: 'MN', lat: 47.89, lon: 106.91 },
  { city: 'Paris', country: 'FR', lat: 48.85, lon: 2.35 },
  { city: 'Tokyo', country: 'JP', lat: 35.68, lon: 139.69 },
  { city: 'São Paulo', country: 'BR', lat: -23.55, lon: -46.63 },
  { city: 'Nairobi', country: 'KE', lat: -1.29, lon: 36.82 },
  { city: 'Riyadh', country: 'SA', lat: 24.69, lon: 46.72 },
  { city: 'Moscow', country: 'RU', lat: 55.75, lon: 37.62 },
  { city: 'Sydney', country: 'AU', lat: -33.87, lon: 151.21 },
];

function aqiFromPm25(pm25: number): number {
  // EPA breakpoints
  const bp: Array<[number, number, number, number]> = [
    [0, 12.0, 0, 50],
    [12.1, 35.4, 51, 100],
    [35.5, 55.4, 101, 150],
    [55.5, 150.4, 151, 200],
    [150.5, 250.4, 201, 300],
    [250.5, 500.4, 301, 500],
  ];
  for (const [cLo, cHi, iLo, iHi] of bp) {
    if (pm25 >= cLo && pm25 <= cHi) {
      return Math.round(((iHi - iLo) / (cHi - cLo)) * (pm25 - cLo) + iLo);
    }
  }
  return Math.min(500, Math.round(pm25 * 2));
}

function aqiLevel(aqi: number): AqiLevel {
  if (aqi <= 50) return 'good';
  if (aqi <= 100) return 'moderate';
  if (aqi <= 150) return 'sensitive';
  if (aqi <= 200) return 'unhealthy';
  if (aqi <= 300) return 'very_unhealthy';
  return 'hazardous';
}

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min
let cache: { readings: AirQualityReading[]; fetchedAt: number } | null = null;

async function fetchCityAQ(city: typeof MONITORED_CITIES[0]): Promise<AirQualityReading | null> {
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${city.lat}&longitude=${city.lon}&current=us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide&timezone=auto`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = await res.json() as {
      current: {
        us_aqi?: number;
        pm2_5?: number;
        pm10?: number;
        ozone?: number;
        nitrogen_dioxide?: number;
        time?: string;
      };
    };
    const c = json.current ?? {};
    const pm25 = c.pm2_5 ?? null;
    const rawAqi = c.us_aqi ?? (pm25 !== null ? aqiFromPm25(pm25) : null);
    if (rawAqi === null) return null;
    return {
      city: city.city,
      country: city.country,
      lat: city.lat,
      lon: city.lon,
      aqi: Math.round(rawAqi),
      aqiLevel: aqiLevel(rawAqi),
      pm25,
      pm10: c.pm10 ?? null,
      ozone: c.ozone ?? null,
      no2: c.nitrogen_dioxide ?? null,
      updatedAt: new Date(),
    };
  } catch {
    return null;
  }
}

export async function fetchGlobalAirQuality(): Promise<AirQualityReading[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.readings;
  }

  // Fetch all cities in parallel (stagger to avoid rate limiting)
  const results = await Promise.allSettled(
    MONITORED_CITIES.map(c => fetchCityAQ(c)),
  );

  const readings: AirQualityReading[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) readings.push(r.value);
  }

  // Sort worst AQI first
  readings.sort((a, b) => b.aqi - a.aqi);

  cache = { readings, fetchedAt: Date.now() };
  return readings;
}

export interface AirQualityAlert {
  id: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  aqi: number;
  aqiLevel: AqiLevel;
  pm25: number | null;
  alertedAt: Date;
}

/**
 * Returns cities currently at Unhealthy (AQI > 150) or worse thresholds.
 * AQI 151–200 = Unhealthy, 201–300 = Very Unhealthy, 301–500 = Hazardous.
 */
export async function fetchAirQualityAlerts(): Promise<AirQualityAlert[]> {
  const readings = await fetchGlobalAirQuality();
  return readings
    .filter(r => r.aqi > 150)
    .map(r => ({
      id: `aq-${r.city.toLowerCase().replace(/\s+/g, '-')}-${r.country.toLowerCase()}`,
      city: r.city,
      country: r.country,
      lat: r.lat,
      lon: r.lon,
      aqi: r.aqi,
      aqiLevel: r.aqiLevel,
      pm25: r.pm25,
      alertedAt: r.updatedAt,
    }));
}

export function aqiAlertSeverityClass(aqi: number): string {
  if (aqi > 300) return 'eq-row eq-major';
  if (aqi > 200) return 'eq-row eq-strong';
  if (aqi > 150) return 'eq-row eq-moderate';
  return 'eq-row';
}
