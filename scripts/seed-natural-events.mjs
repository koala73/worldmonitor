#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, readCachedJson } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const EONET_API_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events';
const GDACS_API = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP';
const NHC_BASE = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';
const CANONICAL_KEY = 'natural:events:v1';
const CACHE_TTL = 21600; // 6h — comfortably longer than the hourly seed cron so a late run can't empty the feed

const DAYS = 365;
const WILDFIRE_MIN_ACRES = 1_000;

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

// Intentional controlled burns reported by agencies as "RX"/"Prescribed Fire"
// — not real wildfires, so they are excluded from the map.
function isPrescribedBurn(title) {
  const t = String(title || '').toLowerCase();
  return t.includes('prescribed') || t.startsWith('rx ') || t.includes(' rx ');
}

async function fetchEonet(days) {
  // status=all (not just open) so recently-closed storms, floods and volcanic
  // events within the last `days` window are still surfaced — most severe
  // events close within days, and open-only dropped almost all of them.
  const url = `${EONET_API_URL}?status=all&days=${days}`;
  // EONET (NASA) 503s intermittently — retry a few times so a transient blip
  // doesn't drop the whole EONET slice for the hour.
  let res = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000));
    res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) break;
  }
  if (!res || !res.ok) throw new Error(`EONET ${res?.status ?? 'no-response'}`);

  const data = await res.json();
  const events = [];

  for (const event of data.events || []) {
    const category = event.categories?.[0];
    if (!category) continue;
    const normalizedCategory = normalizeCategory(category.id);
    if (normalizedCategory === 'earthquakes') continue;

    const latestGeo = event.geometry?.[event.geometry.length - 1];
    if (!latestGeo || latestGeo.type !== 'Point') continue;

    const eventDate = new Date(latestGeo.date);
    const [lon, lat] = latestGeo.coordinates;

    let magnitude = latestGeo.magnitudeValue ?? 0;
    if (normalizedCategory === 'wildfires') {
      // Keep only major wildfires: peak burned area >= 7k acres, no controlled burns.
      if (isPrescribedBurn(event.title)) continue;
      magnitude = Math.max(0, ...event.geometry.map((g) => g.magnitudeValue ?? 0));
      if (magnitude < WILDFIRE_MIN_ACRES) continue;
    }

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
      magnitude,
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

async function fetchGdacs() {
  const res = await fetch(GDACS_API, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GDACS ${res.status}`);

  const data = await res.json();
  const features = data.features || [];
  const seen = new Set();
  const events = [];

  for (const f of features) {
    if (!f.geometry || f.geometry.type !== 'Point') continue;
    const props = f.properties;
    const key = `${props.eventtype}-${props.eventid}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Green-level alerts are kept (was previously dropped) so minor floods,
    // volcanic activity and storms still populate the map — denser coverage.
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

  return events.slice(0, 1000);
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

async function nhcQuery(layerId) {
  const url = `${NHC_BASE}/${layerId}/query?where=1%3D1&outFields=*&f=geojson`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return { type: 'FeatureCollection', features: [] };
  return res.json();
}

const NHC_STORM_TYPES = {
  HU: 'Hurricane', TS: 'Tropical Storm', TD: 'Tropical Depression',
  STS: 'Subtropical Storm', STD: 'Subtropical Depression',
  EX: 'Post-Tropical', PT: 'Post-Tropical',
};

async function fetchNhc() {
  // Query all forecast point layers to find active storms
  const pointQueries = NHC_STORM_SLOTS.map(s => nhcQuery(s.forecastPoints));
  const pointResults = await Promise.allSettled(pointQueries);

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
      nhcQuery(slot.forecastCone),
      nhcQuery(slot.pastPoints),
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
    if (!currentPt) continue;

    const p = currentPt.properties;
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
        pastTrack.push({
          lat: f.geometry.coordinates[1],
          lon: f.geometry.coordinates[0],
          windKt: f.properties.intensity ?? 0,
          timestamp: f.properties.dtg ?? 0,
        });
      }
    }

    const lat = currentPt.geometry.coordinates[1];
    const lon = currentPt.geometry.coordinates[0];
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    if (windKt < 0 || windKt > 200) continue;

    const pressureMb = p.mslp >= 850 && p.mslp <= 1050 ? p.mslp : undefined;
    const advDate = p.advdate ? new Date(p.advdate).getTime() : Date.now();

    events.push({
      id: stormId,
      title,
      description: `${title}, Max wind ${windKt} kt${pressureMb ? `, Pressure ${pressureMb} mb` : ''}`,
      category: 'severeStorms',
      categoryTitle: 'Tropical Cyclone',
      lat,
      lon,
      date: Number.isFinite(advDate) ? advDate : Date.now(),
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
    });
  }

  return events;
}

// Classify a cached event back to its source, by id prefix.
function eventSource(e) {
  const id = (e && e.id) || '';
  if (id.startsWith('nhc-')) return 'nhc';
  if (id.startsWith('gdacs-')) return 'gdacs';
  return 'eonet';
}

async function fetchNaturalEvents() {
  const [eonetResult, gdacsResult, nhcResult] = await Promise.allSettled([
    fetchEonet(DAYS),
    fetchGdacs(),
    fetchNhc(),
  ]);

  // null = that source's upstream failed this run → preserve its previous
  // cached slice instead of dropping it. EONET 503s and GDACS occasionally
  // hiccups; without this, one dead source full-replaces the whole feed with
  // the survivors (e.g. EONET down → all wildfires vanish).
  let eonetEvents = eonetResult.status === 'fulfilled' ? eonetResult.value : null;
  let gdacsEvents = gdacsResult.status === 'fulfilled' ? gdacsResult.value : null;
  let nhcEvents   = nhcResult.status === 'fulfilled' ? nhcResult.value : null;

  if (eonetResult.status === 'rejected') console.log('[EONET]', eonetResult.reason?.message);
  if (gdacsResult.status === 'rejected') console.log('[GDACS]', gdacsResult.reason?.message);
  if (nhcResult.status === 'rejected') console.log('[NHC]', nhcResult.reason?.message);

  if (eonetEvents === null || gdacsEvents === null || nhcEvents === null) {
    const existing = await readCachedJson(CANONICAL_KEY);
    const prev = Array.isArray(existing?.events) ? existing.events : [];
    const preserved = [];
    if (eonetEvents === null) { eonetEvents = prev.filter(e => eventSource(e) === 'eonet'); preserved.push(`eonet(${eonetEvents.length})`); }
    if (gdacsEvents === null) { gdacsEvents = prev.filter(e => eventSource(e) === 'gdacs'); preserved.push(`gdacs(${gdacsEvents.length})`); }
    if (nhcEvents === null)   { nhcEvents   = prev.filter(e => eventSource(e) === 'nhc');   preserved.push(`nhc(${nhcEvents.length})`); }
    console.log('[natural] preserved cached slices for failed sources:', preserved.join(', '));
  }
  eonetEvents = eonetEvents || [];
  gdacsEvents = gdacsEvents || [];
  nhcEvents = nhcEvents || [];

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

  if (merged.length === 0) return null;
  return { events: merged };
}

function validate(data) {
  return Array.isArray(data?.events);
}

runSeed('natural', 'events', CANONICAL_KEY, fetchNaturalEvents, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'eonet+gdacs+nhc',
}).catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
