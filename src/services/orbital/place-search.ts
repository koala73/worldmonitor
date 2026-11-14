import type { GeoPoint } from '../../../shared/orbital/pass-geometry.js';
import { InfrastructureServiceClient } from '@/services/generated-rpc-clients';
import { createLazyClient, getRpcBaseUrl } from '@/services/rpc-client';

export interface PlaceResult {
  name: string;
  point: GeoPoint;
  /** "coordinates", or the OpenStreetMap feature kind of a searched name. */
  kind: string;
}

/**
 * How a submitted query resolved. Only `searched` involved a request, and it carried the
 * typed name alone: coordinates resolve in the browser.
 */
export type PlaceSearchOutcome =
  | { kind: 'empty' }
  | { kind: 'invalid-coordinates' }
  | { kind: 'local'; results: PlaceResult[] }
  | { kind: 'searched'; results: PlaceResult[] }
  | { kind: 'failed' };

const NUMBER = String.raw`([+-]?\d+(?:\.\d+)?)`;
const COORDINATE_PAIR_RE = new RegExp(String.raw`^${NUMBER}\s*°?\s*([NS])?\s*[,;\s]\s*${NUMBER}\s*°?\s*([EW])?$`, 'i');
/** Text made only of digits, signs, separators and hemisphere letters is a coordinate attempt, never a name. */
const COORDINATE_SHAPED_RE = /^(?=.*\d)[\d\s.,;°+\-NSEWnsew]+$/;
export const MIN_PLACE_QUERY_CHARS = 2;
export const MAX_PLACE_QUERY_CHARS = 200;

export function parseTypedCoordinates(text: string): GeoPoint | 'invalid' | null {
  const trimmed = text.trim();
  if (!COORDINATE_SHAPED_RE.test(trimmed)) return null;
  const match = COORDINATE_PAIR_RE.exec(trimmed);
  if (!match) return 'invalid';
  const lat = Number(match[1]) * (match[2]?.toUpperCase() === 'S' ? -1 : 1);
  const lon = Number(match[3]) * (match[4]?.toUpperCase() === 'W' ? -1 : 1);
  if ((match[2] && Number(match[1]) < 0) || (match[4] && Number(match[3]) < 0)) return 'invalid';
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return 'invalid';
  return { lat, lon };
}

const getInfrastructureClient = createLazyClient(() => new InfrastructureServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) }));

/** Resolves a submitted query. Call once per submit, never per keystroke. */
export async function searchPlaces(text: string, signal?: AbortSignal): Promise<PlaceSearchOutcome> {
  const query = text.trim().replace(/\s+/g, ' ');
  if (query.length === 0) return { kind: 'empty' };
  const coordinates = parseTypedCoordinates(query);
  if (coordinates === 'invalid') return { kind: 'invalid-coordinates' };
  if (coordinates) return { kind: 'local', results: [{ name: query, point: coordinates, kind: 'coordinates' }] };
  if (query.length < MIN_PLACE_QUERY_CHARS) return { kind: 'empty' };
  try {
    const response = await getInfrastructureClient().searchPlace({ q: query.slice(0, MAX_PLACE_QUERY_CHARS) }, { signal });
    if (response.error) return { kind: 'failed' };
    return {
      kind: 'searched',
      results: response.places.map((place) => ({ name: place.name, point: { lat: place.lat, lon: place.lon }, kind: place.kind })),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { kind: 'failed' };
  }
}
