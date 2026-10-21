// @ts-check
// Mobility v1 adapter. Replaces the Phase 0 empty stub with a real
// MobilityState built from existing Redis inputs:
//
//   aviation:delays:faa:v1         — US airport delays (FAA ASWS)
//   aviation:delays:intl:v3        — ~51 non-US airports (AviationStack)
//   aviation:notam:closures:v2     — global ICAO NOTAM closures
//   intelligence:gpsjam:v2         — global GPS jamming hexes → airspace
//   military:flights:v1            — global military ADSB → reroute proxy
//
// Output (per RegionalSnapshot.mobility):
//
//   airspace[]         — one aggregated entry per region from GPS-jam
//   flight_corridors[] — empty in v1 (no direct corridor stress feed)
//   airports[]         — MAJOR/SEVERE airport alerts scoped to region
//   reroute_intensity  — clip(militaryCount/50, 0, 1) region-scoped
//   notam_closures[]   — NOTAM reason strings for airports in region
//
// All functions are PURE and export-tested — no Redis calls, no side effects.
// The seed writer passes already-fetched source objects in.
//
// Scope boundaries (explicit non-goals for v1):
//   - flight_corridors[] stays empty — no direct rerouted-per-corridor feed
//   - reroute_intensity uses military count as a crude proxy; future versions
//     could use GPS-jam hex density or OpenSky track analysis
//   - NOTAM classifier is text-based (closure vs restriction) — no structured parse

// ── Region classification helpers ────────────────────────────────────────────

/**
 * Split AviationStack/FAA AirportRegion enum by country into snapshot regions.
 * The airport registry uses `americas / europe / apac / mena / africa`; the
 * snapshot uses 7 finer regions. Americas splits by country (USA/CA/MX →
 * north-america, rest → latam) and APAC splits by country (IN/PK/BD/LK/AF →
 * south-asia, rest → east-asia). Proto enum strings and lowercase labels
 * are both accepted.
 *
 * @param {{ region?: string, country?: string }} alert
 * @returns {string | null} snapshot region id, or null if unmappable
 */
export function airportToSnapshotRegion(alert) {
  if (!alert) return null;
  const region = String(alert.region ?? '').toUpperCase();
  const country = String(alert.country ?? '');

  if (region.includes('AMERICAS')) {
    if (NORTH_AMERICA_COUNTRIES.has(country)) return 'north-america';
    return 'latam';
  }
  if (region.includes('APAC')) {
    if (SOUTH_ASIA_COUNTRIES.has(country)) return 'south-asia';
    return 'east-asia';
  }
  if (region.includes('EUROPE')) return 'europe';
  if (region.includes('MENA')) return 'mena';
  if (region.includes('AFRICA')) return 'sub-saharan-africa';
  return null;
}

const NORTH_AMERICA_COUNTRIES = new Set([
  'USA', 'United States', 'United States of America',
  'Canada',
  'Mexico',
]);

const SOUTH_ASIA_COUNTRIES = new Set([
  'India', 'Pakistan', 'Bangladesh', 'Sri Lanka', 'Afghanistan', 'Nepal', 'Bhutan', 'Maldives',
]);

/**
 * Map fetch-gpsjam.mjs classifyRegion() labels to snapshot region ids.
 * Falls back to null for 'other' and unknown labels.
 *
 * @param {string | undefined} gpsjamRegion
 * @returns {string | null}
 */
export function gpsjamRegionToSnapshotRegion(gpsjamRegion) {
  switch (gpsjamRegion) {
    case 'iran-iraq':
    case 'levant':
    case 'israel-sinai':
    case 'yemen-horn':
    case 'turkey-caucasus':
      return 'mena';
    case 'ukraine-russia':
    case 'russia-north':
    case 'northern-europe':
    case 'western-europe':
      return 'europe';
    case 'sudan-sahel':
    case 'east-africa':
      return 'sub-saharan-africa';
    case 'afghanistan-pakistan':
      return 'south-asia';
    case 'southeast-asia':
    case 'east-asia':
      return 'east-asia';
    case 'north-america':
      return 'north-america';
    default:
      return null;
  }
}

/**
 * Lat/lon → snapshot region bbox classifier for military flights. Coarse
 * coverage matching the fetch-gpsjam.mjs region bboxes. Returns null for
 * oceans and unmapped airspace.
 *
 * North America's southern edge is set at lat 16.0°N — that captures
 * every major Mexican city and state capital (southernmost is Tuxtla
 * Gutiérrez at 16.75°N) while still routing Guatemala City (14.6°N),
 * Belize City (17.5°N is on the line but Belize is routed via its
 * country name in the airport mapper), and El Salvador to latam.
 * Before this fix, NA started at lat 20 which left Mexico City (19.4°N)
 * and most of Mexican airspace in latam, disagreeing with
 * airportToSnapshotRegion()'s country-based MX→NA routing and
 * understating NA's reroute_intensity from military tracks.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {string | null}
 */
