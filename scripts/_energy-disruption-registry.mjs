// @ts-check
//
// Shared utility for the energy-disruption event log. NOT an entry point —
// see seed-energy-disruptions.mjs.
//
// Each event ties back to an asset seeded by the pipeline or storage
// registry (by assetId + assetType). The classifier that keeps this
// registry fresh post-launch runs in proactive-intelligence.mjs — the
// shape here is the contract it must conform to.
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
  }
  return true;
}

function isIsoDate(v) {
  if (typeof v !== 'string') return false;
  return Number.isFinite(Date.parse(v));
}

export function buildPayload() {
  const registry = loadRegistry();
  return { ...registry, updatedAt: new Date().toISOString() };
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
