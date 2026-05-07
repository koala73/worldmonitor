// @ts-check
//
// Shared utility for the energy-disruption event log. NOT an entry point —
// see seed-energy-disruptions.mjs.
//
// Each event ties back to an asset seeded by the pipeline or storage
// registry (by assetId + assetType). Events are curated in
// scripts/data/energy-disruptions.json today; a state-transition
// classifier was scoped but not shipped.
//
// Schema documented in docs/methodology/disruptions.mdx.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENERGY_DISRUPTIONS_CANONICAL_KEY = 'energy:disruptions:v1';
export const ENERGY_DISRUPTIONS_TTL_SECONDS = 21 * 24 * 3600;

const VALID_ASSET_TYPES = new Set(['pipeline', 'storage']);
const VALID_EVENT_TYPES = new Set([
  'sabotage', 'sanction', 'maintenance', 'mechanical',
  'weather', 'commercial', 'war', 'other',
]);
const VALID_CAUSES = new Set([
  'sabotage', 'sanction', 'logistics', 'policy', 'war',
  'upstream_refinery', 'chokepoint', 'import_cut',
]);
const VALID_SOURCE_TYPES = new Set([
  'regulator', 'operator', 'press', 'ais-relay', 'satellite',
]);

const MIN_EVENTS = 8;

function loadRegistry() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(resolve(__dirname, 'data', 'energy-disruptions.json'), 'utf-8');
  return JSON.parse(raw);
}

/**
 * Load the pipeline + storage registries so `buildPayload` can join each
 * disruption event to its referenced asset and compute the `countries[]`
 * denorm field (plan §R/#5 decision B).
 *
 * Pipelines contribute fromCountry, toCountry, and transitCountries[].
 * Storage facilities contribute their single country code. Duplicates are
 * deduped and sorted so the seed output is stable across runs — unstable
 * ordering would churn the seeded payload bytes on every cron tick and
 * defeat envelope diffing.
 *
 * @returns {{
 *   pipelines: Record<string, { fromCountry?: string; toCountry?: string; transitCountries?: string[] }>,
 *   storage:   Record<string, { country?: string }>,
 * }}
 */
function loadAssetRegistries() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const gas = JSON.parse(readFileSync(resolve(__dirname, 'data', 'pipelines-gas.json'), 'utf-8'));
  const oil = JSON.parse(readFileSync(resolve(__dirname, 'data', 'pipelines-oil.json'), 'utf-8'));
  const storageRaw = JSON.parse(readFileSync(resolve(__dirname, 'data', 'storage-facilities.json'), 'utf-8'));

  // Merge with explicit collision detection. A spread like
  // { ...gas.pipelines, ...oil.pipelines } would silently let an oil
  // entry overwrite a gas entry if a curator ever added a pipeline
  // under the same id to both files — `deriveCountriesForEvent` would
  // then return data for whichever side won the spread regardless of
  // which commodity the disruption actually references, and the
  // collision would surface as mysterious wrong-country filter
  // results with no test or validator flagging it. Codex P2 on
  // PR #3377. Throw loudly so the next cron tick fails validation
  // and health alarms fire.
  /** @type {Record<string, any>} */
  const pipelines = {};
  for (const [id, p] of Object.entries(gas.pipelines ?? {})) pipelines[id] = p;
  for (const [id, p] of Object.entries(oil.pipelines ?? {})) {
    if (pipelines[id]) {
      throw new Error(
        `Duplicate pipeline id "${id}" present in both pipelines-gas.json ` +
        `and pipelines-oil.json — an event referencing this id would resolve ` +
        `ambiguously. Rename one of them before re-running the seeder.`,
      );
    }
    pipelines[id] = p;
  }

  return { pipelines, storage: storageRaw.facilities ?? {} };
}

/**
 * Compute the denormalised country set for a single event.
 *
 * @param {{ assetId: string; assetType: string }} event
 * @param {ReturnType<typeof loadAssetRegistries>} registries
 * @returns {string[]} ISO2 codes, deduped + alpha-sorted. Empty array when
 *   the referenced asset cannot be resolved — callers (seeder) should
 *   treat empty as a hard validation failure so stale references surface
 *   loudly on the next cron tick rather than silently corrupt the filter.
 */
function deriveCountriesForEvent(event, registries) {
  const out = new Set();
  if (event.assetType === 'pipeline') {
    const p = registries.pipelines[event.assetId];
    if (p) {
      if (typeof p.fromCountry === 'string') out.add(p.fromCountry);
      if (typeof p.toCountry === 'string') out.add(p.toCountry);
      if (Array.isArray(p.transitCountries)) {
        for (const c of p.transitCountries) if (typeof c === 'string') out.add(c);
      }
    }
  } else if (event.assetType === 'storage') {
    const s = registries.storage[event.assetId];
    if (s && typeof s.country === 'string') out.add(s.country);
  }
  return Array.from(out).sort();
}

