// @ts-check
//
// Shared utility module for the oil & gas pipeline registries used by the
// Energy Atlas. NOT an entry point — see seed-pipelines-gas.mjs and
// seed-pipelines-oil.mjs for the two runSeed invocations. These are split
// because runSeed() hard-exits the process on its terminal paths (_seed-utils
// has ~9 process.exit sites), so two runSeed calls in one process would leave
// the second key unwritten.
//
// Data is hand-curated in scripts/data/pipelines-{gas,oil}.json.
// Schema + evidence model documented in docs/methodology/pipelines.mdx.
//
// Public badge is DERIVED server-side from the evidence bundle. We publish
// the raw evidence here; the derivation lives in the supply-chain handler
// (upcoming). See §4 of the Global Energy Flow parity plan for why we do
// not publish bare conclusion labels.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GAS_CANONICAL_KEY = 'energy:pipelines:gas:v1';
export const OIL_CANONICAL_KEY = 'energy:pipelines:oil:v1';
// Per §13.2 of the parity plan: registry fields (geometry/operator/capacity)
// target freshness = 35 days. TTL is 3× interval = weekly refresh.
// Cron interval is 7 days; TTL=21d means a missed cycle still leaves data
// readable. Registry is near-static; badge derivation happens at read time.
export const PIPELINES_TTL_SECONDS = 21 * 24 * 3600;

const VALID_PHYSICAL_STATES = new Set(['flowing', 'reduced', 'offline', 'unknown']);
const VALID_COMMERCIAL_STATES = new Set(['under_contract', 'expired', 'suspended', 'unknown']);
// `gem` covers rows imported from Global Energy Monitor's Oil & Gas
// Infrastructure Trackers (CC-BY 4.0). Treated as an evidence-bearing source
// for non-flowing badges in the same way as `press` / `satellite` / `ais-relay`,
// since GEM is an academic/curated dataset with traceable provenance — not a
// silent default. Exported alongside VALID_OIL_PRODUCT_CLASSES so test suites
// can assert against the same source of truth the validator uses.
export const VALID_SOURCES = new Set(['operator', 'regulator', 'press', 'satellite', 'ais-relay', 'gem']);
// Required on every oil pipeline. `crude` = crude-oil lines (default),
// `products` = refined-product lines (gasoline/diesel/jet), `mixed` =
// dual-use bridges moving both. Gas pipelines don't carry this field
// (commodity is its own class). Exported so the test suite can assert
// against the SAME source of truth the validator uses — otherwise an
// inline copy in tests could silently drift when the enum is extended.
export const VALID_OIL_PRODUCT_CLASSES = new Set(['crude', 'products', 'mixed']);

// Minimum viable registry size. Post-GEM-import floor: 200. Live counts after
// the 2025-11 GGIT + 2025-03 GOIT merge are 297 gas / 334 oil; 200 leaves ~100
// rows of jitter headroom so a partial GEM re-import or a coverage-narrowing
// release fails loud rather than silently halving the registry.
const MIN_PIPELINES_PER_REGISTRY = 200;

function loadRegistry(filename) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(resolve(__dirname, 'data', filename), 'utf-8');
  return JSON.parse(raw);
}

/**
 * @param {unknown} data
 * @returns {boolean}
 */
