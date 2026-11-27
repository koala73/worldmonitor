'use strict';

const { US_HUBS, HUB_RADIUS_KM, CONUS_BOX, EUROPE_BOX, EUROPE_MARKETS } = require('./air-traffic-regions.cjs');

const BIN_MS = 300_000;
const LOW_ALTITUDE_M = 3000;
const EARTH_RADIUS_KM = 6371;

// OpenSky /states/all row indexes.
const CALLSIGN = 1;
const LON = 5;
const LAT = 6;
const BARO_ALT = 7;
const ON_GROUND = 8;
const VERTICAL_RATE = 11;
const GEO_ALT = 13;

// An ICAO airline designator then a flight number. Registrations (N123AB,
// DEABC) are general aviation, which keeps flying through a ground stop.
const AIRLINE_CALLSIGN = /^[A-Z]{3}[0-9]/;
const isAirline = (callsign) => typeof callsign === 'string' && AIRLINE_CALLSIGN.test(callsign.trim());

const binStart = (ms) => Math.floor(ms / BIN_MS) * BIN_MS;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const inBox = (lat, lon, box) => lat >= box.south && lat <= box.north && lon >= box.west && lon <= box.east;

const toRad = (deg) => (deg * Math.PI) / 180;
const toHub = (hub) => ({ iata: hub.iata, lat: toRad(hub.lat), lon: toRad(hub.lon), cosLat: Math.cos(toRad(hub.lat)) });
const HUBS = US_HUBS.map(toHub);
const MARKETS = EUROPE_MARKETS.map((market) => ({ code: market.code, hubs: market.hubs.map(toHub) }));
const HUB_LAT_SPAN_DEG = (HUB_RADIUS_KM / EARTH_RADIUS_KM) * (180 / Math.PI);

function withinHubRadius(hub, latRad, lonRad, cosLat) {
  const dLat = latRad - hub.lat;
  const dLon = lonRad - hub.lon;
  const a = Math.sin(dLat / 2) ** 2 + hub.cosLat * cosLat * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a))) <= HUB_RADIUS_KM;
}

const nearHub = (hub, latRad, lonRad, cosLat) =>
  Math.abs(latRad - hub.lat) * (180 / Math.PI) <= HUB_LAT_SPAN_DEG && withinHubRadius(hub, latRad, lonRad, cosLat);

function isLowClimbing(state) {
  const altitude = finite(state[BARO_ALT]) ? state[BARO_ALT] : state[GEO_ALT];
  const verticalRate = state[VERTICAL_RATE];
  return finite(altitude) && altitude < LOW_ALTITUDE_M && finite(verticalRate) && verticalRate > 0;
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
  let usAirborneAirline = 0;
  let usLowClimbingAirline = 0;
  let euAirborneAirline = 0;
  const hubs = Object.fromEntries(US_HUBS.map((hub) => [hub.iata, { air: 0, ground: 0, dep: 0 }]));
  const markets = Object.fromEntries(MARKETS.map((market) => [market.code, { seen: 0, dep: 0 }]));
  for (const state of states) {
    if (!Array.isArray(state)) continue;
    const lat = state[LAT];
    const lon = state[LON];
    if (!finite(lat) || !finite(lon)) continue;
    statesTotal += 1;
    const onGround = state[ON_GROUND] === true;
    const airline = isAirline(state[CALLSIGN]);
    if (inBox(lat, lon, EUROPE_BOX)) {
      if (!onGround) {
        euAirborne += 1;
        if (airline) euAirborneAirline += 1;
      }
      const latRad = toRad(lat);
      const lonRad = toRad(lon);
      const cosLat = Math.cos(latRad);
      const departing = !onGround && airline && isLowClimbing(state);
      for (const market of MARKETS) {
        if (!market.hubs.some((hub) => nearHub(hub, latRad, lonRad, cosLat))) continue;
        markets[market.code].seen += 1;
        if (departing) markets[market.code].dep += 1;
      }
      continue;
    }
    if (!inBox(lat, lon, CONUS_BOX)) continue;
    usSeen += 1;
    let departing = false;
    if (!onGround) {
      usAirborne += 1;
      if (airline) usAirborneAirline += 1;
      if (isLowClimbing(state)) {
        usLowClimbing += 1;
        if (airline) {
          usLowClimbingAirline += 1;
          departing = true;
        }
      }
    }
    const latRad = toRad(lat);
    const lonRad = toRad(lon);
    const cosLat = Math.cos(latRad);
    for (const hub of HUBS) {
      if (!nearHub(hub, latRad, lonRad, cosLat)) continue;
      hubs[hub.iata][onGround ? 'ground' : 'air'] += 1;
      if (departing) hubs[hub.iata].dep += 1;
    }
  }
  return {
    t: binStart(fetchedAt), status: 'ok', usSeen, usAirborne, usLowClimbing, euAirborne,
    usAirborneAirline, usLowClimbingAirline, euAirborneAirline, hubs, markets, statesTotal,
  };
}

function gapPoint(fetchedAt) {
  return { t: binStart(fetchedAt), status: 'gap' };
}

module.exports = { BIN_MS, LOW_ALTITUDE_M, binStart, aggregateStates, gapPoint };
