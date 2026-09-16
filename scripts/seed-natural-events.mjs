#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import {
  loadEnvFile,
  CHROME_UA,
  httpRetryError,
  readSeedSnapshot,
  runSeed,
  withRetry,
  writeExtraKey,
} from './_seed-utils.mjs';
import {
  buildWesternPacificCycloneSnapshot,
  fetchHkoWarnings,
} from './natural/western-pacific-cyclones.mjs';

loadEnvFile(import.meta.url);

const EONET_API_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events';
const GDACS_API = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP';
const NHC_BASE = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';
const CANONICAL_KEY = 'natural:events:v1';
const NHC_SNAPSHOT_KEY = 'natural:events:nhc-snapshot:v1';
const WESTERN_PACIFIC_CYCLONES_KEY = 'natural:western-pacific-cyclones:v1';
const HKO_WARNINGS_KEY = 'weather:hko-warnings:v1';
const CACHE_TTL = 64800; // 18h — 6x the 3h Railway bundle cadence; preserves last-good through health grace.
const NHC_RETAIN_MS = 540 * 60_000;
const NHC_FAILURE_CODES = new Set([
  'NHC_POINT_REQUEST_FAILED',
  'NHC_POINT_RESPONSE_INVALID',
]);
const NHC_POINT_GEOMETRY_TYPES = new Set(['Point']);
const NHC_CONE_GEOMETRY_TYPES = new Set(['Polygon', 'MultiPolygon']);
const NHC_ADVISORY_TIMEZONE_OFFSETS_MIN = {
  UTC: 0,
  GMT: 0,
  AST: -4 * 60,
  ADT: -3 * 60,
  EST: -5 * 60,
  EDT: -4 * 60,
  CST: -6 * 60,
  CDT: -5 * 60,
  MST: -7 * 60,
  MDT: -6 * 60,
  PST: -8 * 60,
  PDT: -7 * 60,
  AKST: -9 * 60,
  AKDT: -8 * 60,
  HST: -10 * 60,
};
const NHC_ADVISORY_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const NHC_ADVISORY_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const DAYS = 30;
const WILDFIRE_MAX_AGE_MS = 48 * 60 * 60 * 1000;

const GDACS_TO_CATEGORY = {
  EQ: 'earthquakes',
  FL: 'floods',
  TC: 'severeStorms',
  VO: 'volcanoes',
  WF: 'wildfires',
  DR: 'drought',
};

const EVENT_TYPE_NAMES = {
  EQ: 'Earthquake',
  FL: 'Flood',
  TC: 'Tropical Cyclone',
  VO: 'Volcano',
  WF: 'Wildfire',
  DR: 'Drought',
};

const NATURAL_EVENT_CATEGORIES = new Set([
  'severeStorms', 'wildfires', 'volcanoes', 'earthquakes', 'floods',
  'landslides', 'drought', 'dustHaze', 'snow', 'tempExtremes',
  'seaLakeIce', 'waterColor', 'manmade',
]);

function normalizeCategory(id) {
  const c = String(id || '').trim();
  return NATURAL_EVENT_CATEGORIES.has(c) ? c : 'manmade';
}

async function fetchEonet(days, fetchFn = globalThis.fetch) {
  const url = `${EONET_API_URL}?status=open&days=${days}`;
  const res = await fetchFn(url, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`EONET ${res.status}`);

  const data = await res.json();
  if (!Array.isArray(data?.events)) throw new Error('EONET malformed response');
  const events = [];
  const now = Date.now();

  for (const event of data.events || []) {
    const category = event.categories?.[0];
    if (!category) continue;
    const normalizedCategory = normalizeCategory(category.id);
    if (normalizedCategory === 'earthquakes') continue;

    const latestGeo = event.geometry?.[event.geometry.length - 1];
    if (!latestGeo || latestGeo.type !== 'Point') continue;

    const eventDate = new Date(latestGeo.date);
    const [lon, lat] = latestGeo.coordinates;

    if (normalizedCategory === 'wildfires' && now - eventDate.getTime() > WILDFIRE_MAX_AGE_MS) continue;

    const source = event.sources?.[0];
    events.push({
      id: event.id || '',
      title: event.title || '',
      description: event.description || '',
      category: normalizedCategory,
      categoryTitle: category.title || '',
      lat,
      lon,
      date: eventDate.getTime(),
      magnitude: latestGeo.magnitudeValue ?? 0,
      magnitudeUnit: latestGeo.magnitudeUnit || '',
      sourceUrl: source?.url || '',
      sourceName: source?.id || '',
      closed: event.closed !== null,
    });
  }

  return events;
}

function classifyWind(kt) {
  if (kt >= 137) return { category: 5, classification: 'Category 5' };
  if (kt >= 113) return { category: 4, classification: 'Category 4' };
  if (kt >= 96) return { category: 3, classification: 'Category 3' };
  if (kt >= 83) return { category: 2, classification: 'Category 2' };
  if (kt >= 64) return { category: 1, classification: 'Category 1' };
  if (kt >= 34) return { category: 0, classification: 'Tropical Storm' };
  return { category: 0, classification: 'Tropical Depression' };
}

