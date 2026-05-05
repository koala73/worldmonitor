/**
 * Static lookup of US sports-city → approximate centroid coordinates.
 *
 * ESPN's scoreboard responses give us venue name + city + state, but no lat/lng.
 * Rather than calling a separate ESPN venues endpoint per game (extra latency,
 * extra rate-limit pressure) we map the city/state pair to a rough lat/lng so
 * the iOS map can pin the event.
 *
 * Coordinates are city centroids — fine for v1 since the map shows a single
 * pin per event, not a stadium-precise location. We can swap in real venue
 * coordinates later if precision becomes a UX concern.
 *
 * Match key: lowercase "{city}|{state}" — both normalized (trim, no
 * trailing periods). State is the 2-letter US postal code where ESPN
 * provides one; some international cities (e.g. Toronto) use country.
 */

export interface CityCoord {
  lat: number;
  lng: number;
}

/** key = `${city.toLowerCase()}|${state.toLowerCase()}` */
const CITY_COORDS: Record<string, CityCoord> = {
  // ── NFL / NBA / MLB / NHL primary metros ──────────────────────────────
  'atlanta|ga':           { lat: 33.7490, lng: -84.3880 },
  'baltimore|md':         { lat: 39.2904, lng: -76.6122 },
  'boston|ma':            { lat: 42.3601, lng: -71.0589 },
  'buffalo|ny':           { lat: 42.8864, lng: -78.8784 },
  'charlotte|nc':         { lat: 35.2271, lng: -80.8431 },
  'chicago|il':           { lat: 41.8781, lng: -87.6298 },
  'cincinnati|oh':        { lat: 39.1031, lng: -84.5120 },
  'cleveland|oh':         { lat: 41.4993, lng: -81.6944 },
  'columbus|oh':          { lat: 39.9612, lng: -82.9988 },
  'dallas|tx':            { lat: 32.7767, lng: -96.7970 },
  'denver|co':            { lat: 39.7392, lng: -104.9903 },
  'detroit|mi':           { lat: 42.3314, lng: -83.0458 },
  'east rutherford|nj':   { lat: 40.8136, lng: -74.0744 }, // MetLife (Giants/Jets)
  'foxborough|ma':        { lat: 42.0909, lng: -71.2643 }, // Gillette (Patriots)
  'glendale|az':          { lat: 33.5387, lng: -112.1860 },
  'green bay|wi':         { lat: 44.5133, lng: -88.0133 },
  'houston|tx':           { lat: 29.7604, lng: -95.3698 },
  'indianapolis|in':      { lat: 39.7684, lng: -86.1581 },
  'inglewood|ca':         { lat: 33.9617, lng: -118.3531 }, // SoFi (Rams/Chargers)
  'jacksonville|fl':      { lat: 30.3322, lng: -81.6557 },
  'kansas city|mo':       { lat: 39.0997, lng: -94.5786 },
  'landover|md':          { lat: 38.9072, lng: -76.8643 }, // Commanders
  'las vegas|nv':         { lat: 36.1699, lng: -115.1398 },
  'los angeles|ca':       { lat: 34.0522, lng: -118.2437 },
  'memphis|tn':           { lat: 35.1495, lng: -90.0490 },
  'miami|fl':             { lat: 25.7617, lng: -80.1918 },
  'miami gardens|fl':     { lat: 25.9420, lng: -80.2456 }, // Hard Rock (Dolphins)
  'milwaukee|wi':         { lat: 43.0389, lng: -87.9065 },
  'minneapolis|mn':       { lat: 44.9778, lng: -93.2650 },
  'nashville|tn':         { lat: 36.1627, lng: -86.7816 },
  'new orleans|la':       { lat: 29.9511, lng: -90.0715 },
  'new york|ny':          { lat: 40.7128, lng: -74.0060 },
  'oakland|ca':           { lat: 37.8044, lng: -122.2712 },
  'oklahoma city|ok':     { lat: 35.4676, lng: -97.5164 },
  'orlando|fl':           { lat: 28.5383, lng: -81.3792 },
  'philadelphia|pa':      { lat: 39.9526, lng: -75.1652 },
  'phoenix|az':           { lat: 33.4484, lng: -112.0740 },
  'pittsburgh|pa':        { lat: 40.4406, lng: -79.9959 },
  'portland|or':          { lat: 45.5152, lng: -122.6784 },
  'sacramento|ca':        { lat: 38.5816, lng: -121.4944 },
  'salt lake city|ut':    { lat: 40.7608, lng: -111.8910 },
  'san antonio|tx':       { lat: 29.4241, lng: -98.4936 },
  'san diego|ca':         { lat: 32.7157, lng: -117.1611 },
  'san francisco|ca':     { lat: 37.7749, lng: -122.4194 },
  'santa clara|ca':       { lat: 37.3541, lng: -121.9552 }, // Levi's (49ers)
  'seattle|wa':           { lat: 47.6062, lng: -122.3321 },
  'st. louis|mo':         { lat: 38.6270, lng: -90.1994 },
  'st. petersburg|fl':    { lat: 27.7676, lng: -82.6403 }, // Rays
  'tampa|fl':             { lat: 27.9506, lng: -82.4572 },
  'washington|dc':        { lat: 38.9072, lng: -77.0369 },

  // ── MLS additions (cities not already listed) ─────────────────────────
  'austin|tx':            { lat: 30.2672, lng: -97.7431 },
  'cary|nc':              { lat: 35.7915, lng: -78.7811 }, // NC FC
  'commerce city|co':     { lat: 39.8083, lng: -104.9339 }, // Rapids
  // ('cincinnati|oh' already in main NFL/MLB block above — duplicate removed)
  'frisco|tx':            { lat: 33.1507, lng: -96.8236 }, // FC Dallas
  'harrison|nj':          { lat: 40.7456, lng: -74.1564 }, // Red Bulls
  'st. paul|mn':          { lat: 44.9537, lng: -93.0900 }, // Minnesota Utd

  // ── International cities (some leagues span Canada/Mexico) ────────────
  'toronto|ontario':      { lat: 43.6532, lng: -79.3832 },
  'toronto|on':           { lat: 43.6532, lng: -79.3832 },
  'montreal|quebec':      { lat: 45.5017, lng: -73.5673 },
  'montreal|qc':          { lat: 45.5017, lng: -73.5673 },
  'vancouver|british columbia': { lat: 49.2827, lng: -123.1207 },
  'vancouver|bc':         { lat: 49.2827, lng: -123.1207 },
  'edmonton|alberta':     { lat: 53.5461, lng: -113.4938 },
  'edmonton|ab':          { lat: 53.5461, lng: -113.4938 },
  'calgary|alberta':      { lat: 51.0447, lng: -114.0719 },
  'calgary|ab':           { lat: 51.0447, lng: -114.0719 },
  'ottawa|ontario':       { lat: 45.4215, lng: -75.6972 },
  'ottawa|on':            { lat: 45.4215, lng: -75.6972 },
  'winnipeg|manitoba':    { lat: 49.8951, lng: -97.1384 },
  'winnipeg|mb':          { lat: 49.8951, lng: -97.1384 },
};

