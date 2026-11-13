// Watched-site evidence: for each registry site, the newest confirmed open-archive image,
// the satellites that passed over it recently and their tier, the next imaging windows,
// and which operators' satellites cover it. Pure functions; the seeder owns Redis.
import { createHash } from 'node:crypto';
import { findPasses, parseOrbitElements } from './shared/orbital/pass-geometry.js';
import { SENSOR_PROFILES } from './shared/orbital/sensor-profiles.js';
import { decidePassTier } from './shared/orbital/tiers.js';

export const ORBITAL_SITES_KEY = 'orbital:sites:v1';
export const ORBITAL_SITE_KEY_PREFIX = 'orbital:site:v1:';
export const ORBITAL_COUNTRY_KEY_PREFIX = 'orbital:country:v1:';
export const ORBITAL_SITES_ACTIVATION_KEY = 'seed-activated:orbital:sites';
export const SITES_SCHEMA = 1;

export const PAST_DAYS = 6;
export const FUTURE_HOURS = 72;
export const ARCHIVE_LOOKBACK_DAYS = 30;
export const MATCH_TOLERANCE_MS = 10 * 60_000;
export const MAX_ACQUISITIONS = 10;
export const MAX_RECENT_PASSES = 60;
export const MAX_NEXT_WINDOWS = 30;
export const SITE_RECORD_MAX_BYTES = 48 * 1024;
export const ROLLUP_MAX_BYTES = 192 * 1024;
// Three days: the seeder runs daily and a whole registry pass can span two runs.
export const ROLLUP_MAX_AGE_MS = 3 * 86_400_000;

export const STAC_SEARCH_URL = 'https://planetarycomputer.microsoft.com/api/stac/v1/search';
export const ARCHIVE_COLLECTION_PROFILE = Object.freeze({
  'sentinel-2-l2a': 'sentinel-2',
  'sentinel-1-grd': 'sentinel-1',
  'landsat-c2-l2': 'landsat',
});

const DAY_MS = 86_400_000;
const PROFILES_BY_ID = new Map(SENSOR_PROFILES.map((profile) => [profile.id, profile]));

export const siteKey = (siteId) => `${ORBITAL_SITE_KEY_PREFIX}${siteId}`;
export const countryKey = (countryCode) => `${ORBITAL_COUNTRY_KEY_PREFIX}${countryCode}`;

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/** The archive refused service: the run stops and every record is kept. */
export class ArchiveRefusal extends Error {}

export function stacSearchBody(site, nowMs) {
  const start = new Date(nowMs - ARCHIVE_LOOKBACK_DAYS * DAY_MS).toISOString();
  return {
    collections: Object.keys(ARCHIVE_COLLECTION_PROFILE),
    intersects: { type: 'Point', coordinates: [site.lon, site.lat] },
    datetime: `${start}/${new Date(nowMs).toISOString()}`,
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
    limit: 100,
    fields: {
      include: ['id', 'collection', 'properties.datetime', 'properties.platform', 'properties.eo:cloud_cover'],
      exclude: ['assets', 'links', 'geometry', 'bbox'],
    },
  };
}

/**
 * Scenes from one overpass (Sentinel-2 tiles, Sentinel-1 slices) collapse into one
 * acquisition per platform and minute, keeping the clearest scene.
 */
export function acquisitionsFromStac(features) {
  const byPass = new Map();
  for (const feature of Array.isArray(features) ? features : []) {
    const profileId = ARCHIVE_COLLECTION_PROFILE[feature?.collection];
    const datetime = feature?.properties?.datetime;
    const timeMs = Date.parse(datetime);
    if (!profileId || !feature.id || !Number.isFinite(timeMs)) continue;
    const cloud = feature.properties['eo:cloud_cover'];
    const acquisition = {
      itemId: feature.id,
      collection: feature.collection,
      profileId,
      platform: feature.properties.platform ?? null,
      datetime: new Date(timeMs).toISOString(),
      cloudCover: Number.isFinite(cloud) ? Math.round(cloud * 10) / 10 : null,
    };
    const key = `${acquisition.platform}|${Math.round(timeMs / 60_000)}`;
    const held = byPass.get(key);
    if (!held || (acquisition.cloudCover ?? 101) < (held.cloudCover ?? 101)) byPass.set(key, acquisition);
  }
  return [...byPass.values()].sort((a, b) => b.datetime.localeCompare(a.datetime) || a.itemId.localeCompare(b.itemId));
}

function elementsNear(catalog, noradId, targetMs) {
  let best = null;
  for (const day of catalog.ring ?? []) {
    const omm = day.elements?.find((e) => Number(e.NORAD_CAT_ID) === noradId);
    if (!omm) continue;
    const distance = Math.abs(day.fetchedAt - targetMs);
    if (!best || distance < best.distance) best = { omm, distance };
  }
  return best?.omm;
}

