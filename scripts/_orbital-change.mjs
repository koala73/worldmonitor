// Change scoring for watched land sites: radar statistics over each site's footprint,
// per acquisition geometry, folded into the site's one flag record. Pure except for the
// injected statistics fetch and archive search; the site seeder owns Redis.
import {
  advanceTrack,
  CHANGE_THRESHOLDS,
  FLAG_SCHEMA,
  FLAG_WORDING,
  geometryKey,
  MAX_FLAG_EVENTS,
  newTrack,
  siteFlagState,
} from './shared/orbital/flag-record.js';

/**
 * While shadowed, flag records live only under their own keys: site records and country
 * rollups carry no flag. The shadow ends after a reviewed shadow period, not by default.
 */
export const CHANGE_SHADOW = true;
export const ORBITAL_FLAG_SHADOW_KEY_PREFIX = 'orbital:flag-shadow:v1:';
export const flagShadowKey = (siteId) => `${ORBITAL_FLAG_SHADOW_KEY_PREFIX}${siteId}`;

export const RADAR_COLLECTION = 'sentinel-1-grd';
export const STATISTICS_URL = 'https://planetarycomputer.microsoft.com/api/data/v1/item/statistics';
export const STAC_RADAR_FIELDS = ['properties.sat:relative_orbit', 'properties.sat:orbit_state', 'properties.sar:instrument_mode', 'properties.sar:polarizations'];
/** About 2 km on a side: one site's ground, small enough that a local change moves the median. */
export const FOOTPRINT_HALF_SIZE_DEG = 0.01;
/** A scene with fewer valid pixels than this over the footprint is no observation. */
export const MIN_VALID_PERCENT = 90;
export const BACKFILL_DAYS = 120;
/** A geometry with no scene for this long is dropped; its orbit is no longer flown over the site. */
export const TRACK_IDLE_DAYS = 180;

const DAY_MS = 86_400_000;
const STATISTICS = { median: 'median', p98: 'percentile_98' };

/** The geometry facts of a Sentinel-1 STAC item, or null when any is missing. */
export function radarGeometry(properties) {
  const relativeOrbit = properties?.['sat:relative_orbit'];
  const orbitState = properties?.['sat:orbit_state'];
  const mode = properties?.['sar:instrument_mode'];
  const polarizations = properties?.['sar:polarizations'];
  if (!Number.isInteger(relativeOrbit) || !['ascending', 'descending'].includes(orbitState)) return null;
  if (typeof mode !== 'string' || !Array.isArray(polarizations) || polarizations.length === 0) return null;
  return { constellation: 'sentinel-1', relativeOrbit, orbitState, mode, polarizations: [...polarizations].sort() };
}

