// Watched-site evidence: for each registry site, the newest confirmed open-archive image,
// the satellites that passed over it recently and their tier, the next imaging windows,
// and which operators' satellites cover it. Pure functions; the seeder owns Redis.
import { createHash } from 'node:crypto';
import { findPasses, parseOrbitElements } from './shared/orbital/pass-geometry.js';
import { SENSOR_PROFILES } from './shared/orbital/sensor-profiles.js';
import { decidePassTier } from './shared/orbital/tiers.js';
import { projectFlag } from './shared/orbital/flag-record.js';
import { readCountryRollup, ROLLUP_MAX_AGE_MS, SITES_SCHEMA } from './shared/orbital/country-rollup.js';
import { continuedFlag, flagShadowKey, RADAR_COLLECTION, radarGeometry, STAC_RADAR_FIELDS } from './_orbital-change.mjs';

export const ORBITAL_SITES_KEY = 'orbital:sites:v1';
export const ORBITAL_SITE_KEY_PREFIX = 'orbital:site:v1:';
export const ORBITAL_COUNTRY_KEY_PREFIX = 'orbital:country:v1:';
export const ORBITAL_SITES_ACTIVATION_KEY = 'seed-activated:orbital:sites';
/** Archive refusal backoff, read before any archive request. */
export const ORBITAL_SITES_BACKOFF_KEY = 'orbital:sites:backoff:v1';
const BACKOFF_FIRST_MS = 15 * 60_000;
const BACKOFF_MAX_MS = 24 * 3_600_000;
/** Wait after the n-th refusal in a row: 15 minutes, doubling, at most a day. */
export const archiveBackoffMs = (refusals) => Math.min(BACKOFF_FIRST_MS * 2 ** Math.max(0, refusals - 1), BACKOFF_MAX_MS);
export { ROLLUP_MAX_AGE_MS, SITES_SCHEMA };

export const PAST_DAYS = 6;
export const FUTURE_HOURS = 72;
export const ARCHIVE_LOOKBACK_DAYS = 30;
export const MATCH_TOLERANCE_MS = 10 * 60_000;
export const MAX_ACQUISITIONS = 10;
export const MAX_RECENT_PASSES = 60;
export const MAX_NEXT_WINDOWS = 30;
export const SITE_RECORD_MAX_BYTES = 48 * 1024;
export const ROLLUP_MAX_BYTES = 192 * 1024;

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
      include: ['id', 'collection', 'properties.datetime', 'properties.platform', 'properties.eo:cloud_cover', ...STAC_RADAR_FIELDS],
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
    const radar = feature.collection === RADAR_COLLECTION ? radarGeometry(feature.properties) : null;
    if (radar) acquisition.radar = radar;
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

const spacecraft = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, '');

function archiveAnswerFor(pass, acquisitions) {
  if (!Object.values(ARCHIVE_COLLECTION_PROFILE).includes(pass.profileId)) return null;
  const match = acquisitions.find((a) => a.profileId === pass.profileId
    && (a.platform === null || spacecraft(a.platform) === spacecraft(pass.name))
    && Math.abs(Date.parse(a.datetime) - pass.timeMs) <= MATCH_TOLERANCE_MS);
  return match ? { status: 'match', itemId: match.itemId } : { status: 'no-match' };
}

const newest = (a, b) => (!a ? b ?? null : !b ? a : a.datetime >= b.datetime ? a : b);

/**
 * One site's record. `previous` carries what a scene that is absent this run cannot
 * replace: the last observation stays until a newer scene exists. Flag state is owned by
 * change scoring; without it the previous flag passes through untouched.
 */
