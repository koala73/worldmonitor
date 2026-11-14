/** What the satellite pass lookup needs from the dashboard it opens over, without importing it. */
export interface LookupMapHandle {
  getCenter(): { lat: number; lon: number } | null;
  /** Resolves once a camera move already in flight has stopped. */
  whenViewportSettled?(): Promise<unknown>;
}

let mapAccess: () => LookupMapHandle | null = () => null;
let lookupOpen = false;
/** Where the lookup left the map: centred on the looked-up place, which the URL must not carry. */
let leftAt: { lat: number; lon: number } | null = null;
/** After closing: 'settling' while the camera may still be flying to the point, 'unread' until it reports a centre. */
let anchor: 'set' | 'settling' | 'unread' = 'set';
let closeToken = 0;

export function connectOrbitalLookupMap(access: () => LookupMapHandle | null): void {
  mapAccess = access;
  // A new map has no camera left on a looked-up place.
  closeToken += 1;
  leftAt = null;
  anchor = 'set';
}

/** Globe spin and a sideways pan turn only the longitude, so the map still carries the looked-up latitude. */
const sameLatitude = (a: { lat: number }, b: { lat: number }) => Math.abs(a.lat - b.lat) < 1e-6;

function anchorOnCentre(): void {
  leftAt = mapAccess()?.getCenter() ?? null;
  anchor = leftAt ? 'set' : 'unread';
}

/**
 * While the lookup is open, and after it closes until the map leaves that latitude, the map URL sync leaves the map centre out,
 * so a looked-up place stays out of the query string.
 */
export function isOrbitalLookupOpen(): boolean {
  if (lookupOpen || anchor === 'settling') return true;
  if (anchor === 'unread') {
    anchorOnCentre();
    return true;
  }
  if (!leftAt) return false;
  const centre = mapAccess()?.getCenter() ?? null;
  // A camera that cannot say where it is has not shown that it left the looked-up place.
  if (!centre || sameLatitude(centre, leftAt)) return true;
  leftAt = null;
  return false;
}

export function setOrbitalLookupOpen(open: boolean): void {
  if (open) {
    closeToken += 1;
    leftAt = null;
    anchor = 'set';
    lookupOpen = true;
    return;
  }
  if (!lookupOpen) return;
  lookupOpen = false;
  const token = ++closeToken;
  // A camera still flying to the point reports a latitude it is about to leave, so anchor once it stops.
  const settled = mapAccess()?.whenViewportSettled?.();
  if (!settled) {
    anchorOnCentre();
    return;
  }
  anchor = 'settling';
  settled.then(
    () => { if (token === closeToken) anchorOnCentre(); },
    () => { if (token === closeToken) anchor = 'unread'; },
  );
}