export function footprintFeature({ lat, lon }, halfSizeDeg = FOOTPRINT_HALF_SIZE_DEG) {
  const halfLon = halfSizeDeg / Math.cos((lat * Math.PI) / 180);
  const ring = [[lon - halfLon, lat - halfSizeDeg], [lon + halfLon, lat - halfSizeDeg], [lon + halfLon, lat + halfSizeDeg], [lon - halfLon, lat + halfSizeDeg], [lon - halfLon, lat - halfSizeDeg]];
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

export function statisticsUrl(scene) {
  const assets = scene.radar.polarizations.map((pol) => `assets=${pol.toLowerCase()}`).join('&');
  return `${STATISTICS_URL}?collection=${RADAR_COLLECTION}&item=${encodeURIComponent(scene.itemId)}&${assets}`;
}

/**
 * Radar statistics of one scene as decibels, or null when the scene is no observation.
 * Ground-range amplitude converts with 20·log10. A band whose statistic is missing, not
 * finite or not positive is left out rather than read as zero.
 */
export function observationFromStatistics(scene, statistics, minValidPercent = MIN_VALID_PERCENT) {
  const values = {};
  for (const pol of scene.radar.polarizations) {
    const band = statistics?.[`${pol.toLowerCase()}_b1`];
    if (!band || !(band.valid_percent >= minValidPercent)) continue;
    for (const [name, field] of Object.entries(STATISTICS)) {
      const amplitude = band[field];
      if (Number.isFinite(amplitude) && amplitude > 0) values[`${pol.toLowerCase()}_${name}`] = Math.round(2000 * Math.log10(amplitude)) / 100;
    }
  }
  if (Object.keys(values).length === 0) return null;
  return { itemId: scene.itemId, datetime: scene.datetime, platform: scene.platform, values };
}

export function backfillSearchBody(site, nowMs, lookbackDays) {
  return {
    collections: [RADAR_COLLECTION],
    intersects: { type: 'Point', coordinates: [site.lon, site.lat] },
    datetime: `${new Date(nowMs - BACKFILL_DAYS * DAY_MS).toISOString()}/${new Date(nowMs - lookbackDays * DAY_MS).toISOString()}`,
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
    limit: 100,
    fields: {
      include: ['id', 'collection', 'properties.datetime', 'properties.platform', ...STAC_RADAR_FIELDS],
      exclude: ['assets', 'links', 'geometry', 'bbox'],
    },
  };
}

/** Radar scenes oldest first, per geometry at most `perGeometry` of the newest. */
export function radarScenes(acquisitions, perGeometry = Infinity) {
  const byGeometry = new Map();
  for (const acquisition of acquisitions) {
    if (!acquisition.radar) continue;
    const key = geometryKey(acquisition.radar);
    byGeometry.set(key, [...(byGeometry.get(key) ?? []), acquisition]);
  }
  return [...byGeometry.values()]
    .flatMap((scenes) => scenes.sort((a, b) => b.datetime.localeCompare(a.datetime)).slice(0, perGeometry))
    .sort((a, b) => a.datetime.localeCompare(b.datetime) || a.itemId.localeCompare(b.itemId));
}

function emptyFlag(site, halfSizeDeg) {
  return {
    schema: FLAG_SCHEMA,
    siteId: site.id,
    wording: FLAG_WORDING,
    footprint: { lat: site.lat, lon: site.lon, halfSizeDeg },
    state: 'baseline-building',
    tracks: {},
    events: [],
    backfilledAt: null,
    updatedAt: null,
  };
}

const sameFootprint = (a, b) => a?.lat === b.lat && a?.lon === b.lon && a?.halfSizeDeg === b.halfSizeDeg;

/** The statistics request refused service: scoring stops for the rest of the run. */
export class StatisticsRefusal extends Error {}

/**
 * Folds every radar scene the flag has not yet seen into the site's flag record. A site
 * that has never been backfilled first reads enough archived scenes per geometry to build
 * its baselines. Scoring stops at the deadline or the first failed archive request;
 * what was folded before that is kept, and the rest is read next run.
 */
export async function scoreSiteChange({
  site, acquisitions, previous, fetchStatistics, searchBackfill = null, nowMs, deadlineMs, clock = Date.now,
  thresholds, halfSizeDeg = FOOTPRINT_HALF_SIZE_DEG,
}) {
  if (site.surface !== 'land') return { flag: null, requests: 0, stopped: null };
  const footprint = { lat: site.lat, lon: site.lon, halfSizeDeg };
  const flag = previous && previous.schema === FLAG_SCHEMA && sameFootprint(previous.footprint, footprint)
    ? structuredClone(previous)
    : { ...emptyFlag(site, halfSizeDeg), events: previous?.events ?? [] };

  let scenes = radarScenes(acquisitions);
  let stopped = null;
  let backfilling = flag.backfilledAt === null && searchBackfill !== null;
  if (backfilling) {
    try {
      const archived = await searchBackfill(site, nowMs);
      scenes = [...radarScenes(archived, (thresholds ?? CHANGE_THRESHOLDS).minBaselineScenes), ...scenes];
    } catch (error) {
      backfilling = false;
      stopped = error?.message || String(error);
    }
  }

  const feature = footprintFeature(site, halfSizeDeg);
  let requests = 0;
  for (const scene of stopped === null ? scenes : []) {
    const key = geometryKey(scene.radar);
    const track = flag.tracks[key] ?? newTrack(scene.radar);
    if (track.lastDatetime !== null && scene.datetime <= track.lastDatetime) continue;
    if (clock() >= deadlineMs) {
      stopped = 'deadline';
      break;
    }
    let statistics;
    try {
      requests += 1;
      statistics = await fetchStatistics(scene, feature);
    } catch (error) {
      if (error instanceof StatisticsRefusal) throw error;
      stopped = error?.message || String(error);
      break;
    }
    const observation = observationFromStatistics(scene, statistics);
    if (!observation) {
      flag.tracks[key] = { ...track, lastDatetime: scene.datetime };
      continue;
    }
    const next = advanceTrack(track, observation, thresholds);
    flag.tracks[key] = next.track;
    if (next.event) flag.events = [...flag.events, next.event].slice(-MAX_FLAG_EVENTS);
  }
  if (backfilling && stopped === null) flag.backfilledAt = nowMs;
  for (const [key, track] of Object.entries(flag.tracks)) {
    if (track.lastDatetime && nowMs - Date.parse(track.lastDatetime) > TRACK_IDLE_DAYS * DAY_MS) delete flag.tracks[key];
  }
  flag.state = siteFlagState(flag.tracks);
  flag.updatedAt = nowMs;
  return { flag, requests, stopped };
}

/**
 * The per-run change stage the site seeder calls once per evaluated site. It owns the
 * stage's own time budget, so scoring never starves the site pass, and stops scoring for
 * the rest of the run after a refusal. A site it cannot score keeps its previous flag.
 */
export function makeChangeStage({ fetchStatistics, searchBackfill = null, budgetMs, shadow = CHANGE_SHADOW, previousFlags = new Map(), clock = Date.now, thresholds }) {
  let deadlineMs = null;
  let halted = null;
  let scoredSites = 0;
  let requests = 0;
  return {
    shadow,
    previousFlags,
    async score({ site, acquisitions, previous, nowMs }) {
      if (site.surface !== 'land') return null;
      deadlineMs ??= clock() + budgetMs;
      if (halted || clock() >= deadlineMs) return previous;
      try {
        const result = await scoreSiteChange({ site, acquisitions, previous, fetchStatistics, searchBackfill, nowMs, deadlineMs, clock, thresholds });
        requests += result.requests;
        scoredSites += 1;
        return result.flag;
      } catch (error) {
        halted = error?.message || String(error);
        return previous;
      }
    },
    summary: () => ({ shadow, scoredSites, statisticsRequests: requests, halted }),
  };
}
