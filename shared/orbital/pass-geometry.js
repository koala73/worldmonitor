import { ecfToLookAngles, eciToEcf, eciToGeodetic, gstime, json2satrec, propagate } from 'satellite.js';
import { isLandOrCoast } from './coverage.js';
import { sunElevationDeg } from './sun.js';

const EARTH_RADIUS_KM = 6371;
const EARTH_ROTATION_KM_S = 0.4651;
const DEG = Math.PI / 180;
const DAY_MS = 86_400_000;

export const ORBIT_ELEMENTS_MAX_AGE_DAYS = 7;
export const PASS_MIN_ELEVATION_DEG = 10;
export const EDGE_OF_SWATH_KM = 5;
export const PASS_WINDOW_MAX_DAYS = 10;

const SCAN_STEP_S = 20;
const SCAN_MARGIN_KM = 100;
const REFINE_TOLERANCE_S = 0.5;
const DUPLICATE_WINDOW_MS = 60_000;
const GEOSTATIONARY_MEAN_MOTION = [0.95, 1.05];

export function parseOrbitElements(omm) {
  const satrec = json2satrec(omm);
  return {
    noradId: Number(omm.NORAD_CAT_ID),
    name: String(omm.OBJECT_NAME),
    epochMs: Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(omm.EPOCH) ? omm.EPOCH : `${omm.EPOCH}Z`),
    meanMotionRevPerDay: Number(omm.MEAN_MOTION),
    satrec,
  };
}

function toMs(value) {
  return value instanceof Date ? value.getTime() : value;
}

function groundDistanceKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a)));
}

function windowBounds(window) {
  const startMs = toMs(window.start);
  const endMs = toMs(window.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs || endMs - startMs > PASS_WINDOW_MAX_DAYS * DAY_MS) {
    throw new RangeError(`window must be finite, ordered and at most ${PASS_WINDOW_MAX_DAYS} days long`);
  }
  return { startMs, endMs };
}

function stateAt(elements, timeMs) {
  const date = new Date(timeMs);
  const position = propagate(elements.satrec, date)?.position;
  if (!position || typeof position === 'boolean') return null;
  const gmst = gstime(date);
  const geodetic = eciToGeodetic(position, gmst);
  return {
    timeMs,
    lat: geodetic.latitude / DEG,
    lon: geodetic.longitude / DEG,
    altitudeKm: geodetic.height,
    ecf: eciToEcf(position, gmst),
  };
}

function unit(v) {
  const n = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / n, y: v.y / n, z: v.z / n };
}

function pointEcf(point) {
  const lat = point.lat * DEG;
  const lon = point.lon * DEG;
  return { x: Math.cos(lat) * Math.cos(lon), y: Math.cos(lat) * Math.sin(lon), z: Math.sin(lat) };
}

function sideOfTrack(elements, state, point) {
  const before = stateAt(elements, state.timeMs - 1000);
  const after = stateAt(elements, state.timeMs + 1000);
  if (!before || !after) return 'right';
  const v = { x: after.ecf.x - before.ecf.x, y: after.ecf.y - before.ecf.y, z: after.ecf.z - before.ecf.z };
  const s = unit(state.ecf);
  const right = { x: v.y * s.z - v.z * s.y, y: v.z * s.x - v.x * s.z, z: v.x * s.y - v.y * s.x };
  const p = pointEcf(point);
  return right.x * p.x + right.y * p.y + right.z * p.z >= 0 ? 'right' : 'left';
}

function groundRangeForOffNadirKm(offNadirDeg, altitudeKm) {
  const sinIncidence = ((EARTH_RADIUS_KM + altitudeKm) / EARTH_RADIUS_KM) * Math.sin(offNadirDeg * DEG);
  if (sinIncidence >= 1) return horizonRangeKm(0, altitudeKm);
  return EARTH_RADIUS_KM * (Math.asin(sinIncidence) - offNadirDeg * DEG);
}

function groundRangeForIncidenceKm(incidenceDeg, altitudeKm) {
  const offNadir = Math.asin((EARTH_RADIUS_KM * Math.sin(incidenceDeg * DEG)) / (EARTH_RADIUS_KM + altitudeKm));
  return EARTH_RADIUS_KM * (incidenceDeg * DEG - offNadir);
}

