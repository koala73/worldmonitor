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

/** A scene whose statistics request fails this many runs in a row is skipped and counted. */
export const MAX_SCENE_ATTEMPTS = 3;
/** Sites scored at once; the statistics fetch's own throttle still bounds the request rate. */
export const CHANGE_CONCURRENCY = 4;
/** A land site whose footprint is more than this share permanent water is a water point, not land. */
export const WATER_SITE_PERCENT = 50;
/**
 * R26 (#10615): the shadow may end only after this many days of shadow scoring and this many
 * raised flags resolved (confirmed or retracted), with fewer than this share retracted. The
 * hand review of confirmed flags (environmental share) is not computable and stays manual.
 */
export const SHADOW_EXIT_RULE = Object.freeze({ minDays: 30, minResolvedFlags: 30, maxRetractedShare: 0.1 });

const DAY_MS = 86_400_000;
const STATISTICS = { median: 'median', p98: 'percentile_98' };

/** Scoring must stop for the rest of the run: nothing more is requested, and what was folded is kept. */
export class ScoringHalt extends Error {}
/** The archive refused a request made for scoring. */
export class ScoringRefusal extends ScoringHalt {}
/** The statistics service answered in a shape the scorer does not know, so no scene can be read as no observation. */
export class UnexpectedStatistics extends ScoringHalt {}

/**
 * The statistics of one scene, or an UnexpectedStatistics error when the response lacks a
 * band the scene was requested with. A band that is present but has too few valid pixels is a
 * real answer (no observation); a band that is missing or renamed is not.
 */
export function checkStatistics(scene, statistics) {
  if (!statistics || typeof statistics !== 'object' || Array.isArray(statistics)) {
    throw new UnexpectedStatistics(`statistics for ${scene.itemId} are missing from the response`);
  }
  for (const pol of scene.radar.polarizations) {
    const key = `${pol.toLowerCase()}_b1`;
    const band = statistics[key];
    if (!band || typeof band !== 'object' || typeof band.valid_percent !== 'number') {
      throw new UnexpectedStatistics(`statistics for ${scene.itemId} have no ${key} band with valid_percent (bands: ${Object.keys(statistics).join(', ') || 'none'})`);
    }
    if (band.valid_percent >= MIN_VALID_PERCENT && Object.values(STATISTICS).some((field) => !(field in band))) {
      throw new UnexpectedStatistics(`statistics for ${scene.itemId} band ${key} lack ${Object.values(STATISTICS).filter((field) => !(field in band)).join(', ')}`);
    }
  }
  return statistics;
}

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
    counts: emptyCounts(),
    sceneFailures: {},
    unfinished: false,
    backfilledAt: null,
    updatedAt: null,
  };
}

const emptyCounts = () => ({ raised: 0, confirmed: 0, retracted: 0, skippedScenes: 0 });
const sameFootprint = (a, b) => a?.lat === b.lat && a?.lon === b.lon && a?.halfSizeDeg === b.halfSizeDeg;
const errorText = (error) => error?.message || String(error);

/**
 * Folds every radar scene the flag has not yet seen into the site's flag record. A site
 * that has never been backfilled first reads enough archived scenes per geometry to build
 * its baselines. Scoring stops at the deadline, at a failed statistics request, or at a halt
 * (refusal or unknown response shape); what was folded before that is kept and the rest is
 * read next run. A scene that fails `maxSceneAttempts` runs in a row is skipped and counted,
 * so one bad scene cannot hold its site back for good.
 */
