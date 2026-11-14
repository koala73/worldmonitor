'use strict';

const { US_HUBS, HUB_RADIUS_KM, CONUS_BOX, EUROPE_BOX } = require('./air-traffic-regions.cjs');

const BIN_MS = 300_000;
const LOW_ALTITUDE_M = 3000;
const EARTH_RADIUS_KM = 6371;

// OpenSky /states/all row indexes.
const LON = 5;
const LAT = 6;
const BARO_ALT = 7;
const ON_GROUND = 8;
const VERTICAL_RATE = 11;
const GEO_ALT = 13;

const binStart = (ms) => Math.floor(ms / BIN_MS) * BIN_MS;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const inBox = (lat, lon, box) => lat >= box.south && lat <= box.north && lon >= box.west && lon <= box.east;

const toRad = (deg) => (deg * Math.PI) / 180;
const HUBS = US_HUBS.map((hub) => ({ iata: hub.iata, lat: toRad(hub.lat), lon: toRad(hub.lon), cosLat: Math.cos(toRad(hub.lat)) }));
const HUB_LAT_SPAN_DEG = (HUB_RADIUS_KM / EARTH_RADIUS_KM) * (180 / Math.PI);

function withinHubRadius(hub, latRad, lonRad, cosLat) {
  const dLat = latRad - hub.lat;
  const dLon = lonRad - hub.lon;
  const a = Math.sin(dLat / 2) ** 2 + hub.cosLat * cosLat * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a))) <= HUB_RADIUS_KM;
}

// One snapshot of OpenSky states in, one traffic point out. Throws when there is
// no states array, so a failed or malformed fetch can never become a point with
// zero counts.
function aggregateStates(states, fetchedAt) {
  if (!Array.isArray(states)) throw new TypeError('states must be an array');
  if (!finite(fetchedAt)) throw new TypeError('fetchedAt must be a finite epoch ms');
  let statesTotal = 0;
  let usSeen = 0;
  let usAirborne = 0;
  let usLowClimbing = 0;
  let euAirborne = 0;
  const hubs = Object.fromEntries(US_HUBS.map((hub) => [hub.iata, { air: 0, ground: 0 }]));
  for (const state of states) {
    if (!Array.isArray(state)) continue;
    const lat = state[LAT];
    const lon = state[LON];
    if (!finite(lat) || !finite(lon)) continue;
    statesTotal += 1;
    const onGround = state[ON_GROUND] === true;
    if (inBox(lat, lon, EUROPE_BOX)) {
      if (!onGround) euAirborne += 1;
      continue;
    }
    if (!inBox(lat, lon, CONUS_BOX)) continue;
    usSeen += 1;
    if (!onGround) {
      usAirborne += 1;
      const altitude = finite(state[BARO_ALT]) ? state[BARO_ALT] : state[GEO_ALT];
      const verticalRate = state[VERTICAL_RATE];
      if (finite(altitude) && altitude < LOW_ALTITUDE_M && finite(verticalRate) && verticalRate > 0) usLowClimbing += 1;
    }
    const latRad = toRad(lat);
    const lonRad = toRad(lon);
    const cosLat = Math.cos(latRad);
    for (const hub of HUBS) {
      if (Math.abs(latRad - hub.lat) * (180 / Math.PI) > HUB_LAT_SPAN_DEG) continue;
      if (withinHubRadius(hub, latRad, lonRad, cosLat)) hubs[hub.iata][onGround ? 'ground' : 'air'] += 1;
    }
  }
  return { t: binStart(fetchedAt), status: 'ok', usSeen, usAirborne, usLowClimbing, euAirborne, hubs, statesTotal };
}

function gapPoint(fetchedAt) {
  return { t: binStart(fetchedAt), status: 'gap' };
}

module.exports = { BIN_MS, LOW_ALTITUDE_M, binStart, aggregateStates, gapPoint };
