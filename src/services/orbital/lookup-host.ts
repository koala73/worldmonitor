/** What the satellite pass lookup needs from the dashboard it opens over, without importing it. */
export interface LookupMapHandle {
  setCenter(lat: number, lon: number, zoom?: number): unknown;
}

let mapAccess: () => LookupMapHandle | null = () => null;
let lookupOpen = false;

export function connectOrbitalLookupMap(access: () => LookupMapHandle | null): void {
  mapAccess = access;
}

export function orbitalLookupMap(): LookupMapHandle | null {
  return mapAccess();
}

/** While the lookup is open the map URL sync leaves the map centre out, so a looked-up place stays out of the query string. */
export function isOrbitalLookupOpen(): boolean {
  return lookupOpen;
}

export function setOrbitalLookupOpen(open: boolean): void {
  lookupOpen = open;
}