export function latLonToSnapshotRegion(lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  // MENA (check before Europe so Turkey/Caucasus land MENA per our override)
  if (lat >= 12 && lat <= 42 && lon >= 20 && lon <= 63) return 'mena';
  // Europe + Russia
  if (lat >= 35 && lat <= 72 && lon >= -10 && lon <= 60) return 'europe';
  // Sub-Saharan Africa
  if (lat >= -35 && lat <= 20 && lon >= -18 && lon <= 52) return 'sub-saharan-africa';
  // South Asia
  if (lat >= 5 && lat <= 38 && lon >= 60 && lon <= 97) return 'south-asia';
  // East Asia / Southeast Asia / Oceania
  if (lat >= -45 && lat <= 55 && lon >= 90 && lon <= 180) return 'east-asia';
  // North America — includes all major Mexican cities/states. Checked
  // before latam so the bbox overlap resolves to NA.
  if (lat >= 16 && lat <= 75 && lon >= -170 && lon <= -50) return 'north-america';
  // Latin America — capped at 16°N so Guatemala/Belize/El Salvador and
  // southward fall here, while mainland Mexico goes to NA above.
  if (lat >= -56 && lat < 16 && lon >= -120 && lon <= -34) return 'latam';
  return null;
}

// ── Airports block ───────────────────────────────────────────────────────────

/** Severity tier at which an airport alert is considered mobility-relevant. */
const AIRPORT_MIN_SEVERITY_RANK = 3; // 0=normal 1=minor 2=moderate 3=major 4=severe

const SEVERITY_RANK = {
  FLIGHT_DELAY_SEVERITY_NORMAL: 0,
  FLIGHT_DELAY_SEVERITY_MINOR: 1,
  FLIGHT_DELAY_SEVERITY_MODERATE: 2,
  FLIGHT_DELAY_SEVERITY_MAJOR: 3,
  FLIGHT_DELAY_SEVERITY_SEVERE: 4,
  // Also accept the lowercase seeder-internal labels just in case
  normal: 0, minor: 1, moderate: 2, major: 3, severe: 4,
};

/**
 * @param {string | undefined} severity
 * @returns {number}
 */
function severityRank(severity) {
  return /** @type {any} */ (SEVERITY_RANK)[String(severity ?? '')] ?? 0;
}

/**
 * Build airports[] for one region: filter alerts from both FAA and intl
 * seeds down to severity >= MAJOR and map each to the snapshot's
 * AirportNodeStatus shape.
 *
 * @param {string} regionId
 * @param {Record<string, any>} sources
 * @returns {import('../../shared/regions.types.js').AirportNodeStatus[]}
 */
export function buildAirports(regionId, sources) {
  const faaAlerts = sources?.['aviation:delays:faa:v1']?.alerts;
  const intlAlerts = sources?.['aviation:delays:intl:v3']?.alerts;
  const allAlerts = [
    ...(Array.isArray(faaAlerts) ? faaAlerts : []),
    ...(Array.isArray(intlAlerts) ? intlAlerts : []),
  ];

  /** @type {import('../../shared/regions.types.js').AirportNodeStatus[]} */
  const out = [];
  for (const a of allAlerts) {
    if (airportToSnapshotRegion(a) !== regionId) continue;
    const rank = severityRank(a?.severity);
    if (rank < AIRPORT_MIN_SEVERITY_RANK) continue;
    /** @type {'closed' | 'disrupted'} */
    const status = rank >= 4 ? 'closed' : 'disrupted';
    out.push({
      icao: String(a?.icao ?? ''),
      name: String(a?.name ?? a?.iata ?? ''),
      status,
      disruption_reason: String(a?.reason ?? ''),
    });
  }
  return out;
}

// ── NOTAM closures block ─────────────────────────────────────────────────────

/**
 * Emit NOTAM reason strings for any airport that the `airports[]` block
 * would surface in this region. v1: derives the ICAO set from the airport
 * alerts (so NOTAMs track the same airport scope) and pulls reason text
 * from aviation:notam:closures:v2.reasons[icao].
 *
 * @param {string} regionId
 * @param {Record<string, any>} sources
 * @returns {string[]}
 */
export function buildNotamClosures(regionId, sources) {
  const notam = sources?.['aviation:notam:closures:v2'];
  const reasons = notam?.reasons && typeof notam.reasons === 'object' ? notam.reasons : {};
  const closedIcaos = Array.isArray(notam?.closedIcaos) ? notam.closedIcaos : [];
  const restrictedIcaos = Array.isArray(notam?.restrictedIcaos) ? notam.restrictedIcaos : [];
  const candidates = new Set([...closedIcaos, ...restrictedIcaos]);

  if (candidates.size === 0) return [];

  // Determine which ICAOs belong to this region by cross-referencing the
  // existing airport alert stream (both FAA + intl carry country/region).
  const faaAlerts = sources?.['aviation:delays:faa:v1']?.alerts;
  const intlAlerts = sources?.['aviation:delays:intl:v3']?.alerts;
  /** @type {Record<string, string>} */
  const icaoToRegion = {};
  for (const a of Array.isArray(faaAlerts) ? faaAlerts : []) {
    const r = airportToSnapshotRegion(a);
    if (a?.icao && r) icaoToRegion[String(a.icao)] = r;
  }
  for (const a of Array.isArray(intlAlerts) ? intlAlerts : []) {
    const r = airportToSnapshotRegion(a);
    if (a?.icao && r) icaoToRegion[String(a.icao)] = r;
  }

  const out = [];
  for (const icao of candidates) {
    if (icaoToRegion[icao] !== regionId) continue;
    const reason = String(reasons[icao] ?? '').slice(0, 200);
    if (reason.length === 0) continue;
    out.push(`${icao}: ${reason}`);
  }
  return out;
}