function passesFor(satellite, profile, catalog, point, nowMs) {
  const segments = [];
  for (let start = nowMs - PAST_DAYS * DAY_MS; start < nowMs; start += DAY_MS) {
    const end = Math.min(start + DAY_MS, nowMs);
    segments.push({ start, end, asOf: end, omm: elementsNear(catalog, satellite.noradId, start + DAY_MS / 2) ?? satellite.elements });
  }
  segments.push({ start: nowMs, end: nowMs + FUTURE_HOURS * 3_600_000, asOf: nowMs, omm: satellite.elements });
  const passes = [];
  // A historical day is judged by element age on that day, not today.
  for (const { start, end, asOf, omm } of segments) {
    let elements;
    try { elements = parseOrbitElements(omm); } catch { continue; }
    const result = findPasses({ elements, profile, point, window: { start, end }, now: asOf });
    if (result.status === 'ok') passes.push(...result.passes);
  }
  return passes;
}

function archiveAnswerFor(pass, acquisitions) {
  if (!Object.values(ARCHIVE_COLLECTION_PROFILE).includes(pass.profileId)) return null;
  const match = acquisitions.find((a) => a.profileId === pass.profileId && Math.abs(Date.parse(a.datetime) - pass.timeMs) <= MATCH_TOLERANCE_MS);
  return match ? { status: 'match', itemId: match.itemId } : { status: 'no-match' };
}

const newest = (a, b) => (!a ? b ?? null : !b ? a : a.datetime >= b.datetime ? a : b);

/**
 * One site's record. `previous` carries what a scene that is absent this run cannot
 * replace: the last observation stays until a newer scene exists, and flag state is
 * owned by change scoring and passes through untouched.
 */
export function buildSiteRecord({ site, catalog, acquisitions, previous, nowMs }) {
  const passes = [];
  for (const satellite of catalog.satellites ?? []) {
    const profile = PROFILES_BY_ID.get(satellite.profileId);
    if (profile) passes.push(...passesFor(satellite, profile, catalog, site, nowMs).map((pass) => ({ pass, profile })));
  }
  passes.sort((a, b) => a.pass.timeMs - b.pass.timeMs || a.pass.noradId - b.pass.noradId);

  const recentPasses = passes
    .filter(({ pass }) => !pass.opportunity && pass.inFootprint)
    .map(({ pass, profile }) => {
      const archive = archiveAnswerFor(pass, acquisitions);
      return {
        noradId: pass.noradId, name: pass.name, profileId: pass.profileId, category: pass.category, time: pass.time,
        tier: decidePassTier(pass, profile, archive, nowMs).kind,
        ...(archive?.status === 'match' ? { itemId: archive.itemId } : {}),
      };
    })
    .slice(-MAX_RECENT_PASSES)
    .reverse();
  const nextWindows = passes
    .filter(({ pass }) => pass.opportunity)
    .slice(0, MAX_NEXT_WINDOWS)
    .map(({ pass }) => ({
      noradId: pass.noradId, name: pass.name, profileId: pass.profileId, category: pass.category, time: pass.time,
      inFootprint: pass.inFootprint, sunElevationDeg: Math.round(pass.sunElevationDeg * 10) / 10,
    }));

  const byOperator = new Map();
  for (const { pass, profile } of passes) {
    const key = `${profile.operator}|${profile.category}`;
    const entry = byOperator.get(key) ?? { operator: profile.operator, category: profile.category, satellites: new Set(), passes: 0 };
    entry.satellites.add(pass.noradId);
    entry.passes += 1;
    byOperator.set(key, entry);
  }
  const coverage = [...byOperator.values()]
    .map((entry) => ({ operator: entry.operator, category: entry.category, satellites: entry.satellites.size, passes: entry.passes }))
    .sort((a, b) => a.operator.localeCompare(b.operator) || a.category.localeCompare(b.category));

  const body = {
    schema: SITES_SCHEMA,
    siteId: site.id,
    name: site.name,
    lat: site.lat,
    lon: site.lon,
    countryCode: site.countryCode,
    surface: site.surface,
    origins: site.origins,
    catalogFetchedAt: catalog.fetchedAt,
    lastObservation: newest(previous?.lastObservation, acquisitions[0]),
    acquisitions: acquisitions.slice(0, MAX_ACQUISITIONS),
    recentPasses,
    nextWindows,
    coverage,
    flag: previous?.flag ?? null,
  };
  const record = { ...body, revision: hash(body), evaluatedAt: nowMs };
  const bytes = Buffer.byteLength(JSON.stringify(record));
  if (bytes > SITE_RECORD_MAX_BYTES) throw new Error(`site record ${site.id} is ${bytes} bytes, over ${SITE_RECORD_MAX_BYTES}`);
  return record;
}

/** Registry order starting at `cursor`, wrapping, so a run resumes where the last one stopped. */
export function siteOrder(sites, cursor) {
  const sorted = [...sites].sort((a, b) => a.id.localeCompare(b.id));
  const start = cursor ? sorted.findIndex((site) => site.id >= cursor) : 0;
  return start <= 0 ? sorted : [...sorted.slice(start), ...sorted.slice(0, start)];
}

