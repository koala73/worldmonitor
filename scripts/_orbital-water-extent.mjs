// Radar water extent over each strategic reservoir (#10714): the share of the reservoir's core box that
// Sentinel-1 sees as open water, one observation per covering scene. Calm open water is the darkest
// target a C-band radar sees, so a fixed backscatter threshold on terrain-corrected gamma0 separates it
// from land in any weather, day or night. Pure functions; seed-orbital-water-extent.mjs does the I/O.

export const WATER_EXTENT_SCHEMA = 1;
export const RTC_COLLECTION = 'sentinel-1-rtc';
/** VV gamma0 below -18 dB is open water (linear 10^(-18/10)). */
export const WATER_THRESHOLD_DB = -18;
export const WATER_THRESHOLD_LINEAR = 10 ** (WATER_THRESHOLD_DB / 10);
/** A scene counts only when it images nearly the whole box; slice edges would read as lost water. */
export const MIN_VALID_PERCENT = 90;
/** Coarse statistics: about 1M pixels over the largest box, plenty for an area share. */
export const STATISTICS_MAX_SIZE = 1024;
/** First run backfills this far; later runs pick up only new scenes. */
export const SEARCH_LOOKBACK_DAYS = 120;
export const SERIES_RETENTION_DAYS = 730;
export const MAX_OBSERVATIONS = 400;
export const MAX_SCENES_PER_SITE_PER_RUN = 8;
export const SOURCE = Object.freeze({
  name: 'Copernicus Sentinel-1 RTC via Microsoft Planetary Computer',
  collection: RTC_COLLECTION,
  url: 'https://planetarycomputer.microsoft.com/dataset/sentinel-1-rtc',
  license: 'Copernicus Sentinel data, free and open (terrain correction: Catalyst/PCI, CC BY 4.0)',
});
export const METHODOLOGY = 'Share of each reservoir core box with Sentinel-1 VV gamma0 below -18 dB (open water), '
  + 'per radar scene that images at least 90% of the box. Values from different orbits are not strictly comparable: '
  + 'compare a reading with earlier readings from the same relative orbit. Wind-roughened water reads as land, so a single '
  + 'low reading on a large open lake is not evidence of shrinkage; look at several scenes.';

const DAY_MS = 86_400_000;
const EARTH_KM_PER_DEG = 111.32;

/** Area of a lon/lat box in km², on a sphere. */
export function boxAreaKm2([west, south, east, north]) {
  const rad = Math.PI / 180;
  return Math.round(EARTH_KM_PER_DEG ** 2 * (east - west) * ((Math.sin(north * rad) - Math.sin(south * rad)) / rad) * 10) / 10;
}

export const boxPolygon = ([west, south, east, north]) => ({
  type: 'Polygon',
  coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
});

/** Reservoir watched sites joined to their watchlist entry, so each carries its measurement box. */
export function reservoirTargets(sites, watchlist) {
  const byId = new Map(watchlist.map((r) => [r.id, r]));
  const targets = [];
  for (const site of sites) {
    if (site.surface !== 'water') continue;
    const origin = site.origins.find((o) => o.list === 'reservoir');
    const entry = origin && byId.get(origin.id);
    if (!entry || !Array.isArray(entry.core) || entry.core.length !== 4) continue;
    targets.push({ siteId: site.id, reservoirId: entry.id, name: site.name, countryCode: site.countryCode, box: entry.core });
  }
  return targets;
}

/** Least recently completed first, so a run that runs out of budget does not starve the same reservoirs every day. */
export function orderTargets(targets, prior) {
  const at = (t) => Date.parse(prior?.[t.siteId]?.searchedThrough ?? '') || 0;
  return [...targets].sort((a, b) => at(a) - at(b));
}

export function stacSearchBody(box, sinceIso, untilIso) {
  return {
    collections: [RTC_COLLECTION],
    intersects: boxPolygon(box),
    datetime: `${sinceIso}/${untilIso}`,
    limit: 100,
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
    fields: { include: ['id', 'properties.datetime', 'properties.platform', 'properties.sat:relative_orbit', 'properties.sat:orbit_state'], exclude: ['assets', 'links', 'geometry'] },
  };
}

export function scenesFromSearch(collection) {
  const features = Array.isArray(collection?.features) ? collection.features : [];
  return features
    .map((f) => ({
      sceneId: typeof f?.id === 'string' ? f.id : '',
      time: f?.properties?.datetime ?? '',
      platform: f?.properties?.platform ?? null,
      relativeOrbit: Number.isInteger(f?.properties?.['sat:relative_orbit']) ? f.properties['sat:relative_orbit'] : null,
      orbitState: f?.properties?.['sat:orbit_state'] ?? null,
    }))
    .filter((s) => s.sceneId && Number.isFinite(Date.parse(s.time)));
}

export const statisticsQuery = (sceneId) => new URLSearchParams({
  collection: RTC_COLLECTION,
  item: sceneId,
  assets: 'vv',
  max_size: String(STATISTICS_MAX_SIZE),
  histogram_bins: '1',
  histogram_range: `0,${WATER_THRESHOLD_LINEAR}`,
}).toString();

/**
 * One scene's reading from a titiler statistics response, or null when the scene images too little of
 * the box to say anything about it. A response without the histogram throws, so the scene is retried.
 */