export async function scoreSiteChange({
  site, acquisitions, previous, fetchStatistics, searchBackfill = null, nowMs, deadlineMs, clock = Date.now,
  thresholds, halfSizeDeg = FOOTPRINT_HALF_SIZE_DEG, maxEvents = MAX_FLAG_EVENTS, maxSceneAttempts = MAX_SCENE_ATTEMPTS,
  stopRequested = () => false,
}) {
  if (site.surface !== 'land') return { flag: null, requests: 0, stopped: null, halted: null, haltKind: null, skippedScenes: 0 };
  const footprint = { lat: site.lat, lon: site.lon, halfSizeDeg };
  const flag = previous && previous.schema === FLAG_SCHEMA && sameFootprint(previous.footprint, footprint)
    ? structuredClone(previous)
    : { ...emptyFlag(site, halfSizeDeg), events: previous?.events ?? [], counts: { ...emptyCounts(), ...previous?.counts } };
  flag.counts = { ...emptyCounts(), ...flag.counts };
  flag.sceneFailures = { ...flag.sceneFailures };

  let scenes = radarScenes(acquisitions);
  let stopped = null;
  let halted = null;
  const haltKindOf = (error) => (error instanceof ScoringRefusal ? 'refusal' : 'unexpected-response');
  let haltKind = null;
  let backfilling = flag.backfilledAt === null && searchBackfill !== null;
  if (backfilling) {
    try {
      const archived = await searchBackfill(site, nowMs);
      scenes = [...radarScenes(archived, (thresholds ?? CHANGE_THRESHOLDS).minBaselineScenes), ...scenes];
    } catch (error) {
      backfilling = false;
      stopped = errorText(error);
      if (error instanceof ScoringHalt) {
        halted = stopped;
        haltKind = haltKindOf(error);
      }
    }
  }

  const feature = footprintFeature(site, halfSizeDeg);
  let requests = 0;
  let skippedScenes = 0;
  for (const scene of stopped === null ? scenes : []) {
    const key = geometryKey(scene.radar);
    const track = flag.tracks[key] ?? newTrack(scene.radar);
    if (track.lastDatetime !== null && scene.datetime <= track.lastDatetime) continue;
    if (clock() >= deadlineMs) {
      stopped = 'deadline';
      break;
    }
    // Another site's scoring halted the stage (refusal or unknown response): request nothing more.
    if (stopRequested()) {
      stopped = 'scoring halted';
      break;
    }
    let statistics;
    try {
      requests += 1;
      statistics = await fetchStatistics(scene, feature);
    } catch (error) {
      stopped = errorText(error);
      if (error instanceof ScoringHalt) {
        halted = stopped;
        haltKind = haltKindOf(error);
        break;
      }
      const attempts = (flag.sceneFailures[scene.itemId] ?? 0) + 1;
      if (attempts < maxSceneAttempts) {
        flag.sceneFailures[scene.itemId] = attempts;
        break;
      }
      delete flag.sceneFailures[scene.itemId];
      flag.tracks[key] = { ...track, lastDatetime: scene.datetime };
      flag.counts.skippedScenes += 1;
      skippedScenes += 1;
      stopped = null;
      continue;
    }
    delete flag.sceneFailures[scene.itemId];
    const observation = observationFromStatistics(scene, statistics);
    if (!observation) {
      flag.tracks[key] = { ...track, lastDatetime: scene.datetime };
      continue;
    }
    const next = advanceTrack(track, observation, thresholds);
    flag.tracks[key] = next.track;
    if (next.event) {
      flag.events = [...flag.events, next.event].slice(-maxEvents);
      flag.counts[next.event.kind] += 1;
    }
  }
  if (backfilling && stopped === null) flag.backfilledAt = nowMs;
  const pending = new Set(scenes.map((scene) => scene.itemId));
  flag.sceneFailures = Object.fromEntries(Object.entries(flag.sceneFailures).filter(([itemId]) => pending.has(itemId)));
  for (const [key, track] of Object.entries(flag.tracks)) {
    if (track.lastDatetime && nowMs - Date.parse(track.lastDatetime) > TRACK_IDLE_DAYS * DAY_MS) delete flag.tracks[key];
  }
  flag.state = siteFlagState(flag.tracks);
  flag.unfinished = stopped !== null;
  flag.updatedAt = nowMs;
  return { flag, requests, stopped, halted, haltKind, skippedScenes };
}

/**
 * Sites left out of change scoring, with the reason: water points (footprint mostly
 * permanent water, from the measured `waterPercent` table) and every site but one of a
 * group whose footprints overlap, so the same pixels are not scored twice. The site kept
 * from a group is the one with the most origins, then the first by id.
 */
export function changeScoringExclusions(sites, waterPercent = {}, halfSizeDeg = FOOTPRINT_HALF_SIZE_DEG) {
  const excluded = new Map();
  const land = [];
  for (const site of [...sites].sort((a, b) => a.id.localeCompare(b.id))) {
    if (site.surface !== 'land') continue;
    if ((waterPercent[site.id] ?? 0) > WATER_SITE_PERCENT) excluded.set(site.id, 'water');
    else land.push(site);
  }
  const parent = land.map((_, i) => i);
  const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  for (let i = 0; i < land.length; i += 1) {
    for (let j = i + 1; j < land.length; j += 1) {
      const a = land[i];
      const b = land[j];
      const halfLon = halfSizeDeg / Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
      if (Math.abs(a.lat - b.lat) < 2 * halfSizeDeg && Math.abs(a.lon - b.lon) < 2 * halfLon) parent[root(j)] = root(i);
    }
  }
  const groups = new Map();
  land.forEach((site, i) => groups.set(root(i), [...(groups.get(root(i)) ?? []), site]));
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [kept] = [...group].sort((a, b) => (b.origins?.length ?? 0) - (a.origins?.length ?? 0) || a.id.localeCompare(b.id));
    for (const site of group) if (site !== kept) excluded.set(site.id, `duplicate of ${kept.id}`);
  }
  return excluded;
}