/** State-only fallback (US postal codes) for events with city we don't recognize. */
const STATE_CENTROIDS: Record<string, CityCoord> = {
  al: { lat: 32.806671, lng: -86.79113 },
  ak: { lat: 61.370716, lng: -152.404419 },
  az: { lat: 33.729759, lng: -111.431221 },
  ar: { lat: 34.969704, lng: -92.373123 },
  ca: { lat: 36.116203, lng: -119.681564 },
  co: { lat: 39.059811, lng: -105.311104 },
  ct: { lat: 41.597782, lng: -72.755371 },
  de: { lat: 39.318523, lng: -75.507141 },
  fl: { lat: 27.766279, lng: -81.686783 },
  ga: { lat: 33.040619, lng: -83.643074 },
  hi: { lat: 21.094318, lng: -157.498337 },
  id: { lat: 44.240459, lng: -114.478828 },
  il: { lat: 40.349457, lng: -88.986137 },
  in: { lat: 39.849426, lng: -86.258278 },
  ia: { lat: 42.011539, lng: -93.210526 },
  ks: { lat: 38.5266, lng: -96.726486 },
  ky: { lat: 37.66814, lng: -84.670067 },
  la: { lat: 31.169546, lng: -91.867805 },
  me: { lat: 44.693947, lng: -69.381927 },
  md: { lat: 39.063946, lng: -76.802101 },
  ma: { lat: 42.230171, lng: -71.530106 },
  mi: { lat: 43.326618, lng: -84.536095 },
  mn: { lat: 45.694454, lng: -93.900192 },
  ms: { lat: 32.741646, lng: -89.678696 },
  mo: { lat: 38.456085, lng: -92.288368 },
  mt: { lat: 46.921925, lng: -110.454353 },
  ne: { lat: 41.12537, lng: -98.268082 },
  nv: { lat: 38.313515, lng: -117.055374 },
  nh: { lat: 43.452492, lng: -71.563896 },
  nj: { lat: 40.298904, lng: -74.521011 },
  nm: { lat: 34.840515, lng: -106.248482 },
  ny: { lat: 42.165726, lng: -74.948051 },
  nc: { lat: 35.630066, lng: -79.806419 },
  nd: { lat: 47.528912, lng: -99.784012 },
  oh: { lat: 40.388783, lng: -82.764915 },
  ok: { lat: 35.565342, lng: -96.928917 },
  or: { lat: 44.572021, lng: -122.070938 },
  pa: { lat: 40.590752, lng: -77.209755 },
  ri: { lat: 41.680893, lng: -71.51178 },
  sc: { lat: 33.856892, lng: -80.945007 },
  sd: { lat: 44.299782, lng: -99.438828 },
  tn: { lat: 35.747845, lng: -86.692345 },
  tx: { lat: 31.054487, lng: -97.563461 },
  ut: { lat: 40.150032, lng: -111.862434 },
  vt: { lat: 44.045876, lng: -72.710686 },
  va: { lat: 37.769337, lng: -78.169968 },
  wa: { lat: 47.400902, lng: -121.490494 },
  wv: { lat: 38.491226, lng: -80.954453 },
  wi: { lat: 44.268543, lng: -89.616508 },
  wy: { lat: 42.755966, lng: -107.30249 },
  dc: { lat: 38.897438, lng: -77.026817 },
};

function normalizeKey(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Resolve a venue's geographic coordinates from a city + state pair.
 * Returns null when no match is found — caller should still include
 * the event in the feed but exclude it from the map.
 */
export function lookupVenueCoords(city: string | null | undefined, state: string | null | undefined): CityCoord | null {
  const c = normalizeKey(city);
  const s = normalizeKey(state);
  if (c && s) {
    const exact = CITY_COORDS[`${c}|${s}`];
    if (exact) return exact;
  }
  if (s && STATE_CENTROIDS[s]) {
    return STATE_CENTROIDS[s];
  }
  return null;
}
