// Pure helpers for the FAA NOTAM Management Service (NMS-API) seeder
// (scripts/seed-notam-nms.mjs): classify GeoJSON NOTAMs, compact them into the
// seeder's Redis state, apply delta pulls, and project the state into the two
// published keys (airport closures + the airspace map layer).
//
// No I/O here, so tests drive it with fixtures cut from real staging payloads.
// Lives under scripts/ because Railway seed crons build from a scripts-rooted
// source (see scripts/lib/airport-notify-location.mjs).

// Q-code subjects (letters 2-3 of the selection code) for airspace a pilot can
// be kept out of. ATS routes (QAR*) are deliberately absent: route closures are
// navigation detail, not a place on the map.
const AIRSPACE_KIND_BY_SUBJECT = {
  RP: 'prohibited',
  RR: 'restricted',
  RT: 'restricted',
  RD: 'danger',
  RM: 'military',
  RA: 'reserved',
  RO: 'overflight',
};
// FIR, UIR, control area, TMA, control zone, upper control area, ATZ.
const CLOSABLE_AIRSPACE_SUBJECTS = new Set(['AF', 'AU', 'AE', 'AT', 'AC', 'AH', 'AZ']);
const TFR_TEXT = /\bTEMPORARY FLIGHT RESTRICTIONS?\b/;

// Aerodrome closure: Q-code FALC ("aerodrome closed") or a NOTAM whose E) line
// leads with the closure. The ICAO classifier in seed-aviation.mjs also takes
// FA+XX/AS/AU and "AD NOT AVBL"; on the full NMS set those flag routine
// notices ("AD NOT AVBL AS ALTN AD", "AD HOC SLOTS NOT PERMITTED") as closures
// at a third of the monitored airports, so NMS uses this stricter rule.
const CLOSURE_TEXT = /^(?:AD|AERODROME|AIRPORT)(?: AP)? (?:CLSD|CLOSED)\b/;
// A closure that still admits traffic ("CLSD TO NON SKED TRANSIENT GA ACFT EXC
// 24HR PPR") is a restriction, not a closed airport.
const PARTIAL_CLOSURE_TEXT = /\b(?:CLSD|CLOSED) TO\b|\bEXC(?:EPT)?\b|\bPPR\b/;
const EXCEPTION_TEXT = /\bEXC(?:EPT)?\b|\bPPR\b/;
// "CLSD TO ALL TFC" with no exception closes the aerodrome outright.
const CLOSED_TO_ALL_TEXT = /\b(?:CLSD|CLOSED) TO ALL (?:TFC|TRAFFIC|ACFT|FLIGHTS|FLTS?)\b/;
// A closure to one narrow traffic class leaves airline service running, e.g.
// KLAX's standing "CLSD TO NON SKED TRANSIENT GA ACFT EXC 24HR PPR". Counting
// these flagged major US hubs as disrupted. Only the classes listed here drop;
// any other "CLSD TO <class>" (civil, commercial, IFR, size limits) still
// counts as a restriction.
const NARROW_CLOSURE_TEXT = /\b(?:CLSD|CLOSED) (?:TO|FOR) (?:NON[- ]?SKED|TRANSIENT|VISITING|GA|ULTRALIGHT|STUDENT|TRG|TRAINING|CIV(?:IL)? TRG|PRKG|PARKING|MIL(?:ITARY)? ACFT|[A-Z]{1,3}-\d{1,3}[A-Z]?|COMMERCIAL AIR CARRIER DIVERTS)\b/;
const AIRPORT_RESTRICTION_SUBJECTS = new Set(['RA', 'RO', 'RT', 'RR', 'RP']);

// Written by seed-notam-nms.mjs, read by seed-aviation.mjs's NOTAM side-car.
export const NMS_CLOSURES_KEY = 'aviation:notam:nms:closures:v1';
// Set (no TTL) by the first production NMS publish. From then on NMS is the
// primary closure source, and seed-aviation will not publish without it.
export const NMS_ACTIVATION_KEY = 'seed-activated:aviation:notam-nms:v1';
// seed-notam-nms.mjs's 20-minute health budget (MAX_STALE_MIN) plus 10 minutes
// of grace for a slow run. Older NMS closures are not a current observation
// and must not be republished as one.
export const NMS_CLOSURES_MAX_AGE_MS = 30 * 60_000;

