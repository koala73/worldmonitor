import tzLookup from '@photostructure/tz-lookup';

export interface PlaceTimeZone {
  /** IANA name, e.g. `Asia/Dubai`; an `Etc/GMT±n` zone over open sea. */
  zone: string;
  /** Short name at the given moment, e.g. `EST`, or `UTC+4` where the zone has no letters. */
  abbr: string;
}

/** The local time zone at a point, looked up in the browser so the point stays here. */
export function placeTimeZone(point: { lat: number; lon: number }, atMs = Date.now()): PlaceTimeZone | null {
  let zone: string;
  try {
    zone = tzLookup(point.lat, point.lon);
  } catch {
    return null;
  }
  return { zone, abbr: zoneAbbreviation(zone, atMs) };
}

export function zoneAbbreviation(zone: string, atMs: number): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
    .formatToParts(atMs).find((part) => part.type === 'timeZoneName')?.value ?? 'UTC';
  return name.replace(/^GMT/, 'UTC');
}

/** `ASIA/DUBAI · UTC+4`, or just `UTC+4` for a sea zone whose IANA sign reads backwards. */
export function placeTimeZoneLabel(tz: PlaceTimeZone): string {
  if (tz.zone.startsWith('Etc/')) return tz.abbr;
  return `${tz.zone.replace(/_/g, ' ').toUpperCase()} · ${tz.abbr}`;
}