/**
 * Where the R26 shadow-exit rule stands over every shadow flag record. `ready` means the
 * mechanical rule is met; the shadow still ends only by a reviewed change to CHANGE_SHADOW.
 */
export function shadowExitStatus({ shadowSince, flags, nowMs, rule = SHADOW_EXIT_RULE }) {
  let confirmed = 0;
  let retracted = 0;
  for (const flag of flags) {
    confirmed += flag?.counts?.confirmed ?? 0;
    retracted += flag?.counts?.retracted ?? 0;
  }
  const resolved = confirmed + retracted;
  const days = Math.max(0, Math.floor((nowMs - shadowSince) / DAY_MS));
  const retractedShare = resolved ? Math.round((1000 * retracted) / resolved) / 1000 : null;
  const blockers = [];
  if (days < rule.minDays) blockers.push(`${days} of ${rule.minDays} shadow days`);
  if (resolved < rule.minResolvedFlags) blockers.push(`${resolved} of ${rule.minResolvedFlags} resolved flags`);
  if (resolved > 0 && retracted / resolved >= rule.maxRetractedShare) blockers.push(`retracted share ${retractedShare} is not under ${rule.maxRetractedShare}`);
  return { shadowSince, days, confirmed, retracted, resolved, retractedShare, ready: blockers.length === 0, blockers };
}

/** The flag a site's scoring continues from: the newer of its live flag and its shadow flag, so leaving shadow keeps the shadow period's state. */
export function continuedFlag(liveFlag, shadowFlag) {
  if (!liveFlag) return shadowFlag ?? null;
  if (!shadowFlag) return liveFlag;
  return (shadowFlag.updatedAt ?? 0) > (liveFlag.updatedAt ?? 0) ? shadowFlag : liveFlag;
}

/**
 * The per-run change stage the site seeder calls once per evaluated site. It stops at its
 * deadline (`deadlineMs`, or `budgetMs` from its first site), skips excluded sites, and stops
 * scoring for the rest of the run after a halt while keeping what the halted site had folded.
 * A site it cannot score keeps its previous flag.
 */
export function makeChangeStage({
  fetchStatistics, searchBackfill = null, budgetMs, deadlineMs: fixedDeadlineMs = null, shadow = CHANGE_SHADOW,
  previousFlags = new Map(), exclusions = new Map(), clock = Date.now, thresholds, concurrency = 1,
}) {
  let deadlineMs = fixedDeadlineMs;
  let halted = null;
  let haltKind = null;
  const halt = (reason, kind) => {
    if (halted) return;
    halted = reason;
    haltKind = kind;
  };
  let scoredSites = 0;
  let unfinishedSites = 0;
  let skippedSites = 0;
  let excludedSites = 0;
  let skippedScenes = 0;
  let lastStopReason = null;
  let requests = 0;
  return {
    shadow,
    previousFlags,
    concurrency,
    async score({ site, acquisitions, previous, nowMs }) {
      if (site.surface !== 'land') return null;
      if (exclusions.has(site.id)) {
        excludedSites += 1;
        return null;
      }
      deadlineMs ??= clock() + budgetMs;
      if (halted || clock() >= deadlineMs) {
        skippedSites += 1;
        return previous;
      }
      try {
        const result = await scoreSiteChange({
          site, acquisitions, previous, fetchStatistics, searchBackfill, nowMs, deadlineMs, clock, thresholds, stopRequested: () => halted !== null,
        });
        requests += result.requests;
        skippedScenes += result.skippedScenes;
        if (result.halted) halt(result.halted, result.haltKind);
        if (result.stopped === null) scoredSites += 1;
        else {
          unfinishedSites += 1;
          lastStopReason = result.stopped;
        }
        return result.flag;
      } catch (error) {
        halt(errorText(error), 'error');
        return previous;
      }
    },
    summary: () => ({ shadow, scoredSites, unfinishedSites, skippedSites, excludedSites, skippedScenes, lastStopReason, statisticsRequests: requests, halted, haltKind }),
  };
}