function parseNhcAdvisoryDate(value) {
  if (typeof value !== 'string') return new Date(value).getTime();

  const match = value.match(/^(\d{1,2})(\d{2}) (AM|PM) ([A-Z]{3,4}) (Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}) (\d{4})$/);
  if (!match) return new Date(value).getTime();

  const [, hourText, minuteText, meridiem, timezone, weekday, monthText, dayText, yearText] = match;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const month = NHC_ADVISORY_MONTHS.indexOf(monthText);
  const day = Number(dayText);
  const year = Number(yearText);
  const timezoneOffsetMin = NHC_ADVISORY_TIMEZONE_OFFSETS_MIN[timezone];
  const calendarDate = new Date(Date.UTC(year, month, day));
  if (hour < 1 || hour > 12 || minute > 59 || timezoneOffsetMin === undefined
    || calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month
    || calendarDate.getUTCDate() !== day || calendarDate.getUTCDay() !== NHC_ADVISORY_WEEKDAYS.indexOf(weekday)) {
    return Number.NaN;
  }

  const hour24 = hour % 12 + (meridiem === 'PM' ? 12 : 0);
  return Date.UTC(year, month, day, hour24, minute) - timezoneOffsetMin * 60_000;
}

function parseGdacsTcFields(props) {
  const fields = {};
  fields.stormId = `gdacs-TC-${props.eventid}`;

  const name = String(props.name || '');
  const nameMatch = name.match(/(?:Hurricane|Typhoon|Cyclone|Storm|Depression)\s+(.+)/i);
  fields.stormName = nameMatch ? nameMatch[1].trim() : name.trim() || undefined;

  const desc = String(props.description || '') + ' ' + String(props.severitydata?.severitytext || '');

  const windPatterns = [
    /(\d+(?:\.\d+)?)\s*(?:kn(?:ots?)?|kt)/i,
    /(\d+(?:\.\d+)?)\s*mph/i,
    /(\d+(?:\.\d+)?)\s*km\/?h/i,
  ];
  for (const [i, pat] of windPatterns.entries()) {
    const m = desc.match(pat);
    if (m) {
      let val = parseFloat(m[1]);
      if (i === 1) val = Math.round(val * 0.868976);
      else if (i === 2) val = Math.round(val * 0.539957);
      if (val > 0 && val <= 200) {
        fields.windKt = Math.round(val);
        const { category, classification } = classifyWind(fields.windKt);
        fields.stormCategory = category;
        fields.classification = classification;
      }
      break;
    }
  }

  const pressureMatch = desc.match(/(\d{3,4})\s*(?:mb|hPa|mbar)/i);
  if (pressureMatch) {
    const p = parseInt(pressureMatch[1], 10);
    if (p >= 850 && p <= 1050) fields.pressureMb = p;
  }

  return fields;
}

// One list request per event type. GDACS changed the MAP endpoint on or before
// 2026-09-16: a bare request answers `400 {"message":"Eventtype is required."}`
// and `eventtype=ALL` / a `;`-joined list answers `400 {"message":"Please
// specify only 1 eventtype."}`, so the single mixed-type call this seeder made
// since #5276 failed every run and crashed it whenever EONET also blipped. The
// per-type responses carry the same GeoJSON feature shape the mapper below
// reads.
//
// Coverage is now per type, and the reader must know which types answered:
// a rejected list used to mean "no GDACS coverage at all", but six requests
// have six times the failure surface, and dropping every GDACS event because
// one type timed out would publish a silently shorter feed under an `ok`
// source state. So fetchGdacs settles the six independently and returns the
// events of the types that answered PLUS the list of types that did not;
// fetchNaturalEvents publishes the partial list but marks the seed `degraded`
// (naturalEventsAfterPublish), proves western-Pacific cyclone coverage only
// when the TC list itself answered, and still refuses to publish an empty
// feed while any type is unaccounted for. Only when EVERY type fails does
// the fetch reject, which is the pre-existing "no GDACS at all" path
// (tests/natural-events-gdacs-eventtype.test.mjs).
async function fetchGdacsType(eventtype, fetchFn) {
  const res = await fetchFn(`${GDACS_API}?eventtype=${eventtype}`, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GDACS ${res.status} (${eventtype})`);

  const data = await res.json();
  if (!Array.isArray(data?.features)) throw new Error(`GDACS malformed response (${eventtype})`);
  return data.features;
}

const GDACS_ALERT_RANK = { Red: 0, Orange: 1 };

export async function fetchGdacs(fetchFn = globalThis.fetch) {
  const types = Object.keys(GDACS_TO_CATEGORY);
  const settled = await Promise.allSettled(types.map((eventtype) => fetchGdacsType(eventtype, fetchFn)));
  const failedTypes = [];
  const features = [];
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') features.push(...result.value);
    else failedTypes.push({ eventtype: types[i], message: result.reason?.message || String(result.reason) });
  });
  if (failedTypes.length === types.length) {
    throw new Error(`GDACS unavailable: ${failedTypes.map((t) => t.message).join('; ')}`);
  }

  // The 100-event cap used to fall on GDACS's own mixed-type ordering. The
  // per-type lists arrive grouped, so capping the raw concatenation would let
  // 100 earthquakes evict every cyclone, including the TC members the
  // western-Pacific snapshot is built from. Rank by alert level, then newest
  // first, so the cap drops the least urgent events regardless of type.
  const rank = (f) => GDACS_ALERT_RANK[f?.properties?.alertlevel] ?? 2;
  const started = (f) => new Date(f?.properties?.fromdate || 0).getTime() || 0;
  features.sort((a, b) => rank(a) - rank(b) || started(b) - started(a));

  const seen = new Set();
  const events = [];

  for (const f of features) {
    if (!f.geometry || f.geometry.type !== 'Point') continue;
    const props = f.properties;
    const key = `${props.eventtype}-${props.eventid}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (props.alertlevel === 'Green') continue;

    const category = GDACS_TO_CATEGORY[props.eventtype] || 'manmade';
    const alertPrefix = props.alertlevel === 'Red' ? '\u{1F534} ' : props.alertlevel === 'Orange' ? '\u{1F7E0} ' : '';
    const description = props.description || EVENT_TYPE_NAMES[props.eventtype] || props.eventtype;
    const severity = props.severitydata?.severitytext || '';

    const tcFields = props.eventtype === 'TC' ? parseGdacsTcFields(props) : {};

    events.push({
      id: `gdacs-${props.eventtype}-${props.eventid}`,
      title: `${alertPrefix}${props.name || ''}`,
      description: `${description}${severity ? ` - ${severity}` : ''}`,
      category,
      categoryTitle: description,
      lat: f.geometry.coordinates[1] ?? 0,
      lon: f.geometry.coordinates[0] ?? 0,
      date: new Date(props.fromdate || 0).getTime(),
      magnitude: 0,
      magnitudeUnit: '',
      sourceUrl: props.url?.report || '',
      sourceName: 'GDACS',
      closed: false,
      ...tcFields,
      forecastTrack: [],
      conePolygon: [],
      pastTrack: [],
    });
  }

  // The cap is a feed-size budget for the general list only. The cyclone
  // snapshot is built from GDACS TC members and its `dataAvailable` is proven
  // by the TC list answering, so it reads the uncapped TC events: a hundred
  // higher-ranked or newer non-TC features must not turn an active storm into
  // a vouched-for absence.
  return {
    events: events.slice(0, 100),
    cycloneEvents: events.filter((event) => event.id.startsWith('gdacs-TC-')),
    failedTypes,
  };
}

