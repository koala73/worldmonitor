/** What the satellite pass lookup needs from the dashboard it opens over, without importing it. */
export interface LookupMapHandle {
  getCenter(): { lat: number; lon: number } | null;
}

let mapAccess: () => LookupMapHandle | null = () => null;
let lookupOpen = false;
/** Where the lookup left the map: centred on the looked-up place, which the URL must not carry. */
let leftAt: { lat: number; lon: number } | null = null;

export function connectOrbitalLookupMap(access: () => LookupMapHandle | null): void {
  mapAccess = access;
}

/** Globe spin and a sideways pan turn only the longitude, so the map still carries the looked-up latitude. */
const sameLatitude = (a: { lat: number }, b: { lat: number }) => Math.abs(a.lat - b.lat) < 1e-6;

/**
 * While the lookup is open, and after it closes until the map leaves that latitude, the map URL sync leaves the map centre out,
 * so a looked-up place stays out of the query string.
 */
export function isOrbitalLookupOpen(): boolean {
  if (lookupOpen) return true;
  if (!leftAt) return false;
  const centre = mapAccess()?.getCenter();
  if (centre && sameLatitude(centre, leftAt)) return true;
  leftAt = null;
  return false;
}

export function setOrbitalLookupOpen(open: boolean): void {
  if (lookupOpen && !open) leftAt = mapAccess()?.getCenter() ?? null;
  if (open) leftAt = null;
  lookupOpen = open;
}
