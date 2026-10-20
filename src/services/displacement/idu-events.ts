// IDMC Internal Displacement Updates, mapped for the map layer and panel. Kept
// free of browser-only imports so tests can load it directly.

/** One IDMC figure at one location. */
export interface DisplacementEventPoint {
  id: string;
  countryCode: string;
  countryName: string;
  conflict: boolean;
  figure: number;
  displacementDate: string;
  eventName: string;
  hazardType: string;
  locationName: string;
  lat: number;
  lon: number;
}

export interface DisplacementEventCountrySummary {
  countryCode: string;
  countryName: string;
  displaced30d: number;
  conflict30d: number;
  disaster30d: number;
  newlyReported7d: number;
  surge: boolean;
  /** Location of the country's largest figure in the window, for map focus. */
  lat?: number;
  lon?: number;
}

export interface DisplacementEventsData {
  countries: DisplacementEventCountrySummary[];
  points: DisplacementEventPoint[];
  /** ISO3 codes whose file failed at seed time: no data, not zero displacement. */
  missingCountries: string[];
  /** YYYY-MM-DD the snapshot covers up to; empty when unknown. */
  asOf: string;
}

export const EMPTY_DISPLACEMENT_EVENTS: DisplacementEventsData = { countries: [], points: [], missingCountries: [], asOf: '' };

// The seeder's window is the 180 dates ending on the snapshot date
// (WINDOW_DAYS in scripts/seed-idmc-idu-displacement.mjs), and bootstrap strips
// the seed envelope, so this is the one date the browser has.
const WINDOW_DAYS = 180;
function snapshotDate(windowFrom: unknown): string {
  if (typeof windowFrom !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(windowFrom)) return '';
  const start = Date.parse(`${windowFrom}T00:00:00Z`);
  if (!Number.isFinite(start)) return '';
  return new Date(start + (WINDOW_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
}

type Row = Record<string, unknown>;
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter((v): v is Row => !!v && typeof v === 'object') : []);

/**
 * Maps the `displacement:idmc-idu:v1` snapshot (scripts/seed-idmc-idu-displacement.mjs)
 * read through the on-demand bootstrap key. Countries with nothing displaced in
 * the last 30 days and nothing newly published this week stay off the panel;
 * the map still shows their older figures from the 180-day window.
 */
export function toDisplacementEventsData(snapshot: unknown): DisplacementEventsData {
  if (!snapshot || typeof snapshot !== 'object') return EMPTY_DISPLACEMENT_EVENTS;
  const { countries: rawCountries, events: rawEvents, missingCountries, windowFrom } = snapshot as Row;
  if (!Array.isArray(rawCountries) || !Array.isArray(rawEvents)) return EMPTY_DISPLACEMENT_EVENTS;

  const focus = new Map<string, { figure: number; lat: number; lon: number }>();
  const points: DisplacementEventPoint[] = [];
  for (const ev of rows(rawEvents)) {
    const figure = num(ev.figure);
    const location = ev.location as { latitude?: unknown; longitude?: unknown } | undefined;
    const lat = location?.latitude;
    const lon = location?.longitude;
    if (figure <= 0 || typeof lat !== 'number' || typeof lon !== 'number') continue;
    const countryCode = str(ev.countryCode);
    points.push({
      id: str(ev.id),
      countryCode,
      countryName: str(ev.countryName) || countryCode,
      conflict: ev.displacementType === 'Conflict',
      figure,
      displacementDate: str(ev.displacementDate),
      eventName: str(ev.eventName),
      hazardType: str(ev.hazardType),
      locationName: str(ev.locationName),
      lat,
      lon,
    });
    const best = focus.get(countryCode);
    if (!best || figure > best.figure) focus.set(countryCode, { figure, lat, lon });
  }
  const countries = rows(rawCountries)
    .map((c) => {
      const countryCode = str(c.countryCode);
      return {
        countryCode,
        countryName: str(c.countryName) || countryCode,
        displaced30d: num(c.displaced30d),
        conflict30d: num(c.conflict30d),
        disaster30d: num(c.disaster30d),
        newlyReported7d: num(c.newlyReported7d),
        surge: c.surge === true,
        lat: focus.get(countryCode)?.lat,
        lon: focus.get(countryCode)?.lon,
      };
    })
    .filter((c) => c.displaced30d > 0 || c.newlyReported7d > 0)
    .sort((a, b) => Number(b.surge) - Number(a.surge) || b.displaced30d - a.displaced30d || b.newlyReported7d - a.newlyReported7d);
  // Largest first, so small circles are drawn on top of big ones.
  points.sort((a, b) => b.figure - a.figure);
  return {
    countries,
    points,
    missingCountries: Array.isArray(missingCountries) ? missingCountries.filter((c): c is string => typeof c === 'string') : [],
    asOf: snapshotDate(windowFrom),
  };
}