export function buildSiteRecord({ site, catalog, acquisitions, previous, nowMs, flag = previous?.flag ?? null }) {
  const passes = [];
  for (const satellite of catalog.satellites ?? []) {
    const profile = PROFILES_BY_ID.get(satellite.profileId);
    if (profile) passes.push(...passesFor(satellite, profile, catalog, site, nowMs).map((pass) => ({ pass, profile })));
  }
  passes.sort((a, b) => a.pass.timeMs - b.pass.timeMs || a.pass.noradId - b.pass.noradId);
  const imaging = passes.filter(({ pass }) => pass.inFootprint);

  const recentPasses = imaging
    .filter(({ pass }) => !pass.opportunity)
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
  const nextWindows = imaging
    .filter(({ pass }) => pass.opportunity)
    .slice(0, MAX_NEXT_WINDOWS)
    .map(({ pass }) => ({
      noradId: pass.noradId, name: pass.name, profileId: pass.profileId, category: pass.category, time: pass.time,
      sunElevationDeg: Math.round(pass.sunElevationDeg * 10) / 10,
      coverage: pass.coverage,
    }));

  const byOperator = new Map();
  for (const { pass, profile } of imaging) {
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
    flag,
  };
  return finishSiteRecord(body, nowMs);
}

function finishSiteRecord(body, evaluatedAt) {
  const record = { ...body, revision: hash(body), evaluatedAt };
  const bytes = Buffer.byteLength(JSON.stringify(record));
  if (bytes > SITE_RECORD_MAX_BYTES) throw new Error(`site record ${body.siteId} is ${bytes} bytes, over ${SITE_RECORD_MAX_BYTES}`);
  return record;
}

/** The same record carrying another flag, without recomputing its passes. */
export function withSiteFlag(record, flag) {
  const { revision: _revision, evaluatedAt, ...body } = record;
  return finishSiteRecord({ ...body, flag }, evaluatedAt);
}

/** Registry order starting at `cursor`, wrapping, so a run resumes where the last one stopped. */
export function siteOrder(sites, cursor) {
  const sorted = [...sites].sort((a, b) => a.id.localeCompare(b.id));
  const start = cursor ? sorted.findIndex((site) => site.id >= cursor) : 0;
  return start <= 0 ? sorted : [...sorted.slice(start), ...sorted.slice(0, start)];
}

async function inPool(items, concurrency, task) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
}

/**
 * Evaluates sites in cursor order until the deadline. A site whose archive search fails, or
 * whose record would exceed the size cap, keeps its previous record. A refusal stops the pass
 * at the refused site, which the next run starts from; the sites evaluated before it are kept
 * and nothing is scored. With a change stage, records are built inside the pass, then each
 * evaluated site's flag is scored from the same archive answer, unfinished sites first and
 * then least recently scored, so sites the stage's budget missed go first next run. A shadowed
 * flag goes to `flags` only, and the site record carries none; a live flag continues from the
 * newer of the site's live and shadow flags, so leaving shadow keeps the shadow period's state.
 */
export async function evaluateSites({ sites, catalog, previousRecords, cursor, searchArchive, nowMs, deadlineMs, clock = Date.now, change = null }) {
  const order = siteOrder(sites, cursor);
  const records = new Map();
  const flags = new Map();
  const failed = [];
  const searched = [];
  let evaluated = 0;
  let nextSiteId = null;
  let refused = null;
  for (const site of order) {
    if (clock() >= deadlineMs) {
      nextSiteId = site.id;
      break;
    }
    const previous = previousRecords.get(site.id) ?? null;
    let acquisitions;
    try {
      acquisitions = await searchArchive(site, nowMs, deadlineMs);
    } catch (error) {
      if (error instanceof ArchiveRefusal) {
        refused = error.message;
        nextSiteId = site.id;
        break;
      }
      evaluated += 1;
      failed.push({ siteId: site.id, reason: error?.message || String(error) });
      continue;
    }
    evaluated += 1;
    try {
      records.set(site.id, buildSiteRecord({ site, catalog, acquisitions, previous, nowMs, ...(change && { flag: null }) }));
    } catch (error) {
      failed.push({ siteId: site.id, reason: error?.message || String(error) });
      continue;
    }
    if (!change) continue;
    const shadowFlag = change.previousFlags.get(site.id) ?? null;
    const previousFlag = change.shadow ? shadowFlag : continuedFlag(previous?.flag ?? null, shadowFlag);
    searched.push({ site, acquisitions, previousFlag });
  }
  if (change && refused && !change.shadow) {
    // Records were built without a flag for scoring to fill; nothing is scored after a refusal.
    for (const { site, previousFlag } of searched) {
      try {
        records.set(site.id, withSiteFlag(records.get(site.id), previousFlag));
      } catch (error) {
        records.delete(site.id);
        failed.push({ siteId: site.id, reason: error?.message || String(error) });
      }
    }
  }
  if (change && !refused) {
    searched.sort((a, b) => Number(!a.previousFlag?.unfinished) - Number(!b.previousFlag?.unfinished)
      || (a.previousFlag?.updatedAt ?? 0) - (b.previousFlag?.updatedAt ?? 0));
    await inPool(searched, change.concurrency ?? 1, async ({ site, acquisitions, previousFlag }) => {
      const flag = await change.score({ site, acquisitions, previous: previousFlag, nowMs });
      if (change.shadow) {
        if (flag) flags.set(site.id, flag);
        return;
      }
      try {
        records.set(site.id, withSiteFlag(records.get(site.id), flag));
      } catch (error) {
        records.delete(site.id);
        failed.push({ siteId: site.id, reason: error?.message || String(error) });
      }
    });
  }
  return { records, flags, failed, evaluated, nextSiteId, refused, change: change?.summary() ?? null };
}

