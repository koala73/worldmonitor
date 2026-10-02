export interface SignalMapPoint {
  lat: number;
  lon: number;
  regionName?: string;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Coordinates for a map CTA. Zero is valid. Missing or non-numeric values are not. */
export function readSignalMapPoint(signal: {
  data?: object | null;
  location?: { lat?: unknown; lon?: unknown; name?: unknown } | null;
}): SignalMapPoint | null {
  const data = signal.data && typeof signal.data === 'object'
    ? signal.data as Record<string, unknown>
    : {};
  const location = signal.location ?? undefined;
  const lat = finiteNumber(data.lat) ?? finiteNumber(location?.lat);
  const lon = finiteNumber(data.lon) ?? finiteNumber(location?.lon);
  if (lat === undefined || lon === undefined) return null;
  const regionFromData = typeof data.regionName === 'string' ? data.regionName : undefined;
  const regionFromLocation = typeof location?.name === 'string' ? location.name : undefined;
  const regionName = regionFromData || regionFromLocation;
  return regionName ? { lat, lon, regionName } : { lat, lon };
}
