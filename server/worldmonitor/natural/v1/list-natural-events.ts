import type {
  NaturalServiceHandler,
  ServerContext,
  ListNaturalEventsRequest,
  ListNaturalEventsResponse,
  NaturalEvent,
} from '../../../../src/generated/server/worldmonitor/natural/v1/service_server';

import { CHROME_UA } from '../../../_shared/constants';
import { cachedFetchJson, getCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'natural:events:v1';
const REDIS_CACHE_TTL = 1800; // 30 min
const SEED_FRESHNESS_MS = 45 * 60 * 1000; // 45 minutes

const EONET_API_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events';
const GDACS_API = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP';
const NHC_BASE = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';

const DAYS = 30;
const WILDFIRE_MAX_AGE_MS = 48 * 60 * 60 * 1000;

const GDACS_TO_CATEGORY: Record<string, string> = {
  EQ: 'earthquakes',
  FL: 'floods',
  TC: 'severeStorms',
  VO: 'volcanoes',
  WF: 'wildfires',
  DR: 'drought',
};

const NATURAL_EVENT_CATEGORIES = new Set([
  'severeStorms',
  'wildfires',
  'volcanoes',
  'earthquakes',
  'floods',
  'landslides',
  'drought',
  'dustHaze',
  'snow',
  'tempExtremes',
  'seaLakeIce',
  'waterColor',
  'manmade',
]);

const EVENT_TYPE_NAMES: Record<string, string> = {
  EQ: 'Earthquake',
  FL: 'Flood',
  TC: 'Tropical Cyclone',
  VO: 'Volcano',
  WF: 'Wildfire',
  DR: 'Drought',
};

function normalizeNaturalCategory(value: unknown): string {
  const category = String(value || '').trim();
  return NATURAL_EVENT_CATEGORIES.has(category) ? category : 'manmade';
}

interface TcFields {
  stormId?: string;
  stormName?: string;
  basin?: string;
  stormCategory?: number;
  classification?: string;
  windKt?: number;
  pressureMb?: number;
  movementDir?: number;
  movementSpeedKt?: number;
}

function classifyWind(kt: number): { category: number; classification: string } {
  if (kt >= 137) return { category: 5, classification: 'Category 5' };
  if (kt >= 113) return { category: 4, classification: 'Category 4' };
  if (kt >= 96) return { category: 3, classification: 'Category 3' };
  if (kt >= 83) return { category: 2, classification: 'Category 2' };
  if (kt >= 64) return { category: 1, classification: 'Category 1' };
  if (kt >= 34) return { category: 0, classification: 'Tropical Storm' };
  return { category: 0, classification: 'Tropical Depression' };
}

function parseGdacsTcFields(props: any): TcFields {
  const fields: TcFields = {};
  fields.stormId = `gdacs-TC-${props.eventid}`;

  const name = String(props.name || '');
  const nameMatch = name.match(/(?:Hurricane|Typhoon|Cyclone|Storm|Depression)\s+(.+)/i);
  fields.stormName = nameMatch ? nameMatch[1]!.trim() : name.trim() || undefined;

  const desc = String(props.description || '') + ' ' + String(props.severitydata?.severitytext || '');

  const windPatterns = [
    /(\d+(?:\.\d+)?)\s*(?:kn(?:ots?)?|kt)/i,
    /(\d+(?:\.\d+)?)\s*mph/i,
    /(\d+(?:\.\d+)?)\s*km\/?h/i,
  ];
  for (const [i, pat] of windPatterns.entries()) {
    const m = desc.match(pat);
    if (m) {
      let val = parseFloat(m[1]!);
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
    const p = parseInt(pressureMatch[1]!, 10);
    if (p >= 850 && p <= 1050) fields.pressureMb = p;
  }

  return fields;
}

async function fetchEonet(days: number): Promise<NaturalEvent[]> {
  const url = `${EONET_API_URL}?status=open&days=${days}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`EONET ${res.status}`);

  const data: any = await res.json();
  const events: NaturalEvent[] = [];
  const now = Date.now();

  for (const event of data.events || []) {
    const category = event.categories?.[0];
    if (!category) continue;
    const normalizedCategory = normalizeNaturalCategory(category.id);
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
      forecastTrack: [],
      conePolygon: [],
      pastTrack: [],
    });
  }

  return events;
}

async function fetchGdacs(): Promise<NaturalEvent[]> {
  const res = await fetch(GDACS_API, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GDACS ${res.status}`);

  const data: any = await res.json();
  const features: any[] = data.features || [];
  const seen = new Set<string>();
  const events: NaturalEvent[] = [];

  for (const f of features) {
    if (!f.geometry || f.geometry.type !== 'Point') continue;
    const props = f.properties;
    const key = `${props.eventtype}-${props.eventid}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (props.alertlevel === 'Green') continue;

    const category = normalizeNaturalCategory(GDACS_TO_CATEGORY[props.eventtype] || 'manmade');
    const alertPrefix = props.alertlevel === 'Red' ? '🔴 ' : props.alertlevel === 'Orange' ? '🟠 ' : '';
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

  return events.slice(0, 100);
}

// NHC ArcGIS storm slot layer IDs
const NHC_STORM_SLOTS: { basin: string; forecastPoints: number; forecastTrack: number; forecastCone: number; pastPoints: number; pastTrack: number }[] = [];
const BASIN_OFFSETS: Record<string, number> = { AT: 4, EP: 134, CP: 264 };
const BASIN_CODES: Record<string, string> = { AT: 'AL', EP: 'EP', CP: 'CP' };
for (const [prefix, base] of Object.entries(BASIN_OFFSETS)) {
  for (let i = 0; i < 5; i++) {
    const offset = base + i * 26;
    NHC_STORM_SLOTS.push({
      basin: BASIN_CODES[prefix]!,
      forecastPoints: offset + 2,
      forecastTrack: offset + 3,
      forecastCone: offset + 4,
      pastPoints: offset + 7,
      pastTrack: offset + 8,
    });
  }
}

async function nhcQuery(layerId: number): Promise<any> {
  const url = `${NHC_BASE}/${layerId}/query?where=1%3D1&outFields=*&f=geojson`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return { type: 'FeatureCollection', features: [] };
  return res.json();
}

const NHC_STORM_TYPES: Record<string, string> = {
  HU: 'Hurricane', TS: 'Tropical Storm', TD: 'Tropical Depression',
  STS: 'Subtropical Storm', STD: 'Subtropical Depression',
  EX: 'Post-Tropical', PT: 'Post-Tropical',
};

async function fetchNhc(): Promise<NaturalEvent[]> {
  const pointQueries = NHC_STORM_SLOTS.map(s => nhcQuery(s.forecastPoints));
  const pointResults = await Promise.allSettled(pointQueries);

  const activeSlots: { slot: typeof NHC_STORM_SLOTS[number]; points: any }[] = [];
  for (let i = 0; i < NHC_STORM_SLOTS.length; i++) {
    const r = pointResults[i]!;
    if (r.status === 'fulfilled' && r.value.features?.length > 0) {
      activeSlots.push({ slot: NHC_STORM_SLOTS[i]!, points: r.value });
    }
  }

  if (activeSlots.length === 0) return [];

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

  const events: NaturalEvent[] = [];
  for (const { slot, points, cone, pastPts } of stormData) {
    const currentPt = points.features.find((f: any) => f.properties?.tau === 0 || f.properties?.fcstprd === 0);
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

    const forecastTrack = points.features
      .filter((f: any) => f.properties?.tau > 0 || f.properties?.fcstprd > 0)
      .sort((a: any, b: any) => (a.properties.tau || a.properties.fcstprd) - (b.properties.tau || b.properties.fcstprd))
      .map((f: any) => ({
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0],
        hour: f.properties.tau || f.properties.fcstprd || 0,
        windKt: f.properties.maxwind || 0,
        category: f.properties.ssnum || 0,
      }));

    const conePolygon: { points: { lon: number; lat: number }[] }[] = [];
    if (cone?.features?.length > 0) {
      for (const f of cone.features) {
        const rings: number[][][] =
          f.geometry?.type === 'Polygon' ? f.geometry.coordinates || [] :
          f.geometry?.type === 'MultiPolygon' ? (f.geometry.coordinates || []).flat() :
          [];
        for (const ring of rings) {
          conePolygon.push({ points: ring.map((coord: number[]) => ({ lon: coord[0] ?? 0, lat: coord[1] ?? 0 })) });
        }
      }
    }

    const pastTrack: any[] = [];
    if (pastPts?.features?.length > 0) {
      const sorted = pastPts.features
        .filter((f: any) => f.geometry?.coordinates)
        .sort((a: any, b: any) => (a.properties.dtg || 0) - (b.properties.dtg || 0));
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
      sourceUrl: 'https://www.nhc.noaa.gov/',
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

type NaturalEventsCache = { events: ListNaturalEventsResponse['events'] };

async function trySeededData(): Promise<NaturalEventsCache | null> {
  try {
    const [seedData, seedMeta] = await Promise.all([
      getCachedJson(REDIS_CACHE_KEY, true) as Promise<NaturalEventsCache | null>,
      getCachedJson('seed-meta:natural:events', true) as Promise<{ fetchedAt?: number } | null>,
    ]);

    if (!seedData?.events?.length) return null;

    const fetchedAt = seedMeta?.fetchedAt ?? 0;
    const isFresh = Date.now() - fetchedAt < SEED_FRESHNESS_MS;

    if (isFresh) return seedData;

    if (!process.env.SEED_FALLBACK_NATURAL) return seedData;

    return null;
  } catch {
    return null;
  }
}

export const listNaturalEvents: NaturalServiceHandler['listNaturalEvents'] = async (
  _ctx: ServerContext,
  _req: ListNaturalEventsRequest,
): Promise<ListNaturalEventsResponse> => {

  try {
    const seeded = await trySeededData();
    if (seeded) {
      return { events: seeded.events };
    }

    const result = await cachedFetchJson<ListNaturalEventsResponse>(
      REDIS_CACHE_KEY,
      REDIS_CACHE_TTL,
      async () => {
        const [eonetResult, gdacsResult, nhcResult] = await Promise.allSettled([
          fetchEonet(DAYS),
          fetchGdacs(),
          fetchNhc(),
        ]);

        const eonetEvents = eonetResult.status === 'fulfilled' ? eonetResult.value : [];
        const gdacsEvents = gdacsResult.status === 'fulfilled' ? gdacsResult.value : [];
        const nhcEvents = nhcResult.status === 'fulfilled' ? nhcResult.value : [];

        if (eonetResult.status === 'rejected') console.error('[EONET]', eonetResult.reason?.message);
        if (gdacsResult.status === 'rejected') console.error('[GDACS]', gdacsResult.reason?.message);
        if (nhcResult.status === 'rejected') console.error('[NHC]', nhcResult.reason?.message);

        const nhcStorms = nhcEvents
          .filter(e => e.stormName)
          .map(e => ({ name: (e.stormName || '').toLowerCase(), lat: e.lat, lon: e.lon }));
        const seenLocations = new Set<string>();
        const merged: NaturalEvent[] = [];

        for (const event of nhcEvents) {
          const k = `${event.lat.toFixed(1)}-${event.lon.toFixed(1)}-${event.category}`;
          seenLocations.add(k);
          merged.push(event);
        }
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
        for (const event of eonetEvents) {
          const k = `${event.lat.toFixed(1)}-${event.lon.toFixed(1)}-${event.category}`;
          if (!seenLocations.has(k)) {
            seenLocations.add(k);
            merged.push(event);
          }
        }

        return merged.length > 0 ? { events: merged } : null;
      },
    );
    return result || { events: [] };
  } catch {
    return { events: [] };
  }
};