// NHC ArcGIS layer IDs per storm slot (5 slots per basin)
// Each slot has: forecastPoints, forecastTrack, forecastCone, pastPoints, pastTrack
const NHC_STORM_SLOTS = [];
const BASIN_OFFSETS = { AT: 4, EP: 134, CP: 264 };
const BASIN_CODES = { AT: 'AL', EP: 'EP', CP: 'CP' };
for (const [prefix, base] of Object.entries(BASIN_OFFSETS)) {
  for (let i = 0; i < 5; i++) {
    const offset = base + i * 26;
    NHC_STORM_SLOTS.push({
      basin: BASIN_CODES[prefix],
      forecastPoints: offset + 2,
      forecastTrack: offset + 3,
      forecastCone: offset + 4,
      pastPoints: offset + 7,
      pastTrack: offset + 8,
    });
  }
}

class NhcQueryError extends Error {
  constructor(message, { code = 'NHC_POINT_REQUEST_FAILED', cause, nonRetryable = false } = {}) {
    super(message, { cause });
    this.name = 'NhcQueryError';
    this.code = code;
    this.nonRetryable = nonRetryable;
    if (Number.isFinite(cause?.retryAfterMs)) this.retryAfterMs = cause.retryAfterMs;
  }
}

function validCoordinates(value, depth = 0) {
  if (!Array.isArray(value) || value.length === 0 || depth > 4) return false;
  if (value.every(Number.isFinite)) {
    return value.length >= 2
      && Math.abs(value[0]) <= 180
      && Math.abs(value[1]) <= 90;
  }
  return value.every((entry) => validCoordinates(entry, depth + 1));
}

function parseNhcGeoJson(payload, layerId, expectedGeometryTypes) {
  if (!payload || typeof payload !== 'object' || payload.type !== 'FeatureCollection'
    || !Array.isArray(payload.features) || payload.exceededTransferLimit === true) {
    throw new NhcQueryError(`NHC layer ${layerId} did not return a FeatureCollection`, {
      code: 'NHC_POINT_RESPONSE_INVALID',
      nonRetryable: true,
    });
  }
  for (const feature of payload.features) {
    const geometry = feature?.geometry;
    if (!feature || typeof feature !== 'object' || !geometry
      || !expectedGeometryTypes.has(geometry.type) || !validCoordinates(geometry.coordinates)
      || !feature.properties || typeof feature.properties !== 'object' || Array.isArray(feature.properties)) {
      throw new NhcQueryError(`NHC layer ${layerId} returned a malformed feature`, {
        code: 'NHC_POINT_RESPONSE_INVALID',
        nonRetryable: true,
      });
    }
  }
  return payload;
}

function validateRequiredForecastPoints(payload, layerId) {
  for (const feature of payload.features) {
    const properties = feature.properties;
    const forecastHour = properties.tau ?? properties.fcstprd;
    if (!Number.isFinite(forecastHour) || forecastHour < 0
      || !Number.isFinite(properties.maxwind)
      || properties.maxwind < 0 || properties.maxwind > 200) {
      throw new NhcQueryError(`NHC layer ${layerId} returned an invalid forecast point`, {
        code: 'NHC_POINT_RESPONSE_INVALID',
        nonRetryable: true,
      });
    }
  }
  return payload;
}