function horizonRangeKm(elevationDeg, altitudeKm) {
  const e = elevationDeg * DEG;
  return EARTH_RADIUS_KM * (Math.acos((EARTH_RADIUS_KM * Math.cos(e)) / (EARTH_RADIUS_KM + altitudeKm)) - e);
}

// The footprint as a band of ground range from the ground track, on the sides it can see.
function footprintBand(footprint, altitudeKm) {
  switch (footprint.kind) {
    case 'nadir-swath':
      return { nearKm: 0, farKm: footprint.swathKm / 2, sides: ['left', 'right'] };
    case 'side-looking':
      return {
        nearKm: groundRangeForIncidenceKm(footprint.incidenceDeg[0], altitudeKm),
        farKm: groundRangeForIncidenceKm(footprint.incidenceDeg[1], altitudeKm),
        sides: [footprint.side],
      };
    case 'steerable':
      return {
        nearKm: groundRangeForOffNadirKm(footprint.lookAngleDeg[0], altitudeKm),
        farKm: groundRangeForOffNadirKm(footprint.lookAngleDeg[1], altitudeKm),
        sides: ['left', 'right'],
      };
    case 'horizon':
      return { nearKm: 0, farKm: horizonRangeKm(footprint.minElevationDeg, altitudeKm), sides: ['left', 'right'] };
    default:
      return { nearKm: 0, farKm: 0, sides: [] };
  }
}

function describePass(elements, profile, point, state, nowMs) {
  const distanceKm = groundDistanceKm(point.lat, point.lon, state.lat, state.lon);
  const look = ecfToLookAngles({ latitude: point.lat * DEG, longitude: point.lon * DEG, height: 0 }, state.ecf);
  const elevationDeg = look.elevation / DEG;
  const side = sideOfTrack(elements, state, point);
  const band = footprintBand(profile.footprint, state.altitudeKm);
  const inFootprint = band.sides.includes(side) && distanceKm >= band.nearKm && distanceKm <= band.farKm;
  const edgeDistanceKm = Math.min(band.farKm - distanceKm, band.nearKm > 0 ? distanceKm - band.nearKm : Infinity);
  return {
    noradId: elements.noradId,
    name: elements.name,
    profileId: profile.id,
    category: profile.category,
    time: new Date(state.timeMs).toISOString(),
    timeMs: state.timeMs,
    opportunity: state.timeMs > nowMs,
    groundDistanceKm: distanceKm,
    side,
    elevationDeg,
    azimuthDeg: look.azimuth / DEG,
    incidenceDeg: 90 - elevationDeg,
    sunElevationDeg: sunElevationDeg(new Date(state.timeMs), point.lat, point.lon),
    altitudeKm: state.altitudeKm,
    subSatellite: { lat: state.lat, lon: state.lon },
    inFootprint,
    edgeOfSwath: inFootprint && edgeDistanceKm <= EDGE_OF_SWATH_KM,
    coverage: profile.coverage === 'global' || isLandOrCoast(point.lat, point.lon),
  };
}

function refineClosestApproach(elements, point, startMs, endMs) {
  const distanceAt = (t) => {
    const state = stateAt(elements, t);
    return state ? groundDistanceKm(point.lat, point.lon, state.lat, state.lon) : Infinity;
  };
  const ratio = (Math.sqrt(5) - 1) / 2;
  let a = startMs;
  let b = endMs;
  let c = b - ratio * (b - a);
  let d = a + ratio * (b - a);
  let fc = distanceAt(c);
  let fd = distanceAt(d);
  while (b - a > REFINE_TOLERANCE_S * 1000) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - ratio * (b - a);
      fc = distanceAt(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + ratio * (b - a);
      fd = distanceAt(d);
    }
  }
  return stateAt(elements, Math.round((a + b) / 2));
}

function isGeostationary(elements) {
  return elements.meanMotionRevPerDay >= GEOSTATIONARY_MEAN_MOTION[0] && elements.meanMotionRevPerDay <= GEOSTATIONARY_MEAN_MOTION[1];
}