/**
 * Per-country projection of site records: no state of its own beyond what its sites carry.
 * Given `nowMs`, a site older than the freshness gate is left out while the country has a
 * fresh one, so one stale site does not age its whole country past the gate.
 */
export function buildCountryRollup(countryCode, records, nowMs = null, maxAgeMs = ROLLUP_MAX_AGE_MS) {
  const own = records.filter((record) => record.countryCode === countryCode);
  const fresh = nowMs === null ? own : own.filter((record) => nowMs - record.evaluatedAt <= maxAgeMs);
  const sites = (fresh.length > 0 ? fresh : own)
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
      nextWindow: record.nextWindows[0] ? { profileId: record.nextWindows[0].profileId, time: record.nextWindows[0].time } : null,
      operators: [...new Set(record.coverage.map((entry) => entry.operator))],
      flag: projectFlag(record.flag),
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

/** The readers' gate (shared/orbital/country-rollup.js) applied to what this seeder publishes. */
export function isRollupCurrent(rollup, index, nowMs, maxAgeMs = ROLLUP_MAX_AGE_MS) {
  return readCountryRollup(rollup, index, rollup?.countryCode, nowMs, maxAgeMs).status === 'current';
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
  const rollups = new Map(countryCodes.map((code) => [code, buildCountryRollup(code, all, nowMs)]));

  const removedSiteIds = Object.keys(previousIndex?.sites ?? {}).filter((id) => !registryIds.has(id)).sort();
  const removedCountries = Object.keys(previousIndex?.countries ?? {}).filter((code) => !rollups.has(code)).sort();

  const index = {
    schema: SITES_SCHEMA,
    registryVersion,
    runAt: nowMs,
    nextSiteId: evaluation.nextSiteId,
    evaluated: evaluation.evaluated,
    failed: evaluation.failed,
    ...(evaluation.refused && { refused: evaluation.refused }),
    ...(evaluation.change && { change: evaluation.change }),
    // Countries the registry watches, so a reader can tell one not yet evaluated from one with no sites.
    registryCountries: [...new Set(sites.map((site) => site.countryCode))].sort(),
    sites: Object.fromEntries([...records.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([id, record]) => [id, { countryCode: record.countryCode, revision: record.revision, evaluatedAt: record.evaluatedAt }])),
    countries: Object.fromEntries([...rollups.entries()]
      .map(([code, rollup]) => [code, { revision: rollup.revision, asOf: rollup.asOf, siteCount: rollup.sites.length }])),
  };
  return {
    index,
    siteWrites: [...evaluation.records.values()].filter((record) => registryIds.has(record.siteId)),
    retainedSiteIds: [...records.keys()].filter((id) => !evaluation.records.has(id)).sort(),
    rollupWrites: [...rollups.values()],
    flagWrites: evaluation.change?.shadow ? [...evaluation.flags.values()].filter((flag) => registryIds.has(flag.siteId)) : null,
    deletes: [...removedSiteIds.flatMap((id) => [siteKey(id), flagShadowKey(id)]), ...removedCountries.map(countryKey)],
  };
}