async function nhcQuery(layerId, expectedGeometryTypes, fetchFn = globalThis.fetch) {
  const url = `${NHC_BASE}/${layerId}/query?where=1%3D1&outFields=*&f=geojson`;
  return withRetry(async () => {
    const res = await fetchFn(url, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      await res.body?.cancel?.();
      const cause = httpRetryError(res, { remainingBudgetMs: 15_000 });
      throw new NhcQueryError(`NHC layer ${layerId}: ${cause.message}`, {
        cause,
        nonRetryable: cause.nonRetryable,
      });
    }
    let payload;
    try {
      payload = await res.json();
    } catch (cause) {
      const bodyTransportFailure = cause instanceof TypeError
        || cause?.name === 'AbortError'
        || cause?.name === 'TimeoutError';
      throw new NhcQueryError(
        `NHC layer ${layerId} ${bodyTransportFailure ? 'body read failed' : 'returned invalid JSON'}`,
        {
          code: bodyTransportFailure ? 'NHC_POINT_REQUEST_FAILED' : 'NHC_POINT_RESPONSE_INVALID',
          cause,
          nonRetryable: !bodyTransportFailure,
        },
      );
    }
    return parseNhcGeoJson(payload, layerId, expectedGeometryTypes);
  }, 1, 500);
}

const NHC_STORM_TYPES = {
  HU: 'Hurricane', TS: 'Tropical Storm', TD: 'Tropical Depression',
  STS: 'Subtropical Storm', STD: 'Subtropical Depression',
  EX: 'Post-Tropical', PT: 'Post-Tropical',
};

async function fetchNhc(fetchFn = globalThis.fetch) {
  const pointQueries = NHC_STORM_SLOTS.map(s => nhcQuery(s.forecastPoints, NHC_POINT_GEOMETRY_TYPES, fetchFn));
  const pointResults = await Promise.allSettled(pointQueries);

  const failedPointResults = pointResults.filter(result => result.status === 'rejected');
  if (failedPointResults.length > 0) {
    const invalid = failedPointResults.some(result => result.reason?.code === 'NHC_POINT_RESPONSE_INVALID');
    const errorCode = invalid ? 'NHC_POINT_RESPONSE_INVALID' : 'NHC_POINT_REQUEST_FAILED';
    const causes = failedPointResults.map(result => result.reason);
    const error = new NhcQueryError(
      `NHC required point coverage incomplete (${failedPointResults.length} of ${NHC_STORM_SLOTS.length} layers failed)`,
      { code: errorCode, cause: new AggregateError(causes), nonRetryable: true },
    );
    error.transient = !invalid && causes.every(cause => !cause?.nonRetryable);
    throw error;
  }

  for (let i = 0; i < pointResults.length; i++) {
    validateRequiredForecastPoints(pointResults[i].value, NHC_STORM_SLOTS[i].forecastPoints);
  }

  const activeSlots = [];
  for (let i = 0; i < NHC_STORM_SLOTS.length; i++) {
    const r = pointResults[i];
    if (r.status === 'fulfilled' && r.value.features?.length > 0) {
      activeSlots.push({ slot: NHC_STORM_SLOTS[i], points: r.value });
    }
  }

  if (activeSlots.length === 0) return [];

  // Fetch track, cone, past data for active storms only
  const detailQueries = activeSlots.map(async ({ slot, points }) => {
    const [coneRes, pastPtsRes] = await Promise.allSettled([
      nhcQuery(slot.forecastCone, NHC_CONE_GEOMETRY_TYPES, fetchFn),
      nhcQuery(slot.pastPoints, NHC_POINT_GEOMETRY_TYPES, fetchFn),
    ]);
    return {
      slot, points,
      cone: coneRes.status === 'fulfilled' ? coneRes.value : null,
      pastPts: pastPtsRes.status === 'fulfilled' ? pastPtsRes.value : null,
    };
  });
  const stormData = await Promise.all(detailQueries);

  const events = [];
  for (const { slot, points, cone, pastPts } of stormData) {
    // Current position = forecast point with tau=0
    const currentPt = points.features.find(f => f.properties?.tau === 0 || f.properties?.fcstprd === 0);
    if (!currentPt) {
      throw new NhcQueryError(`NHC layer ${slot.forecastPoints} has no current storm point`, {
        code: 'NHC_POINT_RESPONSE_INVALID',
        nonRetryable: true,
      });
    }

    const p = currentPt.properties;
    const advDate = p.advdate ? parseNhcAdvisoryDate(p.advdate) : Number.NaN;
    if (typeof p.stormname !== 'string' || p.stormname.trim().length === 0
      || !Number.isInteger(p.stormnum) || p.stormnum < 1 || p.stormnum > 99
      || !['string', 'number'].includes(typeof p.advisnum) || String(p.advisnum).trim().length === 0
      || !Number.isFinite(p.maxwind) || p.maxwind < 0 || p.maxwind > 200
      || !Number.isFinite(advDate)) {
      throw new NhcQueryError(`NHC layer ${slot.forecastPoints} has invalid current storm identity`, {
        code: 'NHC_POINT_RESPONSE_INVALID',
        nonRetryable: true,
      });
    }
    const stormName = p.stormname || '';
    const windKt = p.maxwind || 0;
    const ssNum = p.ssnum || 0;
    const stormType = p.stormtype || 'TS';
    const advisNum = p.advisnum || '';
    const stormNum = p.stormnum || 0;
    const stormId = `nhc-${slot.basin}${String(stormNum).padStart(2, '0')}-${advisNum}`;

    const classification = NHC_STORM_TYPES[stormType] || classifyWind(windKt).classification;
    const typeLabel = NHC_STORM_TYPES[stormType] || stormType;
    const title = `${typeLabel} ${stormName}`;

    // Build forecast track from forecast points
    const forecastTrack = points.features
      .filter(f => f.properties?.tau > 0 || f.properties?.fcstprd > 0)
      .sort((a, b) => (a.properties.tau || a.properties.fcstprd) - (b.properties.tau || b.properties.fcstprd))
      .map(f => ({
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0],
        hour: f.properties.tau || f.properties.fcstprd || 0,
        windKt: f.properties.maxwind || 0,
        category: f.properties.ssnum || 0,
      }));

    // Build cone polygon from forecast cone geometry (CoordRing format)
    const conePolygon = [];
    if (cone?.features?.length > 0) {
      for (const f of cone.features) {
        const rings =
          f.geometry?.type === 'Polygon' ? f.geometry.coordinates || [] :
          f.geometry?.type === 'MultiPolygon' ? (f.geometry.coordinates || []).flat() :
          [];
        for (const ring of rings) {
          conePolygon.push({ points: ring.map(([lon, lat]) => ({ lon, lat })) });
        }
      }
    }

    // Build past track from past points
    const pastTrack = [];
    if (pastPts?.features?.length > 0) {
      const sorted = pastPts.features
        .filter(f => f.geometry?.coordinates)
        .sort((a, b) => (a.properties.dtg || 0) - (b.properties.dtg || 0));
      for (const f of sorted) {
        const windKt = f.properties?.intensity ?? 0;
        const timestamp = f.properties?.dtg ?? 0;
        if (!Number.isFinite(windKt) || windKt < 0 || windKt > 200
          || !Number.isFinite(timestamp) || timestamp < 0) continue;
        pastTrack.push({
          lat: f.geometry.coordinates[1],
          lon: f.geometry.coordinates[0],
          windKt,
          timestamp,
        });
      }
    }

    const lat = currentPt.geometry.coordinates[1];
    const lon = currentPt.geometry.coordinates[0];

    const pressureMb = p.mslp >= 850 && p.mslp <= 1050 ? p.mslp : undefined;
    const event = {
      id: stormId,
      title,
      description: `${title}, Max wind ${windKt} kt${pressureMb ? `, Pressure ${pressureMb} mb` : ''}`,
      category: 'severeStorms',
      categoryTitle: 'Tropical Cyclone',
      lat,
      lon,
      date: advDate,
      magnitude: windKt,
      magnitudeUnit: 'kt',
      sourceUrl: `https://www.nhc.noaa.gov/`,
      sourceName: 'NHC',
      closed: false,
      stormId,
      stormName,
      basin: slot.basin,
      stormCategory: ssNum,
      classification,
      windKt,
      pressureMb,
      movementDir: p.tcdir ?? undefined,
      movementSpeedKt: p.tcspd ?? undefined,
      forecastTrack,
      conePolygon,
      pastTrack,
    };
    if (!validNhcEvent(event)) {
      throw new NhcQueryError(`NHC layer ${slot.forecastPoints} could not produce a valid storm`, {
        code: 'NHC_POINT_RESPONSE_INVALID',
        nonRetryable: true,
      });
    }
    events.push(event);
  }

  return events;
}