/**
 * Evaluates sites in cursor order until the deadline. A site whose archive search fails
 * keeps its previous record; a refusal stops the run before anything is written.
 */
export async function evaluateSites({ sites, catalog, previousRecords, cursor, searchArchive, nowMs, deadlineMs, clock = Date.now }) {
  const order = siteOrder(sites, cursor);
  const records = new Map();
  const failed = [];
  let evaluated = 0;
  let nextSiteId = null;
  for (const site of order) {
    if (clock() >= deadlineMs) {
      nextSiteId = site.id;
      break;
    }
    const previous = previousRecords.get(site.id) ?? null;
    let acquisitions;
    try {
      acquisitions = await searchArchive(site, nowMs);
    } catch (error) {
      if (error instanceof ArchiveRefusal) return { refused: error.message };
      failed.push({ siteId: site.id, reason: error?.message || String(error) });
      continue;
    } finally {
      evaluated += 1;
    }
    records.set(site.id, buildSiteRecord({ site, catalog, acquisitions, previous, nowMs }));
  }
  return { records, failed, evaluated, nextSiteId };
}

function nextImagingWindow(record) {
  const window = record.nextWindows.find((candidate) => candidate.inFootprint);
  return window ? { profileId: window.profileId, time: window.time } : null;
}

/** Per-country projection of site records: no state of its own beyond what its sites carry. */
export function buildCountryRollup(countryCode, records) {
  const sites = records
    .filter((record) => record.countryCode === countryCode)
    .sort((a, b) => a.siteId.localeCompare(b.siteId))
    .map((record) => ({
      siteId: record.siteId,
      name: record.name,
      lat: record.lat,
      lon: record.lon,
      surface: record.surface,
      originLists: [...new Set(record.origins.map((origin) => origin.list))],
      revision: record.revision,
      evaluatedAt: record.evaluatedAt,
      lastObservation: record.lastObservation
        ? { itemId: record.lastObservation.itemId, profileId: record.lastObservation.profileId, datetime: record.lastObservation.datetime }
        : null,
      nextWindow: nextImagingWindow(record),
      operators: [...new Set(record.coverage.map((entry) => entry.operator))],
      flag: record.flag,
    }));
  const rollup = {
    schema: SITES_SCHEMA,
    countryCode,
    asOf: Math.min(...sites.map((site) => site.evaluatedAt)),
    revision: hash(sites.map((site) => [site.siteId, site.revision])),
    sites,
  };
  const bytes = Buffer.byteLength(JSON.stringify(rollup));
  if (bytes > ROLLUP_MAX_BYTES) throw new Error(`country rollup ${countryCode} is ${bytes} bytes, over ${ROLLUP_MAX_BYTES}`);
  return rollup;
}

/** A reader's gate: the rollup is the one the index names, and its oldest site is fresh enough. */
export function isRollupCurrent(rollup, index, nowMs, maxAgeMs = ROLLUP_MAX_AGE_MS) {
  if (!rollup || rollup.schema !== SITES_SCHEMA) return false;
  if (index?.countries?.[rollup.countryCode]?.revision !== rollup.revision) return false;
  return nowMs - rollup.asOf <= maxAgeMs;
}

/**
 * The next state of every key: site records for registry sites only (new or kept),
 * one rollup per country that has records, and deletions for everything the registry
 * or the record set no longer names.
 */
export function planPublication({ sites, registryVersion, previousIndex, previousRecords, evaluation, nowMs }) {
  const registryIds = new Set(sites.map((site) => site.id));
  const records = new Map();
  for (const site of sites) {
    const record = evaluation.records.get(site.id) ?? previousRecords.get(site.id);
    if (record) records.set(site.id, record);
  }
  const all = [...records.values()];
  const countryCodes = [...new Set(all.map((record) => record.countryCode))].sort();
  const rollups = new Map(countryCodes.map((code) => [code, buildCountryRollup(code, all)]));

  const removedSiteIds = Object.keys(previousIndex?.sites ?? {}).filter((id) => !registryIds.has(id)).sort();
  const removedCountries = Object.keys(previousIndex?.countries ?? {}).filter((code) => !rollups.has(code)).sort();

  const index = {
    schema: SITES_SCHEMA,
    registryVersion,
    runAt: nowMs,
    nextSiteId: evaluation.nextSiteId,
    evaluated: evaluation.evaluated,
    failed: evaluation.failed,
    sites: Object.fromEntries([...records.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([id, record]) => [id, { countryCode: record.countryCode, revision: record.revision, evaluatedAt: record.evaluatedAt }])),
    countries: Object.fromEntries([...rollups.entries()]
      .map(([code, rollup]) => [code, { revision: rollup.revision, asOf: rollup.asOf, siteCount: rollup.sites.length }])),
  };
  return {
    index,
    siteWrites: [...evaluation.records.values()].filter((record) => registryIds.has(record.siteId)),
    rollupWrites: [...rollups.values()],
    deletes: [...removedSiteIds.map(siteKey), ...removedCountries.map(countryKey)],
  };
}