export const AIRSPACE_KINDS = Object.freeze(['closure', 'tfr', 'prohibited', 'restricted', 'danger', 'military', 'reserved', 'overflight']);

const TEXT_MAX = 280;
const MAX_DRAWN_RADIUS_NM = 250;
const UPCOMING_HORIZON_MS = 24 * 3600_000;

function upper(value) {
  return typeof value === 'string' ? value.toUpperCase() : '';
}

function normalizeText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** Parse an NMS time ("2026-10-24T14:00:00Z", "...000Z"); PERM and blanks are open-ended (null). */
export function parseNmsTime(value) {
  if (typeof value !== 'string' || value === '' || value.toUpperCase() === 'PERM') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Parse the Q-line style "3939N04302E" / "512615N0003215W" into [lon, lat]. */
export function parseQCoordinates(value) {
  const m = typeof value === 'string' && value.trim().match(/^(\d{2})(\d{2})(\d{2})?([NS])(\d{3})(\d{2})(\d{2})?([EW])$/);
  if (!m) return null;
  const lat = (Number(m[1]) + Number(m[2]) / 60 + Number(m[3] || 0) / 3600) * (m[4] === 'S' ? -1 : 1);
  const lon = (Number(m[5]) + Number(m[6]) / 60 + Number(m[7] || 0) / 3600) * (m[8] === 'W' ? -1 : 1);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [round(lon), round(lat)];
}

function round(n) {
  return Math.round(n * 1e4) / 1e4;
}

function validPosition(c) {
  return Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number'
    && Number.isFinite(c[0]) && Number.isFinite(c[1]) && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90;
}

/**
 * Reduce an NMS GeometryCollection to what the map draws: polygons when NMS
 * ships them, otherwise a centre point (geometry Point, else the Q-line
 * coordinates). Returns null when the NOTAM carries no position at all.
 */
export function compactGeometry(geometry, notam) {
  // Malformed members read as empty, so one bad feature cannot abort the sync.
  const parts = geometry?.type === 'GeometryCollection'
    ? (Array.isArray(geometry.geometries) ? geometry.geometries : [])
    : geometry ? [geometry] : [];
  const polygons = [];
  let point = null;
  for (const g of parts) {
    if (g?.type === 'Polygon') polygons.push(g.coordinates);
    else if (g?.type === 'MultiPolygon' && Array.isArray(g.coordinates)) polygons.push(...g.coordinates);
    else if (g?.type === 'Point' && !point && validPosition(g.coordinates)) point = [round(g.coordinates[0]), round(g.coordinates[1])];
  }
  const rings = polygons
    .map((poly) => (Array.isArray(poly?.[0]) ? poly[0] : null))
    .filter((ring) => Array.isArray(ring) && ring.length >= 4 && ring.every(validPosition))
    .map((ring) => ring.map(([lon, lat]) => [round(lon), round(lat)]));
  const qPoint = parseQCoordinates(notam?.coordinates);
  // Q-line radius 999 means "whole FIR", and a few NOTAMs carry 600+ NM: drawn
  // literally, one notice paints half a continent. Past the cap the map shows
  // a marker instead of a circle.
  const radiusNm = Number.parseFloat(notam?.radius);
  const drawnRadius = Number.isFinite(radiusNm) && radiusNm > 0 && radiusNm <= MAX_DRAWN_RADIUS_NM ? radiusNm : null;
  // The Q-line radius is measured from the Q-line point. The geometry Point is
  // often the aerodrome reference point instead, miles from the area, so a
  // drawn circle takes the Q-line centre; a marker keeps the finer Point.
  if (drawnRadius !== null && qPoint && !rings.length) point = qPoint;
  if (!point) point = qPoint;
  if (!point && rings.length) point = rings[0][0];
  if (!point) return null;
  return {
    c: point,
    ...(drawnRadius !== null ? { r: drawnRadius } : {}),
    ...(rings.length ? { p: rings } : {}),
  };
}

/**
 * Classify one NMS NOTAM. Returns null when it matters to neither output.
 * @returns {{ airport?: 'closed' | 'restricted', airspace?: string } | null}
 */
export function classifyNotam(notam) {
  if (!notam || typeof notam !== 'object') return null;
  // A NOTAMC only announces a cancellation; the cancelled NOTAM itself comes
  // back with cancelationDate set, which is what removes it from state.
  if (notam.type === 'C') return null;
  const q = upper(notam.selectionCode);
  const subject = q.slice(1, 3);
  const condition = q.slice(3, 5);
  const text = normalizeText(upper(notam.text));
  const out = {};

  if (NARROW_CLOSURE_TEXT.test(text)) {
    // Not an airport disruption; the airspace checks below still apply.
  } else if (subject === 'FA' && condition === 'LC' || CLOSURE_TEXT.test(text)) {
    const closedToAll = CLOSED_TO_ALL_TEXT.test(text) && !EXCEPTION_TEXT.test(text);
    out.airport = closedToAll || !PARTIAL_CLOSURE_TEXT.test(text) ? 'closed' : 'restricted';
  } else if (AIRPORT_RESTRICTION_SUBJECTS.has(subject) && (condition === 'RE' || condition === 'RT')) {
    out.airport = 'restricted';
  }

  if (TFR_TEXT.test(text)) out.airspace = 'tfr';
  else if (AIRSPACE_KIND_BY_SUBJECT[subject]) out.airspace = AIRSPACE_KIND_BY_SUBJECT[subject];
  else if (CLOSABLE_AIRSPACE_SUBJECTS.has(subject) && condition === 'LC') out.airspace = 'closure';

  return out.airport || out.airspace ? out : null;
}

/**
 * Compact one GeoJSON feature into a state record, or null when irrelevant,
 * malformed, or already cancelled/expired at `nowMs`.
 */
export function compactFeature(feature, nowMs) {
  const notam = feature?.properties?.coreNOTAMData?.notam;
  if (!notam || typeof notam.id !== 'string' || notam.id === '') return null;
  const cls = classifyNotam(notam);
  if (!cls) return null;
  const end = parseNmsTime(notam.effectiveEnd);
  const cancelledAt = parseNmsTime(notam.cancelationDate);
  if (end !== null && end <= nowMs) return null;
  if (cancelledAt !== null && cancelledAt <= nowMs) return null;
  const geo = cls.airspace ? compactGeometry(feature.geometry, notam) : null;
  // An airspace NOTAM with no position can still be an airport closure; drop
  // only the airspace half. An airspace closure is kept without geometry:
  // buildAirspace cannot draw it, but coveredLocations needs it to close the
  // airports in its FIR.
  if (cls.airspace && !geo && cls.airspace !== 'closure') delete cls.airspace;
  if (!cls.airport && !cls.airspace) return null;
  const location = upper(notam.icaoLocation || notam.location);
  return {
    id: notam.id,
    ...(cls.airport ? { a: cls.airport } : {}),
    ...(cls.airspace ? { k: cls.airspace, ...(geo ? { g: geo } : {}) } : {}),
    loc: location,
    ...(notam.affectedFir ? { fir: upper(notam.affectedFir) } : {}),
    num: typeof notam.number === 'string' ? notam.number : '',
    q: upper(notam.selectionCode),
    s: parseNmsTime(notam.effectiveStart),
    e: end,
    ...(notam.schedule ? { sch: String(notam.schedule).slice(0, 80) } : {}),
    ...(notam.lowerLimit || notam.minimumFl ? { lo: String(notam.lowerLimit || `FL${notam.minimumFl}`) } : {}),
    ...(notam.upperLimit || notam.maximumFl ? { hi: String(notam.upperLimit || `FL${notam.maximumFl}`) } : {}),
    txt: normalizeText(notam.text).slice(0, TEXT_MAX),
  };
}

/** True when the record's effective window covers `nowMs`. */
export function isActive(rec, nowMs) {
  return (rec.s === null || rec.s <= nowMs) && (rec.e === null || rec.e > nowMs);
}

/**
 * Apply a batch of NMS features (a full classification file or a delta) to
 * `items` (id → record) in place. Every feature in a delta is the NOTAM's
 * latest version, so a feature that no longer compacts (cancelled, expired,
 * reclassified) deletes its id.
 * @returns {{ upserted: number, removed: number }}
 */
export function applyFeatures(items, features, nowMs) {
  let upserted = 0;
  let removed = 0;
  for (const feature of Array.isArray(features) ? features : []) {
    const id = feature?.properties?.coreNOTAMData?.notam?.id;
    if (typeof id !== 'string' || id === '') continue;
    const rec = compactFeature(feature, nowMs);
    if (rec) {
      items[id] = rec;
      upserted++;
    } else if (id in items) {
      delete items[id];
      removed++;
    }
  }
  return { upserted, removed };
}

const ICAO_LOCATION = /^[A-Z]{4}$/;

/**
 * Record in `locs` (location → FIR) the ICAO location of every NOTAM in
 * `features`, relevant or not. An aerodrome the feed carries NOTAMs for is one
 * where the absence of a closure NOTAM means open; one it carries nothing for
 * stays unknown.
 */
export function noteLocations(locs, features) {
  for (const feature of Array.isArray(features) ? features : []) {
    const notam = feature?.properties?.coreNOTAMData?.notam;
    const location = upper(notam?.icaoLocation || notam?.location);
    if (ICAO_LOCATION.test(location)) locs[location] = upper(notam.affectedFir) || locs[location] || '';
  }
}

/**
 * Locations in `locs` where no closure NOTAM means open. A country-wide
 * airspace closure is filed with the FIR as its location, not on each airport,
 * so an airport whose FIR (or itself) has an airspace closure in effect is left
 * out. A closure filed at another location inside the FIR, such as one control
 * zone, does not close the FIR.
 */
export function coveredLocations(locs, items, nowMs) {
  const closedAirspace = new Set();
  for (const rec of Object.values(items)) {
    if (rec.k === 'closure' && rec.loc && isActive(rec, nowMs)) closedAirspace.add(rec.loc);
  }
  return Object.entries(locs && typeof locs === 'object' ? locs : {})
    .filter(([loc, fir]) => !closedAirspace.has(loc) && !closedAirspace.has(fir))
    .map(([loc]) => loc)
    .sort();
}

/** Drop records whose effective window has closed. Returns the number removed. */
export function pruneExpired(items, nowMs) {
  let removed = 0;
  for (const [id, rec] of Object.entries(items)) {
    if (rec.e !== null && rec.e <= nowMs) {
      delete items[id];
      removed++;
    }
  }
  return removed;
}

/**
 * Airport closures in the shape seed-aviation.mjs merges into
 * aviation:notam:closures:v2. Covers every aerodrome NMS reports; the consumer
 * filters to the airports it monitors. Closed wins over restricted.
 */
export function buildClosures(items, nowMs) {
  const closed = new Map();
  const restricted = new Map();
  for (const rec of Object.values(items)) {
    if (!rec.a || !rec.loc || !isActive(rec, nowMs)) continue;
    // State carries records classified before NARROW_CLOSURE_TEXT existed, and
    // delta runs never reclassify them. The phrase sits near the start of an
    // aerodrome NOTAM, well inside the 280 characters the record keeps.
    if (NARROW_CLOSURE_TEXT.test(upper(rec.txt))) continue;
    const target = rec.a === 'closed' ? closed : restricted;
    if (!target.has(rec.loc)) target.set(rec.loc, rec.txt || (rec.a === 'closed' ? 'Airport closure (NOTAM)' : 'Airspace restriction (NOTAM)'));
  }
  for (const icao of closed.keys()) restricted.delete(icao);
  const reasons = Object.fromEntries([...closed, ...restricted]);
  return { closedIcaos: [...closed.keys()].sort(), restrictedIcaos: [...restricted.keys()].sort(), reasons };
}

/**
 * Airspace layer rows: active now, or starting within the next 24h
 * (`upcoming: true`). Sorted by start so the payload is stable between runs.
 */
export function buildAirspace(items, nowMs) {
  const rows = [];
  for (const rec of Object.values(items)) {
    if (!rec.k || !rec.g) continue;
    const active = isActive(rec, nowMs);
    const upcoming = !active && rec.s !== null && rec.s > nowMs && rec.s - nowMs <= UPCOMING_HORIZON_MS;
    if (!active && !upcoming) continue;
    rows.push({
      id: rec.id,
      kind: rec.k,
      location: rec.loc,
      ...(rec.fir ? { fir: rec.fir } : {}),
      number: rec.num,
      qcode: rec.q,
      startsAt: rec.s,
      endsAt: rec.e,
      ...(upcoming ? { upcoming: true } : {}),
      ...(rec.sch ? { schedule: rec.sch } : {}),
      ...(rec.lo ? { lower: rec.lo } : {}),
      ...(rec.hi ? { upper: rec.hi } : {}),
      center: rec.g.c,
      ...(rec.g.r ? { radiusNm: rec.g.r } : {}),
      ...(rec.g.p ? { polygons: rec.g.p } : {}),
      text: rec.txt,
    });
  }
  rows.sort((a, b) => (a.startsAt ?? 0) - (b.startsAt ?? 0) || a.id.localeCompare(b.id));
  return rows;
}

/** True when `payload` is an NMS closures snapshot generated within the freshness budget. */
export function isFreshNmsClosures(payload, nowMs) {
  return !!payload && typeof payload === 'object'
    && Array.isArray(payload.closedIcaos) && Array.isArray(payload.restrictedIcaos)
    && typeof payload.generatedAt === 'number' && nowMs - payload.generatedAt <= NMS_CLOSURES_MAX_AGE_MS;
}

/**
 * Merge closure snapshots ({ closedIcaos, restrictedIcaos, reasons }) from
 * several sources into the aviation:notam:closures:v2 shape, limited to
 * `watchIcaos`. An airport closed by any source is closed. Its reason comes
 * from the earliest source that closed it, else the earliest that restricted
 * it. `sourceByIcao` names the source that supplied the reason.
 *
 * @param {{ label: string, snapshot: object | null }[]} sources
 */
export function mergeClosureSources(sources, watchIcaos) {
  const watch = new Set(watchIcaos);
  const closed = new Set();
  const restricted = new Set();
  // Notes are kept per bucket: a closed airport's alert is titled from its
  // reason, so a closing source's text beats an earlier restriction note.
  const closedNotes = {};
  const restrictedNotes = {};
  for (const { label, snapshot } of sources) {
    if (!snapshot) continue;
    const note = (notes, icao) => {
      if (notes[icao] === undefined && typeof snapshot.reasons?.[icao] === 'string') {
        notes[icao] = { reason: snapshot.reasons[icao], label };
      }
    };
    for (const icao of snapshot.closedIcaos || []) if (watch.has(icao)) { closed.add(icao); note(closedNotes, icao); }
    for (const icao of snapshot.restrictedIcaos || []) if (watch.has(icao)) { restricted.add(icao); note(restrictedNotes, icao); }
  }
  for (const icao of closed) restricted.delete(icao);
  const covered = new Set();
  for (const { snapshot } of sources) {
    for (const icao of Array.isArray(snapshot?.coveredIcaos) ? snapshot.coveredIcaos : []) if (watch.has(icao)) covered.add(icao);
  }
  const reasons = {};
  const sourceByIcao = {};
  for (const icao of [...closed, ...restricted]) {
    const picked = closedNotes[icao] ?? restrictedNotes[icao];
    if (picked) {
      reasons[icao] = picked.reason;
      sourceByIcao[icao] = picked.label;
    }
  }
  return { closedIcaos: [...closed], restrictedIcaos: [...restricted], reasons, sourceByIcao, coveredIcaos: [...covered].sort() };
}