// ── Airspace block (from GPS jamming) ────────────────────────────────────────

const JAM_LEVEL_RANK = { low: 1, medium: 2, high: 3 };

/**
 * Build airspace[] for one region. v1 aggregates GPS-jam hexes mapped to
 * this region into ONE AirspaceStatus entry — emitting one per hex would
 * flood the UI.
 *
 * Status resolution:
 *   - any 'high' level hex present → 'restricted'
 *   - only 'medium'/'low' hexes     → 'restricted' (GPS jam still affects RNAV)
 *   - no hexes in region            → block omits the region
 *
 * @param {string} regionId
 * @param {Record<string, any>} sources
 * @returns {import('../../shared/regions.types.js').AirspaceStatus[]}
 */
export function buildAirspace(regionId, sources) {
  const hexes = sources?.['intelligence:gpsjam:v2']?.hexes;
  if (!Array.isArray(hexes) || hexes.length === 0) return [];

  let highCount = 0;
  let mediumCount = 0;
  let lowCount = 0;
  /** @type {Set<string>} */
  const subRegions = new Set();

  for (const hex of hexes) {
    const jamSnapshotRegion = gpsjamRegionToSnapshotRegion(hex?.region);
    if (jamSnapshotRegion !== regionId) continue;
    const level = String(hex?.level ?? 'low').toLowerCase();
    if (level === 'high') highCount += 1;
    else if (level === 'medium') mediumCount += 1;
    else lowCount += 1;
    if (hex?.region) subRegions.add(String(hex.region));
  }

  const total = highCount + mediumCount + lowCount;
  if (total === 0) return [];

  const subRegionList = [...subRegions].sort().join(', ');
  const summary = `GPS jamming active over ${subRegionList || regionId}: ${highCount} high / ${mediumCount} medium / ${lowCount} low hexes`;

  /** @type {import('../../shared/regions.types.js').AirspaceStatus[]} */
  const out = [{
    airspace_id: `gpsjam:${regionId}`,
    status: 'restricted',
    reason: summary,
  }];
  return out;
}

// ── Reroute intensity ────────────────────────────────────────────────────────

const REROUTE_FLIGHTS_FULL_SCALE = 50; // military flight count at which reroute_intensity saturates to 1.0

/**
 * Crude reroute_intensity proxy: count military flights whose lat/lon lands
 * in this region and clip against a full-scale constant. A sustained
 * military presence correlates with civil rerouting pressure, even if it's
 * not a direct 1:1 measure.
 *
 * v2 could replace this with:
 *   - direct OpenSky ADSB civil-flight track diversion counts per corridor
 *   - GPS-jam hex density as a rerouting proxy (more rigorous)
 *   - operational NOTAM parse of ATS route closures
 *
 * @param {string} regionId
 * @param {Record<string, any>} sources
 * @returns {number} value in [0, 1]
 */
export function buildRerouteIntensity(regionId, sources) {
  const flights = sources?.['military:flights:v1']?.flights;
  if (!Array.isArray(flights) || flights.length === 0) return 0;

  let count = 0;
  for (const f of flights) {
    const r = latLonToSnapshotRegion(Number(f?.lat), Number(f?.lon));
    if (r === regionId) count += 1;
  }

  return Math.max(0, Math.min(1, count / REROUTE_FLIGHTS_FULL_SCALE));
}

// ── Top-level composer ──────────────────────────────────────────────────────

/**
 * Build the full MobilityState for one region from already-fetched sources.
 * Pure, never throws, always returns a shape that matches the proto.
 *
 * @param {string} regionId
 * @param {Record<string, any>} sources
 * @returns {import('../../shared/regions.types.js').MobilityState}
 */
export function buildMobilityState(regionId, sources) {
  try {
    return {
      airspace: buildAirspace(regionId, sources),
      flight_corridors: [],
      airports: buildAirports(regionId, sources),
      reroute_intensity: buildRerouteIntensity(regionId, sources),
      notam_closures: buildNotamClosures(regionId, sources),
    };
  } catch (err) {
    // Defensive: any unexpected shape bug must not break snapshot persist.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[mobility] ${regionId}: builder threw, returning empty: ${msg}`);
    return {
      airspace: [],
      flight_corridors: [],
      airports: [],
      reroute_intensity: 0,
      notam_closures: [],
    };
  }
}