function validNhcEvent(event) {
  return event?.sourceName === 'NHC'
    && typeof event.id === 'string' && event.id.startsWith('nhc-')
    && typeof event.stormId === 'string' && event.stormId === event.id
    && typeof event.stormName === 'string' && event.stormName.trim().length > 0
    && ['AL', 'EP', 'CP'].includes(event.basin)
    && Number.isFinite(event.lat) && Math.abs(event.lat) <= 90
    && Number.isFinite(event.lon) && Math.abs(event.lon) <= 180
    && Number.isFinite(event.date) && event.date > 0
    && Number.isFinite(event.windKt) && event.windKt >= 0 && event.windKt <= 200
    && Array.isArray(event.forecastTrack) && event.forecastTrack.every(point => (
      Number.isFinite(point?.lat) && Math.abs(point.lat) <= 90
      && Number.isFinite(point?.lon) && Math.abs(point.lon) <= 180
      && Number.isFinite(point?.hour) && point.hour >= 0
      && Number.isFinite(point?.windKt) && point.windKt >= 0 && point.windKt <= 200
      && Number.isFinite(point?.category)
    ))
    && Array.isArray(event.conePolygon) && event.conePolygon.every(ring => (
      Array.isArray(ring?.points) && ring.points.length > 0 && ring.points.every(point => (
        Number.isFinite(point?.lat) && Math.abs(point.lat) <= 90
        && Number.isFinite(point?.lon) && Math.abs(point.lon) <= 180
      ))
    ))
    && Array.isArray(event.pastTrack) && event.pastTrack.every(point => (
      Number.isFinite(point?.lat) && Math.abs(point.lat) <= 90
      && Number.isFinite(point?.lon) && Math.abs(point.lon) <= 180
      && Number.isFinite(point?.windKt) && point.windKt >= 0 && point.windKt <= 200
      && Number.isFinite(point?.timestamp) && point.timestamp >= 0
    ));
}

