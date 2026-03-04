#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const EONET_API_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events';
const GDACS_API = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP';
const CANONICAL_KEY = 'natural:events:v1';
const CACHE_TTL = 3600; // 1 hour

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

async function fetchEonet(days) {
  const url = `${EONET_API_URL}?status=open&days=${days}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`EONET ${res.status}`);

  const data = await res.json();
  const events = [];
  const now = Date.now();

  for (const event of data.events || []) {
    const category = event.categories?.[0];
    if (!category) continue;
    if (category.id === 'earthquakes') continue;

    const latestGeo = event.geometry?.[event.geometry.length - 1];
    if (!latestGeo || latestGeo.type !== 'Point') continue;

    const eventDate = new Date(latestGeo.date);
    const [lon, lat] = latestGeo.coordinates;

    if (category.id === 'wildfires' && now - eventDate.getTime() > WILDFIRE_MAX_AGE_MS) continue;

    const source = event.sources?.[0];
    events.push({
      id: event.id || '',
      title: event.title || '',
      description: event.description || '',
      category: category.id || '',
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

    if (props.alertlevel === 'Green') continue;

    const category = GDACS_TO_CATEGORY[props.eventtype] || 'manmade';
    const alertPrefix = props.alertlevel === 'Red' ? '\u{1F534} ' : props.alertlevel === 'Orange' ? '\u{1F7E0} ' : '';
    const description = props.description || EVENT_TYPE_NAMES[props.eventtype] || props.eventtype;
    const severity = props.severitydata?.severitytext || '';

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
    });
  }

  return events.slice(0, 100);
}

async function fetchNaturalEvents() {
  const [eonetResult, gdacsResult] = await Promise.allSettled([
    fetchEonet(DAYS),
    fetchGdacs(),
  ]);

  const eonetEvents = eonetResult.status === 'fulfilled' ? eonetResult.value : [];
  const gdacsEvents = gdacsResult.status === 'fulfilled' ? gdacsResult.value : [];

  if (eonetResult.status === 'rejected') console.error('[EONET]', eonetResult.reason?.message);
  if (gdacsResult.status === 'rejected') console.error('[GDACS]', gdacsResult.reason?.message);

  const seenLocations = new Set();
  const merged = [];

  for (const event of gdacsEvents) {
    const k = `${event.lat.toFixed(1)}-${event.lon.toFixed(1)}-${event.category}`;
    if (!seenLocations.has(k)) {
      seenLocations.add(k);
      merged.push(event);
    }
  }
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
  return Array.isArray(data?.events) && data.events.length >= 1;
}

runSeed('natural', 'events', CANONICAL_KEY, fetchNaturalEvents, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'eonet+gdacs',
}).catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