/**
 * @param {unknown} data
 * @returns {boolean}
 */
export function validateRegistry(data) {
  if (!data || typeof data !== 'object') return false;
  const obj = /** @type {Record<string, unknown>} */ (data);
  if (!obj.events || typeof obj.events !== 'object') return false;
  const events = /** @type {Record<string, any>} */ (obj.events);
  const entries = Object.entries(events);
  if (entries.length < MIN_EVENTS) return false;

  const seenIds = new Set();
  for (const [key, e] of entries) {
    if (seenIds.has(key)) return false;
    seenIds.add(key);
    if (e.id !== key) return false;
    if (typeof e.assetId !== 'string' || e.assetId.length === 0) return false;
    if (!VALID_ASSET_TYPES.has(e.assetType)) return false;
    if (!VALID_EVENT_TYPES.has(e.eventType)) return false;
    if (typeof e.startAt !== 'string' || !isIsoDate(e.startAt)) return false;
    if (e.endAt !== null && (typeof e.endAt !== 'string' || !isIsoDate(e.endAt))) return false;
    if (typeof e.capacityOfflineBcmYr !== 'number' || e.capacityOfflineBcmYr < 0) return false;
    if (typeof e.capacityOfflineMbd !== 'number' || e.capacityOfflineMbd < 0) return false;
    if (!Array.isArray(e.causeChain) || e.causeChain.length === 0) return false;
    for (const c of e.causeChain) if (!VALID_CAUSES.has(c)) return false;
    if (typeof e.shortDescription !== 'string' || e.shortDescription.length === 0) return false;
    if (!Array.isArray(e.sources) || e.sources.length === 0) return false;
    for (const s of e.sources) {
      if (!s || typeof s !== 'object') return false;
      if (typeof s.authority !== 'string' || typeof s.title !== 'string') return false;
      if (typeof s.url !== 'string' || !s.url.startsWith('http')) return false;
      if (typeof s.date !== 'string' || !isIsoDate(s.date)) return false;
      if (!VALID_SOURCE_TYPES.has(s.sourceType)) return false;
    }
    if (typeof e.classifierVersion !== 'string') return false;
    if (typeof e.classifierConfidence !== 'number' ||
        e.classifierConfidence < 0 || e.classifierConfidence > 1) return false;
    if (typeof e.lastEvidenceUpdate !== 'string' || !isIsoDate(e.lastEvidenceUpdate)) return false;
    // endAt must not be earlier than startAt.
    if (e.endAt) {
      const start = Date.parse(e.startAt);
      const end = Date.parse(e.endAt);
      if (end < start) return false;
    }
    // countries[] is the denorm introduced in plan §R/#5 (decision B). Every
    // event must resolve to ≥1 country code from its referenced asset. An
    // empty array here means the upstream asset was removed or the assetId
    // is misspelled — both are hard errors the cron should surface by
    // failing validation (emptyDataIsFailure upstream preserves seed-meta
    // staleness so health alarms fire).
    if (!Array.isArray(e.countries) || e.countries.length === 0) return false;
    for (const c of e.countries) {
      if (typeof c !== 'string' || !/^[A-Z]{2}$/.test(c)) return false;
    }
  }
  return true;
}

function isIsoDate(v) {
  if (typeof v !== 'string') return false;
  return Number.isFinite(Date.parse(v));
}

export function buildPayload() {
  const registry = loadRegistry();
  const assets = loadAssetRegistries();

  // Denormalise countries[] on every event so CountryDeepDivePanel can
  // filter by country without an asset-registry round trip. If an event's
  // assetId cannot be resolved we leave countries[] empty — validateRegistry
  // rejects that shape, which fails the seed (emptyDataIsFailure: true)
  // and keeps seed-meta stale until the curator fixes the orphaned id.
  const rawEvents = /** @type {Record<string, any>} */ (registry.events ?? {});
  const events = Object.fromEntries(
    Object.entries(rawEvents).map(([id, event]) => [
      id,
      { ...event, countries: deriveCountriesForEvent(event, assets) },
    ]),
  );

  return { ...registry, events, updatedAt: new Date().toISOString() };
}

/**
 * @param {any} data
 * @returns {number}
 */
export function recordCount(data) {
  return Object.keys(data?.events ?? {}).length;
}

/**
 * @param {any} data
 * @returns {number}
 */
export function declareRecords(data) {
  return recordCount(data);
}

export const MAX_STALE_MIN = 20_160; // weekly cron × 2 headroom