function knownNhcSnapshotState(snapshot, now) {
  const count = snapshot?.consecutiveFailures;
  if (snapshot?.version !== 1 || !Number.isInteger(count) || count < 0 || count > 100
    || !Number.isSafeInteger(snapshot.lastAttemptAt) || snapshot.lastAttemptAt <= 0
    || snapshot.lastAttemptAt > now) return false;
  if (count === 0) return snapshot.firstFailureAt === null && snapshot.errorCode === null;
  return NHC_FAILURE_CODES.has(snapshot.errorCode)
    && Number.isSafeInteger(snapshot.firstFailureAt) && snapshot.firstFailureAt > 0
    && snapshot.firstFailureAt <= snapshot.lastAttemptAt;
}

function usableNhcSnapshot(snapshot, now) {
  return knownNhcSnapshotState(snapshot, now)
    && Number.isSafeInteger(snapshot.fetchedAt) && snapshot.fetchedAt > 0
    && snapshot.fetchedAt <= snapshot.lastAttemptAt
    && snapshot.fetchedAt <= now
    && Number.isSafeInteger(snapshot.retainedUntil)
    && snapshot.retainedUntil > snapshot.fetchedAt
    && snapshot.retainedUntil <= snapshot.fetchedAt + NHC_RETAIN_MS
    && now < snapshot.retainedUntil
    && (snapshot.consecutiveFailures === 0 || snapshot.firstFailureAt >= snapshot.fetchedAt)
    && Array.isArray(snapshot.events) && snapshot.events.length <= NHC_STORM_SLOTS.length
    && snapshot.events.every(validNhcEvent)
    && new Set(snapshot.events.map(event => event.id)).size === snapshot.events.length;
}

function failedNhcSnapshot(previous, now, errorCode, transient) {
  const known = knownNhcSnapshotState(previous, now);
  const usable = usableNhcSnapshot(previous, now);
  const priorCount = known ? previous.consecutiveFailures : 1;
  const nextCount = Math.min(priorCount + 1, 100);
  return {
    version: 1,
    fetchedAt: usable ? previous.fetchedAt : null,
    retainedUntil: usable ? previous.retainedUntil : null,
    events: usable ? previous.events : [],
    lastAttemptAt: now,
    consecutiveFailures: usable && transient ? nextCount : Math.max(2, nextCount),
    firstFailureAt: known && previous.consecutiveFailures > 0 ? previous.firstFailureAt : now,
    errorCode,
  };
}

function successfulNhcSnapshot(events, now) {
  return {
    version: 1,
    fetchedAt: now,
    retainedUntil: now + NHC_RETAIN_MS,
    events,
    lastAttemptAt: now,
    consecutiveFailures: 0,
    firstFailureAt: null,
    errorCode: null,
  };
}

function isWesternPacificCyclone(event) {
  return event?.category === 'severeStorms'
    && Boolean(event.stormName)
    && Number.isFinite(event.lat) && Number.isFinite(event.lon)
    && event.lat >= 0 && event.lat <= 50
    && event.lon >= 100 && event.lon <= 180;
}

function toWesternPacificObservation(event) {
  return {
    agency: 'GDACS',
    agencyId: event.stormId || event.id,
    basin: 'WP',
    aliases: [event.stormName],
    stormName: event.stormName,
    lat: event.lat,
    lon: event.lon,
    observedAt: event.date,
    // GDACS does not state an averaging period in this feed. Keep the value
    // unpaired rather than pretending it is equivalent to an agency advisory.
    windKt: event.windKt,
    pressureMb: event.pressureMb,
    classification: event.classification,
    sourceName: event.sourceName,
    sourceUrl: event.sourceUrl,
    sourceEventId: event.id,
  };
}

