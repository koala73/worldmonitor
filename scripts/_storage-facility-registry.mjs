// @ts-check
//
// Shared utility module for the strategic storage facility registry used by
// the Energy Atlas. NOT an entry point — see seed-storage-facilities.mjs.
//
// Data is hand-curated in scripts/data/storage-facilities.json. Covers five
// facility classes:
//   - ugs              (underground gas storage, capacityTwh)
//   - spr              (strategic petroleum reserve sites, capacityMb)
//   - lng_export       (LNG liquefaction + export terminals, capacityMtpa)
//   - lng_import       (LNG regasification + import terminals, capacityMtpa)
//   - crude_tank_farm  (commercial crude storage hubs, capacityMb)
//
// Schema + evidence model documented in docs/methodology/storage.mdx.
// Public badge (operational | reduced | offline | disputed) is DERIVED at
// read-time server-side from the evidence bundle — identical pattern as
// pipelines. See src/shared/storage-evidence.ts (upcoming, Day 10).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STORAGE_FACILITIES_CANONICAL_KEY = 'energy:storage-facilities:v1';
// Registry is near-static — weekly cron with 3× TTL cushion.
export const STORAGE_FACILITIES_TTL_SECONDS = 21 * 24 * 3600;

const VALID_PHYSICAL_STATES = new Set([
  'operational', 'reduced', 'offline', 'under_construction', 'unknown',
]);
const VALID_COMMERCIAL_STATES = new Set([
  'under_contract', 'expired', 'suspended', 'unknown',
]);
const VALID_SOURCES = new Set([
  'operator', 'regulator', 'press', 'satellite', 'ais-relay',
]);
const VALID_FACILITY_TYPES = new Set([
  'ugs', 'spr', 'lng_export', 'lng_import', 'crude_tank_farm',
]);

// Capacity unit pairings per facility type.
// ugs   → capacityTwh (TWh working gas volume)
// spr / crude_tank_farm → capacityMb (million barrels)
// lng_export / lng_import → capacityMtpa (million tonnes per annum)
const CAPACITY_FIELD_BY_TYPE = {
  ugs: { field: 'capacityTwh', unit: 'TWh' },
  spr: { field: 'capacityMb', unit: 'Mb' },
  crude_tank_farm: { field: 'capacityMb', unit: 'Mb' },
  lng_export: { field: 'capacityMtpa', unit: 'Mtpa' },
  lng_import: { field: 'capacityMtpa', unit: 'Mtpa' },
};

const MIN_FACILITIES = 15;

function loadRegistry() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(resolve(__dirname, 'data', 'storage-facilities.json'), 'utf-8');
  return JSON.parse(raw);
}

/**
 * @param {unknown} data
 * @returns {boolean}
 */
export function validateRegistry(data) {
  if (!data || typeof data !== 'object') return false;
  const obj = /** @type {Record<string, unknown>} */ (data);
  if (!obj.facilities || typeof obj.facilities !== 'object') return false;
  const facilities = /** @type {Record<string, any>} */ (obj.facilities);
  const entries = Object.entries(facilities);
  if (entries.length < MIN_FACILITIES) return false;

  const seenIds = new Set();
  for (const [key, f] of entries) {
    if (seenIds.has(key)) return false;
    seenIds.add(key);
    if (f.id !== key) return false;
    if (typeof f.name !== 'string' || f.name.length === 0) return false;
    if (typeof f.operator !== 'string') return false;
    if (!VALID_FACILITY_TYPES.has(f.facilityType)) return false;
    if (typeof f.country !== 'string' || !/^[A-Z]{2}$/.test(f.country)) return false;

    if (!f.location || typeof f.location.lat !== 'number' || typeof f.location.lon !== 'number') return false;
    if (!isValidLatLon(f.location.lat, f.location.lon)) return false;

    // Capacity must match facility-type pairing.
    const pairing = CAPACITY_FIELD_BY_TYPE[/** @type {keyof typeof CAPACITY_FIELD_BY_TYPE} */ (f.facilityType)];
    if (!pairing) return false;
    const capVal = f[pairing.field];
    if (typeof capVal !== 'number' || !(capVal > 0)) return false;
    if (f.workingCapacityUnit !== pairing.unit) return false;

    if (typeof f.inService !== 'number' || !Number.isInteger(f.inService)) return false;
    if (f.inService < 1900 || f.inService > 2100) return false;

    if (!f.evidence || typeof f.evidence !== 'object') return false;
    const ev = f.evidence;
    if (!VALID_PHYSICAL_STATES.has(ev.physicalState)) return false;
    if (!VALID_SOURCES.has(ev.physicalStateSource)) return false;
    if (!VALID_COMMERCIAL_STATES.has(ev.commercialState)) return false;
    if (!Array.isArray(ev.sanctionRefs)) return false;
    if (typeof ev.fillDisclosed !== 'boolean') return false;
    if (ev.fillDisclosed && typeof ev.fillSource !== 'string') return false;
    if (typeof ev.lastEvidenceUpdate !== 'string') return false;
    if (typeof ev.classifierVersion !== 'string') return false;
    if (typeof ev.classifierConfidence !== 'number' ||
        ev.classifierConfidence < 0 || ev.classifierConfidence > 1) return false;

    // Any non-operational badge requires supporting evidence — same rule as
    // pipelines. Prevents shipping an 'offline' label with zero signal.
    if (ev.physicalState !== 'operational') {
      const hasEvidence =
        ev.operatorStatement != null ||
        ev.sanctionRefs.length > 0 ||
        ev.physicalStateSource === 'ais-relay' ||
        ev.physicalStateSource === 'satellite' ||
        ev.physicalStateSource === 'press';
      if (!hasEvidence) return false;
    }
  }
  return true;
}

function isValidLatLon(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) &&
         lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
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
  return Object.keys(data?.facilities ?? {}).length;
}

/**
 * @param {any} data
 * @returns {number}
 */
export function declareRecords(data) {
  return recordCount(data);
}

// maxStaleMin: weekly cron (7d = 10_080 min) × 2 headroom = 20_160 min.
export const MAX_STALE_MIN = 20_160;