export function validateRegistry(data) {
  if (!data || typeof data !== 'object') return false;
  const obj = /** @type {Record<string, unknown>} */ (data);
  if (!obj.pipelines || typeof obj.pipelines !== 'object') return false;
  const pipelines = /** @type {Record<string, any>} */ (obj.pipelines);
  const entries = Object.entries(pipelines);
  if (entries.length < MIN_PIPELINES_PER_REGISTRY) return false;

  const seenIds = new Set();
  for (const [key, p] of entries) {
    if (seenIds.has(key)) return false;
    seenIds.add(key);
    if (p.id !== key) return false;
    if (typeof p.name !== 'string' || p.name.length === 0) return false;
    if (typeof p.operator !== 'string') return false;
    if (p.commodityType !== 'oil' && p.commodityType !== 'gas') return false;
    // Oil pipelines must declare a productClass from the enum; gas pipelines
    // must NOT carry one (commodity is its own class there).
    if (p.commodityType === 'oil') {
      if (!VALID_OIL_PRODUCT_CLASSES.has(p.productClass)) return false;
    } else if (p.productClass !== undefined) {
      return false;
    }
    if (typeof p.fromCountry !== 'string' || !/^[A-Z]{2}$/.test(p.fromCountry)) return false;
    if (typeof p.toCountry !== 'string' || !/^[A-Z]{2}$/.test(p.toCountry)) return false;
    if (!Array.isArray(p.transitCountries)) return false;
    for (const t of p.transitCountries) {
      if (typeof t !== 'string' || !/^[A-Z]{2}$/.test(t)) return false;
    }
    const hasCapacity =
      (p.commodityType === 'gas' && typeof p.capacityBcmYr === 'number' && p.capacityBcmYr > 0) ||
      (p.commodityType === 'oil' && typeof p.capacityMbd === 'number' && p.capacityMbd > 0);
    if (!hasCapacity) return false;

    if (!p.startPoint || typeof p.startPoint.lat !== 'number' || typeof p.startPoint.lon !== 'number') return false;
    if (!p.endPoint || typeof p.endPoint.lat !== 'number' || typeof p.endPoint.lon !== 'number') return false;
    if (!isValidLatLon(p.startPoint.lat, p.startPoint.lon)) return false;
    if (!isValidLatLon(p.endPoint.lat, p.endPoint.lon)) return false;
    // Reject degenerate routes where startPoint == endPoint. PR #3406 review
    // surfaced 9 GEM rows (incl. Trans-Alaska, Enbridge Line 3, Ichthys)
    // whose source GeoJSON had a Point geometry or a single-coord LineString,
    // producing zero-length pipelines that render as map-point artifacts and
    // skew aggregate-length statistics. Defense in depth — converter also
    // drops these — but the validator gate makes the contract explicit.
    if (p.startPoint.lat === p.endPoint.lat && p.startPoint.lon === p.endPoint.lon) return false;

    if (!p.evidence || typeof p.evidence !== 'object') return false;
    const ev = p.evidence;
    if (!VALID_PHYSICAL_STATES.has(ev.physicalState)) return false;
    if (!VALID_SOURCES.has(ev.physicalStateSource)) return false;
    if (!VALID_COMMERCIAL_STATES.has(ev.commercialState)) return false;
    if (!Array.isArray(ev.sanctionRefs)) return false;
    if (typeof ev.lastEvidenceUpdate !== 'string') return false;
    if (typeof ev.classifierVersion !== 'string') return false;
    if (typeof ev.classifierConfidence !== 'number' ||
        ev.classifierConfidence < 0 || ev.classifierConfidence > 1) return false;

    // Every non-`flowing` badge requires at least one evidence field with signal.
    // This prevents shipping an `offline` label with zero supporting evidence.
    // `gem` joins the evidence-bearing sources because GEM is a curated
    // academic dataset with traceable provenance, not a silent default.
    if (ev.physicalState !== 'flowing') {
      const hasEvidence =
        ev.operatorStatement != null ||
        ev.sanctionRefs.length > 0 ||
        ev.physicalStateSource === 'ais-relay' ||
        ev.physicalStateSource === 'satellite' ||
        ev.physicalStateSource === 'press' ||
        ev.physicalStateSource === 'gem';
      if (!hasEvidence) return false;
    }
  }
  return true;
}

function isValidLatLon(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) &&
         lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

export function buildGasPayload() {
  const registry = loadRegistry('pipelines-gas.json');
  return { ...registry, updatedAt: new Date().toISOString() };
}

export function buildOilPayload() {
  const registry = loadRegistry('pipelines-oil.json');
  return { ...registry, updatedAt: new Date().toISOString() };
}

/**
 * @param {any} data
 * @returns {number}
 */
export function recordCount(data) {
  return Object.keys(data?.pipelines ?? {}).length;
}

/**
 * @param {any} data
 * @returns {number}
 */
export function declareRecords(data) {
  return recordCount(data);
}

// maxStaleMin per health-maxstalemin-write-cadence skill: registry cron runs
// weekly (7 days = 10_080 min). 2× cadence = 20_160 min. Registry fields are
// slow-moving so a 2× headroom is sufficient.
export const MAX_STALE_MIN = 20_160;
