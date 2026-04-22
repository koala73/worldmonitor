// @ts-check
//
// Shared utility module for the fuel-shortage registry used by the Energy
// Atlas. NOT an entry point — see seed-fuel-shortages.mjs.
//
// Data is hand-curated in scripts/data/fuel-shortages.json for v1 launch.
// Post-launch, proactive-intelligence.mjs will extend this registry with
// LLM-classified entries from the news pipeline — the shape here is the
// contract the classifier must conform to (see Week 3 plan §11-12).
//
// Schema + evidence model documented in docs/methodology/shortages.mdx.
//
// Public severity is the raw field — there's no deriver here because
// 'confirmed' vs 'watch' IS the classifier output, not a transform of it.
// The evidence threshold that drives promotion/demotion lives in the
// classifier pipeline, not the registry reader.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FUEL_SHORTAGES_CANONICAL_KEY = 'energy:fuel-shortages:v1';
// Registry refreshed daily by the classifier; TTL cushion of 3× cadence.
export const FUEL_SHORTAGES_TTL_SECONDS = 3 * 24 * 3600;

const VALID_PRODUCTS = new Set(['petrol', 'diesel', 'jet', 'heating_oil']);
const VALID_SEVERITIES = new Set(['confirmed', 'watch']);
const VALID_IMPACT_TYPES = new Set([
  'stations_closed', 'rationing', 'flights_cancelled', 'import_cut', 'price_spike',
]);
const VALID_CAUSES = new Set([
  'upstream_refinery', 'logistics', 'policy', 'chokepoint', 'sanction', 'war', 'import_cut',
]);
const VALID_SOURCE_TYPES = new Set([
  'regulator', 'operator', 'press', 'ais-relay', 'satellite',
]);

// Minimum viable registry size at launch. Post-launch classifier will
// push this well above 15 automatically.
const MIN_SHORTAGES = 10;

function loadRegistry() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(resolve(__dirname, 'data', 'fuel-shortages.json'), 'utf-8');
  return JSON.parse(raw);
}

/**
 * @param {unknown} data
 * @returns {boolean}
 */
export function validateRegistry(data) {
  if (!data || typeof data !== 'object') return false;
  const obj = /** @type {Record<string, unknown>} */ (data);
  if (!obj.shortages || typeof obj.shortages !== 'object') return false;
  const shortages = /** @type {Record<string, any>} */ (obj.shortages);
  const entries = Object.entries(shortages);
  if (entries.length < MIN_SHORTAGES) return false;

  const seenIds = new Set();
  for (const [key, s] of entries) {
    if (seenIds.has(key)) return false;
    seenIds.add(key);
    if (s.id !== key) return false;
    if (typeof s.country !== 'string' || !/^[A-Z]{2}$/.test(s.country)) return false;
    if (!VALID_PRODUCTS.has(s.product)) return false;
    if (!VALID_SEVERITIES.has(s.severity)) return false;
    if (typeof s.firstSeen !== 'string' || !isIsoDate(s.firstSeen)) return false;
    if (typeof s.lastConfirmed !== 'string' || !isIsoDate(s.lastConfirmed)) return false;
    if (s.resolvedAt !== null && (typeof s.resolvedAt !== 'string' || !isIsoDate(s.resolvedAt))) return false;

    if (!Array.isArray(s.impactTypes)) return false;
    for (const t of s.impactTypes) if (!VALID_IMPACT_TYPES.has(t)) return false;

    if (!Array.isArray(s.causeChain)) return false;
    for (const c of s.causeChain) if (!VALID_CAUSES.has(c)) return false;

    if (typeof s.shortDescription !== 'string' || s.shortDescription.length === 0) return false;

    if (!s.evidence || typeof s.evidence !== 'object') return false;
    const ev = s.evidence;
    if (!Array.isArray(ev.evidenceSources)) return false;
    // Confirmed severity demands at least one regulator/operator source OR
    // firstRegulatorConfirmation set. This is the structural version of the
    // Day-12 evidence-threshold check — we keep it loose here (registry
    // seed) and tighten in the classifier.
    if (s.severity === 'confirmed') {
      const hasAuthoritativeSource =
        ev.firstRegulatorConfirmation != null ||
        ev.evidenceSources.some(src => src && (src.sourceType === 'regulator' || src.sourceType === 'operator'));
      if (!hasAuthoritativeSource) return false;
    }
    for (const src of ev.evidenceSources) {
      if (!src || typeof src !== 'object') return false;
      if (typeof src.authority !== 'string' || typeof src.title !== 'string') return false;
      if (typeof src.url !== 'string' || !src.url.startsWith('http')) return false;
      if (typeof src.date !== 'string' || !isIsoDate(src.date)) return false;
      if (!VALID_SOURCE_TYPES.has(src.sourceType)) return false;
    }
    if (typeof ev.classifierVersion !== 'string') return false;
    if (typeof ev.classifierConfidence !== 'number' ||
        ev.classifierConfidence < 0 || ev.classifierConfidence > 1) return false;
    if (typeof ev.lastEvidenceUpdate !== 'string' || !isIsoDate(ev.lastEvidenceUpdate)) return false;
  }
  return true;
}

function isIsoDate(v) {
  if (typeof v !== 'string') return false;
  const t = Date.parse(v);
  return Number.isFinite(t);
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
  return Object.keys(data?.shortages ?? {}).length;
}

/**
 * @param {any} data
 * @returns {number}
 */
export function declareRecords(data) {
  return recordCount(data);
}

// Daily cron (1440 min) × 2 headroom.
export const MAX_STALE_MIN = 2880;