export async function fetchNaturalEvents({
  now = Date.now(),
  previousNhcSnapshot = null,
  fetchFn = globalThis.fetch,
  fetchHkoWarningsFn = fetchHkoWarnings,
} = {}) {
  const [eonetResult, gdacsResult, nhcResult, hkoResult] = await Promise.allSettled([
    fetchEonet(DAYS, fetchFn),
    fetchGdacs(fetchFn),
    fetchNhc(fetchFn),
    fetchHkoWarningsFn({ now, fetchFn }),
  ]);

  const eonetEvents = eonetResult.status === 'fulfilled' ? eonetResult.value : [];
  // Per-type coverage (see fetchGdacs). A rejected result means no type
  // answered; a fulfilled one may still carry failed types, which is partial
  // coverage: published, but marked degraded and never counted as proof.
  const gdacsEvents = gdacsResult.status === 'fulfilled' ? gdacsResult.value.events : [];
  const gdacsCyclones = gdacsResult.status === 'fulfilled' ? gdacsResult.value.cycloneEvents : [];
  const gdacsFailedTypes = gdacsResult.status === 'fulfilled'
    ? gdacsResult.value.failedTypes.map((t) => t.eventtype)
    : Object.keys(GDACS_TO_CATEGORY);
  const gdacsComplete = gdacsResult.status === 'fulfilled' && gdacsFailedTypes.length === 0;
  const gdacsTcCovered = gdacsResult.status === 'fulfilled' && !gdacsFailedTypes.includes('TC');
  const nhcSnapshot = nhcResult.status === 'fulfilled'
    ? successfulNhcSnapshot(nhcResult.value, now)
    : failedNhcSnapshot(
      previousNhcSnapshot,
      now,
      NHC_FAILURE_CODES.has(nhcResult.reason?.code) ? nhcResult.reason.code : 'NHC_POINT_REQUEST_FAILED',
      nhcResult.reason?.transient === true,
    );
  const nhcEvents = nhcSnapshot.events;
  const hko = hkoResult.status === 'fulfilled'
    ? hkoResult.value
    : { warnings: [], dataAvailable: false, sourceDecision: { source: 'HKO warning summary', host: 'data.weather.gov.hk', status: 'blocked', reason: 'FETCH_FAILED', optional: false, requestCount: 1 } };

  if (eonetResult.status === 'rejected') console.log('[EONET]', eonetResult.reason?.message);
  if (gdacsResult.status === 'rejected') console.log('[GDACS]', gdacsResult.reason?.message);
  else if (gdacsFailedTypes.length) {
    console.log('[GDACS] partial coverage —', gdacsResult.value.failedTypes.map((t) => `${t.eventtype}: ${t.message}`).join('; '));
  }
  if (nhcResult.status === 'rejected') console.log('[NHC]', nhcResult.reason?.message);
  if (hkoResult.status === 'rejected') console.log('[HKO]', hkoResult.reason?.message);

  // Uncapped TC list (see fetchGdacs): the general feed's 100-event cap must
  // not decide whether a western-Pacific storm exists.
  const westernPacificCandidates = gdacsCyclones.filter(isWesternPacificCyclone);
  const westernPacific = buildWesternPacificCycloneSnapshot({
    storms: westernPacificCandidates.map(toWesternPacificObservation),
    hkoWarnings: hko.warnings,
    hkoDataAvailable: hko.dataAvailable,
    sourceDecisions: [hko.sourceDecision],
    now,
  });
  // A healthy GDACS tropical-cyclone list is valid coverage even when no named
  // storm is active — the TC list specifically, since the other five types
  // say nothing about cyclones. HKO remains independently visible in its own
  // coverage snapshot.
  westernPacific.dataAvailable = hko.dataAvailable || gdacsTcCovered;
  const westernPacificSourceIds = new Set(westernPacificCandidates.map((event) => event.id));

  // NHC events take priority for storms (have forecast tracks/cones)
  // Dedup GDACS TC events against NHC by storm name proximity
  const nhcStorms = nhcEvents
    .filter(e => e.stormName)
    .map(e => ({ name: (e.stormName || '').toLowerCase(), lat: e.lat, lon: e.lon }));
  const seenLocations = new Set();
  const merged = [];

  // Add NHC storms first (highest quality data with tracks/cones)
  for (const event of nhcEvents) {
    const k = `${event.lat.toFixed(1)}-${event.lon.toFixed(1)}-${event.category}`;
    seenLocations.add(k);
    merged.push(event);
  }

  // Add GDACS events, skipping TC events that match NHC storms by name
  for (const event of gdacsEvents) {
    if (westernPacificSourceIds.has(event.id)) continue;
    if (event.category === 'severeStorms' && event.stormName) {
      const gName = event.stormName.toLowerCase();
      const isDupe = nhcStorms.some(n =>
        n.name === gName && Math.abs(n.lat - event.lat) < 10 && Math.abs(n.lon - event.lon) < 30
      );
      if (isDupe) continue;
    }
    const k = `${event.lat.toFixed(1)}-${event.lon.toFixed(1)}-${event.category}`;
    if (!seenLocations.has(k)) {
      seenLocations.add(k);
      merged.push(event);
    }
  }

  // Add EONET events
  for (const event of eonetEvents) {
    const k = `${event.lat.toFixed(1)}-${event.lon.toFixed(1)}-${event.category}`;
    if (!seenLocations.has(k)) {
      seenLocations.add(k);
      merged.push(event);
    }
  }

  // Canonical western-Pacific cyclones replace their raw GDACS members; HKO
  // local warning events deliberately remain visible even without a storm name.
  for (const event of westernPacific.events) {
    const k = `${event.lat.toFixed(1)}-${event.lon.toFixed(1)}-${event.category}-${event.id}`;
    if (!seenLocations.has(k)) {
      seenLocations.add(k);
      merged.push(event);
    }
  }

  const unsafePublication = (
    nhcResult.status === 'rejected' && nhcSnapshot.fetchedAt === null
  ) || (merged.length === 0 && (
    eonetResult.status === 'rejected'
      || !gdacsComplete
      || hko.dataAvailable !== true
      || nhcResult.status === 'rejected'
  ));
  if (unsafePublication && nhcResult.status === 'fulfilled') {
    throw Object.assign(new Error('Natural-event providers cannot prove complete empty coverage'), {
      nonRetryable: true,
    });
  }
  return {
    events: merged,
    westernPacific,
    hkoWarnings: {
      evaluatedAt: westernPacific.evaluatedAt,
      latestObservationAt: hko.warnings.reduce((latest, warning) => Math.max(latest, Number(warning.observedAt) || 0), 0) || now,
      dataAvailable: hko.dataAvailable,
      warnings: hko.warnings,
      sourceDecisions: [hko.sourceDecision],
    },
    _nhcSnapshot: nhcSnapshot,
    _nhcFailureDetail: nhcResult.status === 'rejected' ? nhcResult.reason?.message : null,
    _gdacsFailedTypes: gdacsFailedTypes,
    _unsafePublication: unsafePublication,
  };
}

function validate(data) {
  return Array.isArray(data?.events);
}

export function declareRecords(data) {
  return Array.isArray(data?.events) ? data.events.length : 0;
}