export function readingFromStatistics(response, areaKm2) {
  const band = response?.properties?.statistics?.vv_b1;
  const validPercent = Number(band?.valid_percent);
  const validPixels = Number(band?.valid_pixels);
  const waterPixels = Number(band?.histogram?.[0]?.[0]);
  if (!Number.isFinite(validPercent) || !Number.isFinite(validPixels) || validPixels < 0 || !Number.isFinite(waterPixels)) {
    throw new Error('statistics response lacks the vv_b1 histogram');
  }
  if (validPercent < MIN_VALID_PERCENT || validPixels === 0) return null;
  const share = Math.min(1, Math.max(0, waterPixels / validPixels));
  return {
    waterPercent: Math.round(share * 1000) / 10,
    waterKm2: Math.round(share * areaKm2 * 10) / 10,
    validPercent: Math.round(validPercent * 10) / 10,
  };
}

const byTimeDesc = (a, b) => Date.parse(b.time) - Date.parse(a.time) || (a.sceneId < b.sceneId ? -1 : 1);

/** Merge new observations into the previous series: one per scene, newest first, inside retention. */
export function mergeSeries(previous, additions, nowMs) {
  const cutoff = nowMs - SERIES_RETENTION_DAYS * DAY_MS;
  const byScene = new Map();
  for (const o of [...(previous ?? []), ...additions]) {
    if (o && typeof o.sceneId === 'string' && Date.parse(o.time) >= cutoff) byScene.set(o.sceneId, o);
  }
  return [...byScene.values()].sort(byTimeDesc).slice(0, MAX_OBSERVATIONS);
}

/** Scenes already measured or already found not to image the box are not requested again. */
export function pendingScenes(scenes, record, limit = MAX_SCENES_PER_SITE_PER_RUN) {
  const done = new Set([...(record?.observations ?? []).map((o) => o.sceneId), ...(record?.partialScenes ?? [])]);
  return scenes.filter((s) => !done.has(s.sceneId)).sort(byTimeDesc).slice(0, limit);
}

/** Scenes reach the catalogue up to a few days after acquisition, so each search reaches back this far. */
export const SEARCH_OVERLAP_DAYS = 5;

/** Where the next search starts: a little before the last complete search, never past the backfill horizon. */
export function searchSince(record, nowMs) {
  const horizon = nowMs - SEARCH_LOOKBACK_DAYS * DAY_MS;
  const last = Date.parse(record?.searchedThrough ?? '');
  return new Date(Number.isFinite(last) ? Math.max(horizon, last - SEARCH_OVERLAP_DAYS * DAY_MS) : horizon).toISOString();
}

/**
 * Measure one reservoir. Scenes are taken newest first; a run that stops early (budget, upstream error)
 * keeps everything measured so far and leaves `searchedThrough` where it was so the rest is retried.
 * Past the deadline it makes no request at all and carries the previous record (or an empty one).
 */
export async function measureReservoir(target, previous, { searchScenes, fetchStatistics, nowMs, deadlineMs, clock = Date.now }) {
  const areaKm2 = boxAreaKm2(target.box);
  const untilIso = new Date(nowMs).toISOString();
  const base = { siteId: target.siteId, reservoirId: target.reservoirId, name: target.name, countryCode: target.countryCode, box: target.box, areaKm2 };
  const keep = previous && previous.reservoirId === target.reservoirId ? previous : null;
  const carried = () => {
    const observations = keep?.observations ?? [];
    return { ...base, searchedThrough: keep?.searchedThrough ?? null, observations, partialScenes: keep?.partialScenes ?? [], latest: observations[0] ?? null };
  };
  if (clock() >= deadlineMs) return { record: carried(), requests: 0, added: 0, error: null };
  let scenes;
  try {
    scenes = scenesFromSearch(await searchScenes(stacSearchBody(target.box, searchSince(keep, nowMs), untilIso)));
  } catch (error) {
    return { record: carried(), requests: 1, added: 0, error: `search: ${error.message}` };
  }
  const todo = pendingScenes(scenes, keep);
  const additions = [];
  const partial = new Set(keep?.partialScenes ?? []);
  let requests = 1;
  let error = null;
  let complete = todo.length === pendingScenes(scenes, keep, Infinity).length;
  for (const scene of todo) {
    if (clock() >= deadlineMs) { complete = false; break; }
    requests += 1;
    try {
      const reading = readingFromStatistics(await fetchStatistics(scene.sceneId, boxPolygon(target.box)), areaKm2);
      if (reading) additions.push({ ...scene, ...reading });
      else partial.add(scene.sceneId);
    } catch (e) {
      error = `statistics ${scene.sceneId}: ${e.message}`;
      complete = false;
    }
  }
  const observations = mergeSeries(keep?.observations, additions, nowMs);
  const sceneIds = new Set(scenes.map((s) => s.sceneId));
  const record = {
    ...base,
    searchedThrough: complete ? untilIso : (keep?.searchedThrough ?? null),
    observations,
    partialScenes: [...partial].filter((id) => sceneIds.has(id) || !complete).slice(-200),
    latest: observations[0] ?? null,
  };
  return { record, requests, added: additions.length, error };
}

/** Health counts reservoirs with a reading inside the last 60 days. */
export function freshReservoirCount(data, nowMs = data?.runAt) {
  return Object.values(data?.reservoirs ?? {}).filter((r) => r.latest && nowMs - Date.parse(r.latest.time) <= 60 * DAY_MS).length;
}