export function findPasses({ elements, profile, point, window, now }) {
  const nowMs = toMs(now);
  const { startMs, endMs } = windowBounds(window);
  const ageDays = (nowMs - elements.epochMs) / DAY_MS;
  if (ageDays > ORBIT_ELEMENTS_MAX_AGE_DAYS) return { status: 'too-old', ageDays, passes: [] };

  if (isGeostationary(elements)) {
    const state = stateAt(elements, Math.min(Math.max(nowMs, startMs), endMs));
    const look = state && ecfToLookAngles({ latitude: point.lat * DEG, longitude: point.lon * DEG, height: 0 }, state.ecf);
    const elevationDeg = look ? look.elevation / DEG : -90;
    return {
      status: 'geostationary',
      ageDays,
      passes: [],
      visibility: { visible: elevationDeg > 0, elevationDeg, subSatelliteLon: state ? state.lon : null },
    };
  }

  const probe = stateAt(elements, startMs);
  const altitudeKm = probe ? probe.altitudeKm : 800;
  const band = footprintBand(profile.footprint, altitudeKm);
  const thresholdKm = Math.max(band.farKm, horizonRangeKm(PASS_MIN_ELEVATION_DEG, altitudeKm)) + SCAN_MARGIN_KM;
  const groundSpeedKmS = ((2 * Math.PI * EARTH_RADIUS_KM * elements.meanMotionRevPerDay) / 86_400 + EARTH_ROTATION_KM_S) * 1.25;

  const minima = [];
  let previous = Infinity;
  let falling = false;
  const scanEndMs = endMs + 2 * SCAN_STEP_S * 1000;
  for (let t = startMs - SCAN_STEP_S * 1000; t <= scanEndMs;) {
    const state = stateAt(elements, t);
    if (!state) {
      t += SCAN_STEP_S * 1000;
      continue;
    }
    const distanceKm = groundDistanceKm(point.lat, point.lon, state.lat, state.lon);
    if (distanceKm > thresholdKm) {
      if (falling && previous <= thresholdKm) minima.push(t - SCAN_STEP_S * 1000);
      falling = false;
      previous = distanceKm;
      t += Math.max(SCAN_STEP_S, (distanceKm - thresholdKm) / groundSpeedKmS) * 1000;
      continue;
    }
    if (distanceKm > previous && falling) minima.push(t - SCAN_STEP_S * 1000);
    falling = distanceKm <= previous || !Number.isFinite(previous);
    previous = distanceKm;
    t += SCAN_STEP_S * 1000;
  }

  const passes = [];
  for (const centre of minima) {
    const state = refineClosestApproach(elements, point, centre - SCAN_STEP_S * 1000, centre + SCAN_STEP_S * 1000);
    if (!state || state.timeMs < startMs || state.timeMs > endMs) continue;
    const pass = describePass(elements, profile, point, state, nowMs);
    if (!pass.inFootprint && pass.elevationDeg < PASS_MIN_ELEVATION_DEG) continue;
    const duplicate = passes.find((existing) => Math.abs(existing.timeMs - pass.timeMs) < DUPLICATE_WINDOW_MS);
    if (duplicate) {
      if (pass.groundDistanceKm < duplicate.groundDistanceKm) passes[passes.indexOf(duplicate)] = pass;
      continue;
    }
    passes.push(pass);
  }
  return { status: 'ok', ageDays, passes };
}

export function groundTrack(elements, window, stepSeconds = 60) {
  const { startMs, endMs } = windowBounds(window);
  if (!(stepSeconds > 0)) throw new RangeError('stepSeconds must be positive');
  const segments = [];
  let segment = [];
  for (let t = startMs; t <= endMs; t += stepSeconds * 1000) {
    const state = stateAt(elements, t);
    if (!state) continue;
    const previous = segment.at(-1);
    if (previous && Math.abs(state.lon - previous.lon) > 180) {
      segments.push(segment);
      segment = [];
    }
    segment.push({ time: new Date(t).toISOString(), lat: state.lat, lon: state.lon });
  }
  if (segment.length) segments.push(segment);
  return segments;
}