export function naturalEventsPublishTransform(data) {
  if (data._unsafePublication) return null;
  const { _nhcSnapshot, _nhcFailureDetail, _gdacsFailedTypes, _unsafePublication, ...publicData } = data;
  return publicData;
}

export function naturalEventsAfterPublish(data) {
  const snapshot = data?._nhcSnapshot;
  if (!snapshot || snapshot.consecutiveFailures === 0) {
    // NHC is whole; GDACS may not be. A run that published while one or more
    // GDACS type lists failed (or all of them — a rejected fetch) is serving
    // a feed it cannot vouch for, so it reports `degraded` rather than `ok`
    // and health surfaces the missing types instead of a clean badge. The
    // run still exits 0: the retained events are real, and the next tick
    // clears the state as soon as every list answers again.
    const failedTypes = Array.isArray(data?._gdacsFailedTypes) ? data._gdacsFailedTypes : [];
    if (failedTypes.length === 0) return { freshnessMetaPatch: { sourceState: 'ok' } };
    console.warn(`[GDACS] DEGRADED: type list(s) unavailable — ${failedTypes.join(', ')}`);
    return {
      completionState: 'DEGRADED',
      freshnessMetaPatch: {
        sourceState: 'degraded',
        errorCode: 'GDACS_TYPE_COVERAGE_INCOMPLETE',
        skipReason: 'gdacs-type-coverage-incomplete',
        failedSources: failedTypes.map((eventtype) => `gdacs:${eventtype}`),
        lastSourceAttemptAt: Date.now(),
      },
    };
  }
  console.warn(`[NHC] DEGRADED: ${data?._nhcFailureDetail || snapshot.errorCode}`);
  const patch = {
    sourceState: 'degraded',
    errorCode: snapshot.errorCode,
    skipReason: 'nhc-required-point-coverage-incomplete',
    lastSourceSuccessAt: snapshot.fetchedAt,
    lastSourceAttemptAt: snapshot.lastAttemptAt,
    firstSourceFailureAt: snapshot.firstFailureAt,
    consecutiveSourceFailures: snapshot.consecutiveFailures,
    lastSourceFailureCode: snapshot.errorCode,
  };
  // NHC and GDACS can degrade in the same run. The NHC failure codes carry a
  // pending grace in api/health.js (a retained storm set stays healthy for a
  // few consecutive misses), and that grace would hide a concurrently
  // incomplete GDACS feed behind a green badge. So when both degrade, the
  // meta reports the GDACS code — no policy grants it grace, so health warns
  // immediately — and keeps the NHC diagnostics alongside; once GDACS is whole
  // again the next run returns to the plain NHC patch and its grace.
  const gdacsFailedTypes = Array.isArray(data?._gdacsFailedTypes) ? data._gdacsFailedTypes : [];
  if (gdacsFailedTypes.length === 0) return { completionState: 'DEGRADED', freshnessMetaPatch: patch };
  console.warn(`[GDACS] DEGRADED: type list(s) unavailable — ${gdacsFailedTypes.join(', ')}`);
  return {
    completionState: 'DEGRADED',
    freshnessMetaPatch: {
      ...patch,
      errorCode: 'GDACS_TYPE_COVERAGE_INCOMPLETE',
      skipReason: 'gdacs-type-coverage-incomplete',
      failedSources: [...gdacsFailedTypes.map((eventtype) => `gdacs:${eventtype}`), 'nhc'],
      nhcErrorCode: snapshot.errorCode,
    },
  };
}

async function fetchNaturalEventsForSeed() {
  const previousNhcSnapshot = await readSeedSnapshot(NHC_SNAPSHOT_KEY, { strict: true });
  return fetchNaturalEvents({ previousNhcSnapshot });
}

export function runNaturalEventsSeed() {
  return runSeed('natural', 'events', CANONICAL_KEY, fetchNaturalEventsForSeed, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: 'eonet+gdacs+nhc+hko-v2',
    extraKeys: [
      {
        key: WESTERN_PACIFIC_CYCLONES_KEY,
        ttl: CACHE_TTL,
        transform: (data) => data.westernPacific,
        declareRecords: (snapshot) => snapshot?.dataAvailable ? 1 : 0,
        metaKey: 'seed-meta:natural:western-pacific-cyclones',
        metaTtlSeconds: CACHE_TTL,
        metaCritical: true,
        skipWhenEmpty: true,
      },
      {
        key: HKO_WARNINGS_KEY,
        ttl: CACHE_TTL,
        transform: (data) => data.hkoWarnings,
        declareRecords: (snapshot) => snapshot?.dataAvailable ? 1 : 0,
        metaKey: 'seed-meta:weather:hko-warnings',
        metaTtlSeconds: CACHE_TTL,
        metaCritical: true,
        skipWhenEmpty: true,
      },
    ],
    declareRecords,
    zeroIsValid: true,
    schemaVersion: 2,
    maxStaleMin: 540,
    publishTransform: naturalEventsPublishTransform,
    beforePublish: async (data) => {
      await writeExtraKey(NHC_SNAPSHOT_KEY, data._nhcSnapshot, CACHE_TTL);
    },
    afterPublish: naturalEventsAfterPublish,
    afterValidationSkip: async (data) => {
      await writeExtraKey(NHC_SNAPSHOT_KEY, data._nhcSnapshot, CACHE_TTL);
      return naturalEventsAfterPublish(data);
    },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runNaturalEventsSeed().catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
