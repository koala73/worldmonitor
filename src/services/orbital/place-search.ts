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
const UNSIGNED = String.raw`(\d+(?:\.\d+)?)`;
/** Decimal degrees, or degrees with minutes and seconds, then an optional hemisphere. */
const COMPONENT = String.raw`${NUMBER}\s*°?\s*(?:${UNSIGNED}\s*['′]\s*)?(?:${UNSIGNED}\s*(?:["″]|'')\s*)?([NSEW])?`;
const COORDINATE_PAIR_RE = new RegExp(String.raw`^${COMPONENT}\s*[,;\s]\s*${COMPONENT}$`, 'i');
/** Text made only of digits, signs, separators, brackets, degree marks and hemisphere letters is a coordinate attempt, never a name. */
const COORDINATE_SHAPED_RE = /^(?=.*\d)[\d\s.,;°'"′″()[\]+\-NSEWnsew]+$/;
export const MIN_PLACE_QUERY_CHARS = 2;
export const MAX_PLACE_QUERY_CHARS = 200;

function componentDegrees(degrees: string, minutes: string | undefined, seconds: string | undefined, hemisphere: string | undefined, negative: string): number | null {
  const whole = Number(degrees);
  const min = minutes === undefined ? 0 : Number(minutes);
  const sec = seconds === undefined ? 0 : Number(seconds);
  if (min >= 60 || sec >= 60) return null;
  if ((minutes !== undefined || seconds !== undefined) && !Number.isInteger(whole)) return null;
  if (hemisphere && whole < 0) return null;
  const magnitude = Math.abs(whole) + min / 60 + sec / 3600;
  const sign = whole < 0 || Object.is(whole, -0) || hemisphere?.toUpperCase() === negative ? -1 : 1;
  return sign * magnitude;
}

export function parseTypedCoordinates(text: string): GeoPoint | 'invalid' | null {
  const trimmed = text.trim();
  if (!COORDINATE_SHAPED_RE.test(trimmed)) return null;
  const match = COORDINATE_PAIR_RE.exec(trimmed.replace(/^[([]\s*|\s*[)\]]$/g, ''));
  if (!match) return 'invalid';
  const latHemisphere = match[4]?.toUpperCase();
  const lonHemisphere = match[8]?.toUpperCase();
  if ((latHemisphere && !'NS'.includes(latHemisphere)) || (lonHemisphere && !'EW'.includes(lonHemisphere))) return 'invalid';
  const lat = componentDegrees(match[1]!, match[2], match[3], latHemisphere, 'S');
  const lon = componentDegrees(match[5]!, match[6], match[7], lonHemisphere, 'W');
  if (lat === null || lon === null) return 'invalid';
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
