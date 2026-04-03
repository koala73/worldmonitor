type LooseRecord = Record<string, unknown>;

export interface AirQualityStationRecord {
  city: string;
  countryCode: string;
  lat: number;
  lng: number;
  pm25: number;
  aqi: number;
  riskLevel: string;
  pollutant: string;
  measuredAt: number;
  source: string;
}

function asRecord(value: unknown): LooseRecord | null {
  return value != null && typeof value === 'object' ? (value as LooseRecord) : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function pickKey(record: LooseRecord, snakeKey: string, camelKey: string): unknown {
  if (record[snakeKey] != null) return record[snakeKey];
  return record[camelKey];
}

export function normalizeAirQualityStation(value: unknown): AirQualityStationRecord | null {
  const record = asRecord(value);
  if (!record) return null;

  const city = asString(record.city);
  const lat = asNumber(record.lat);
  const lng = asNumber(record.lng);
  const pm25 = asNumber(record.pm25);
  const aqi = asNumber(record.aqi);
  const measuredAt = asNumber(pickKey(record, 'measured_at', 'measuredAt'));

  if (!city || lat == null || lng == null || pm25 == null || aqi == null || measuredAt == null) {
    return null;
  }

  return {
    city,
    countryCode: asString(pickKey(record, 'country_code', 'countryCode')),
    lat,
    lng,
    pm25,
    aqi: Math.max(0, Math.min(500, Math.round(aqi))),
    riskLevel: asString(pickKey(record, 'risk_level', 'riskLevel')),
    pollutant: asString(record.pollutant) || 'pm25',
    measuredAt: Math.round(measuredAt),
    source: asString(record.source),
  };
}

export function normalizeAirQualityStations(value: unknown): AirQualityStationRecord[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeAirQualityStation(entry))
    .filter((entry): entry is AirQualityStationRecord => entry != null);
}

export function normalizeAirQualityFetchedAt(value: unknown): number {
  const record = asRecord(value);
  if (!record) return 0;
  const numeric = asNumber(pickKey(record, 'fetched_at', 'fetchedAt'));
  return numeric == null ? 0 : Math.round(numeric);
}
