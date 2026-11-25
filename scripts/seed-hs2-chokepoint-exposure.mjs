#!/usr/bin/env node

// @ts-check

import { createRequire } from 'node:module';
import {
  acquireLockSafely,
  extendExistingTtl,
  getRedisCredentials,
  loadEnvFile,
  logSeedResult,
  releaseLock,
} from './_seed-utils.mjs';
import { bilateralTransitShares, hasModeledSeaRoute } from './shared/bilateral-chokepoint-transit.mjs';

loadEnvFile(import.meta.url);

const require = createRequire(import.meta.url);
const SUPPLY_VULNERABILITY_COMMODITIES = require('./shared/supply-vulnerability-commodities.json');

// ── Constants ─────────────────────────────────────────────────────────────────

/** @type {string} */
export const META_KEY = 'seed-meta:supply_chain:chokepoint-exposure';
/** @type {string} */
export const KEY_PREFIX = 'supply-chain:exposure:';
/** @type {number} */
export const TTL_SECONDS = 172800; // 48h — 2× daily cron interval
const LOCK_DOMAIN = 'supply_chain:chokepoint-exposure';
const LOCK_TTL_MS = 5 * 60 * 1000;
const COMTRADE_KEY_PREFIX = 'comtrade:bilateral-hs4:';

// Top 10 HS2 chapters by global trade volume and strategic importance.
const BASE_HS2_CODES = [
  '27', // Mineral Fuels (energy)
  '84', // Machinery & Mechanical Appliances
  '85', // Electrical Machinery & Electronics
  '87', // Vehicles
  '30', // Pharmaceuticals
  '72', // Iron & Steel
  '39', // Plastics
  '29', // Organic Chemicals
  '10', // Cereals (food security)
  '62', // Apparel (textiles)
];

export const HS2_CODES = Array.from(new Set([
  ...BASE_HS2_CODES,
  ...SUPPLY_VULNERABILITY_COMMODITIES.commodities.map((commodity) => commodity.transitHs2),
])).sort((a, b) => Number(a) - Number(b));

// Lightweight copy of the chokepoint registry fields needed for exposure computation.
// Kept in sync with src/config/chokepoint-registry.ts — update both together.
/** @type {Array<{id: string, displayName: string, routeIds: string[], shockModelSupported: boolean}>} */
const CHOKEPOINT_REGISTRY = [
  { id: 'suez',            displayName: 'Suez Canal',            shockModelSupported: true,  routeIds: ['china-europe-suez','china-us-east-suez','gulf-europe-oil','qatar-europe-lng','singapore-med','india-europe'] },
  { id: 'malacca_strait',  displayName: 'Strait of Malacca',     shockModelSupported: true,  routeIds: ['china-europe-suez','china-us-east-suez','gulf-asia-oil','qatar-asia-lng','india-se-asia','china-africa','cpec-route'] },
  { id: 'hormuz_strait',   displayName: 'Strait of Hormuz',      shockModelSupported: true,  routeIds: ['gulf-europe-oil','gulf-asia-oil','qatar-europe-lng','qatar-asia-lng','gulf-americas-cape'] },
  { id: 'bab_el_mandeb',   displayName: 'Bab el-Mandeb',         shockModelSupported: true,  routeIds: ['china-europe-suez','china-us-east-suez','gulf-europe-oil','qatar-europe-lng','singapore-med','india-europe'] },
  { id: 'panama',          displayName: 'Panama Canal',          shockModelSupported: false, routeIds: ['china-us-east-panama','panama-transit','us-gulf-asia-panama'] },
  { id: 'taiwan_strait',   displayName: 'Taiwan Strait',         shockModelSupported: false, routeIds: ['china-us-west','intra-asia-container'] },
  { id: 'cape_of_good_hope', displayName: 'Cape of Good Hope',   shockModelSupported: false, routeIds: ['brazil-china-bulk','gulf-americas-cape','asia-europe-cape'] },
  { id: 'gibraltar',       displayName: 'Strait of Gibraltar',   shockModelSupported: false, routeIds: ['gulf-europe-oil','singapore-med','india-europe','asia-europe-cape'] },
  { id: 'bosphorus',       displayName: 'Bosporus Strait',       shockModelSupported: false, routeIds: ['russia-med-oil'] },
  { id: 'korea_strait',    displayName: 'Korea Strait',          shockModelSupported: false, routeIds: [] },
  { id: 'dover_strait',    displayName: 'Dover Strait',          shockModelSupported: false, routeIds: [] },
  { id: 'kerch_strait',    displayName: 'Kerch Strait',          shockModelSupported: false, routeIds: [] },
  { id: 'lombok_strait',   displayName: 'Lombok Strait',         shockModelSupported: false, routeIds: [] },
];

// ── Load country-port-clusters ────────────────────────────────────────────────

/** @type {Record<string, {nearestRouteIds: string[], coastSide: string}>} */
const COUNTRY_PORT_CLUSTERS = require('./shared/country-port-clusters.json');
/** @type {Record<string, string>} */
const COUNTRY_REGIONS = require('./shared/iso2-to-region.json');
const TRANSIT_CONTEXT = { clusters: COUNTRY_PORT_CLUSTERS, regions: COUNTRY_REGIONS, chokepoints: CHOKEPOINT_REGISTRY };

// The country universe this seeder writes for. Derived from static config, so it is
// knowable even when a run fails — writeMeta() publishes it on every path so a failed
// seed cannot erase the manifest the scenario worker depends on.
const SEEDED_COUNTRY_IDS = Object.keys(COUNTRY_PORT_CLUSTERS)
  .filter(k => k !== '_comment' && k.length === 2);

// ── Exposure computation ──────────────────────────────────────────────────────

/**
 * @typedef {{ hs4: string, description: string, totalValue: number, topExporters: Array<{partnerCode: number, partnerIso2: string, value: number, share: number}>, year: number }} ComtradeProduct
 */

/**
 * Convert HS4 code to HS2 chapter (matches chokepoint-exposure-utils.ts:hs4ToHs2).
 * @param {string} hs4
 * @returns {string}
 */
function hs4ToHs2(hs4) {
  return String(Number.parseInt(hs4.slice(0, 2), 10));
}

/**
 * Flow-weighted exposure — mirrors chokepoint-exposure-utils.ts:computeFlowWeightedExposures.
 * A supplier's share counts toward a chokepoint only when the bilateral route crosses it.
 * @param {string} importerIso2
 * @param {string} hs2
 * @param {ComtradeProduct[]} products
 * @returns {object[]}
 */
export function computeFlowWeightedExposures(importerIso2, hs2, products) {
  const normalizedHs2 = String(Number.parseInt(hs2, 10));
  const matchingProducts = products.filter(p => hs4ToHs2(p.hs4) === normalizedHs2);

  return computeBilateralExposures(importerIso2, matchingProducts, normalizedHs2 === '27');
}

/** @param {string} importerIso2 @param {ComtradeProduct[]} matchingProducts @param {boolean} [boostEnergy] */
function computeBilateralExposures(importerIso2, matchingProducts, boostEnergy = false) {
  if (matchingProducts.length === 0) return [];
  const totalValue = matchingProducts.reduce((sum, product) => sum + product.totalValue, 0);

  /** @type {Map<string, number>} */
  const cpScores = new Map();
  for (const cp of CHOKEPOINT_REGISTRY) cpScores.set(cp.id, 0);

  let modeled = false;
  for (const product of matchingProducts) {
    const productWeight = totalValue > 0 ? product.totalValue / totalValue : 0;

    for (const exporter of product.topExporters) {
      if (!exporter.partnerIso2) continue;
      if (hasModeledSeaRoute(importerIso2, exporter.partnerIso2, TRANSIT_CONTEXT.clusters)) modeled = true;
      for (const [cpId, fraction] of bilateralTransitShares(importerIso2, exporter.partnerIso2, TRANSIT_CONTEXT)) {
        cpScores.set(cpId, (cpScores.get(cpId) ?? 0) + fraction * exporter.share * productWeight * 100);
      }
    }
  }

  // No supplier pair has a modeled sea route, so zero would be unevaluated rather than measured.
  if (!modeled) return [];

  const entries = CHOKEPOINT_REGISTRY.map(cp => {
    let score = cpScores.get(cp.id) ?? 0;
    if (boostEnergy && cp.shockModelSupported) score *= 1.5;
    score = Math.min(score, 100);
    return {
      chokepointId: cp.id,
      chokepointName: cp.displayName,
      exposureScore: Math.round(score * 10) / 10,
      coastSide: '',
      shockSupported: cp.shockModelSupported,
    };
  });

  return entries.sort((a, b) => b.exposureScore - a.exposureScore);
}

/**
 * Country-level route-based fallback — mirrors chokepoint-exposure-utils.ts:computeFallbackExposures.
 * @param {string[]} nearestRouteIds
 * @param {string} coastSide
 * @param {string} hs2
 * @returns {{ exposures: object[], primaryChokepointId: string, vulnerabilityIndex: number }}
 */
export function computeCountryLevelExposure(nearestRouteIds, coastSide, hs2) {
  const isEnergy = hs2 === '27';
  const routeSet = new Set(nearestRouteIds);

  const entries = CHOKEPOINT_REGISTRY.map(cp => {
    const overlap = cp.routeIds.filter(r => routeSet.has(r)).length;
    const maxRoutes = Math.max(cp.routeIds.length, 1);
    let score = (overlap / maxRoutes) * 100;
    if (isEnergy && cp.shockModelSupported) score = Math.min(score * 1.5, 100);
    return {
      chokepointId: cp.id,
      chokepointName: cp.displayName,
      exposureScore: Math.round(score * 10) / 10,
      shockSupported: cp.shockModelSupported,
    };
  }).sort((a, b) => b.exposureScore - a.exposureScore);

  if (entries[0]) entries[0] = { ...entries[0], coastSide };

  const weights = [0.5, 0.3, 0.2];
  const vulnerabilityIndex = Math.round(
    entries.slice(0, 3).reduce((sum, e, i) => sum + e.exposureScore * weights[i], 0) * 10,
  ) / 10;

  return {
    exposures: entries,
    primaryChokepointId: entries[0]?.exposureScore > 0 ? entries[0].chokepointId : '',
    vulnerabilityIndex,
    coverage: 'country_route_fallback',
  };
}

// ── Redis pipeline helper ─────────────────────────────────────────────────────

/**
 * @param {Array<string[]>} commands
 */
async function redisPipeline(commands) {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Redis pipeline failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }
  return resp.json();
}

// ── Comtrade data loader ─────────────────────────────────────────────────────

/**
 * Batch-read Comtrade bilateral HS4 data for all countries from Redis.
 * @param {string[]} iso2List
 * @returns {Promise<Map<string, ComtradeProduct[]>>}
 */
async function loadComtradeData(iso2List) {
  const keys = iso2List.map(iso2 => `${COMTRADE_KEY_PREFIX}${iso2}:v1`);
  const { url, token } = getRedisCredentials();
  const commands = keys.map(k => ['GET', k]);

  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    console.warn(`[chokepoint-exposure] Comtrade MGET failed: HTTP ${resp.status}`);
    return new Map();
  }

  const results = await resp.json();
  /** @type {Map<string, ComtradeProduct[]>} */
  const map = new Map();
  for (let i = 0; i < iso2List.length; i++) {
    const raw = results[i]?.result;
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.products && Array.isArray(parsed.products)) {
        map.set(iso2List[i], parsed.products);
      }
    } catch { /* skip malformed */ }
  }
  return map;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function main() {
  const startedAt = Date.now();
  const runId = `${LOCK_DOMAIN}:${startedAt}`;
  const lock = await acquireLockSafely(LOCK_DOMAIN, runId, LOCK_TTL_MS, { label: LOCK_DOMAIN });

  if (lock.skipped) {
    const allKeys = SEEDED_COUNTRY_IDS
      .flatMap(iso2 => HS2_CODES.map(hs2 => `${KEY_PREFIX}${iso2}:${hs2}:v1`));
    await extendExistingTtl([...allKeys, META_KEY], TTL_SECONDS)
      .catch(e => console.warn('[chokepoint-exposure] TTL extension (skipped) failed:', e.message));
    return;
  }
  if (!lock.locked) {
    console.log('[chokepoint-exposure] Lock held, skipping');
    return;
  }

  /**
   * Publish seed metadata. The manifest fields describe the country/sector UNIVERSE,
   * which comes from static config and is therefore still true after a failed run —
   * so they are emitted on every path. Only `status` and `recordCount` report the run.
   * Dropping them on the error path would blank the scenario worker (which gates all
   * computation on manifestVersion) even though the exposure keys it reads are
   * deliberately TTL-extended by the same catch block.
   *
   * @param {number} count @param {string} [status]
   */
  const writeMeta = async (count, status = 'ok') => {
    const meta = JSON.stringify({
      fetchedAt: Date.now(),
      recordCount: count,
      status,
      manifestVersion: 1,
      countryIds: SEEDED_COUNTRY_IDS,
      hs2Codes: HS2_CODES,
    });
    await redisPipeline([['SET', META_KEY, meta, 'EX', TTL_SECONDS * 3]])
      .catch(e => console.warn('[chokepoint-exposure] Failed to write seed-meta:', e.message));
  };

  try {
    const countries = Object.entries(COUNTRY_PORT_CLUSTERS).filter(
      ([k]) => k !== '_comment' && k.length === 2,
    );
    const iso2List = SEEDED_COUNTRY_IDS;

    console.log(`[chokepoint-exposure] Loading Comtrade bilateral data for ${iso2List.length} countries...`);
    const comtradeMap = await loadComtradeData(iso2List);
    console.log(`[chokepoint-exposure] Comtrade data loaded for ${comtradeMap.size}/${iso2List.length} countries`);
    console.log(`[chokepoint-exposure] Computing exposure for ${countries.length} countries × ${HS2_CODES.length} HS2 code(s)...`);

    const commands = [];
    let writtenCount = 0;
    let flowWeightedCount = 0;
    let fallbackCount = 0;

    /** @param {object[]} exposures */
    const buildVulnIndex = (exposures) => {
      const weights = [0.5, 0.3, 0.2];
      return Math.round(
        exposures.slice(0, 3).reduce((sum, e, i) => sum + e.exposureScore * weights[i], 0) * 10,
      ) / 10;
    };

    for (const hs2 of HS2_CODES) {
      const mappings = SUPPLY_VULNERABILITY_COMMODITIES.commodities.filter(mapping => mapping.transitHs2 === hs2);
      for (const [iso2, cluster] of countries) {
        const comtradeProducts = comtradeMap.get(iso2);
        let result;

        if (comtradeProducts && comtradeProducts.length > 0) {
          const exposures = computeFlowWeightedExposures(iso2, hs2, comtradeProducts);
          if (exposures.length > 0) {
            const coastSide = cluster.coastSide ?? '';
            exposures[0] = { ...exposures[0], coastSide };
            result = {
              exposures,
              primaryChokepointId: exposures[0].exposureScore > 0 ? exposures[0].chokepointId : '',
              vulnerabilityIndex: buildVulnIndex(exposures),
              coverage: 'flow_weighted',
            };
            flowWeightedCount++;
          } else {
            result = computeCountryLevelExposure(cluster.nearestRouteIds ?? [], cluster.coastSide ?? '', hs2);
            fallbackCount++;
          }
        } else {
          result = computeCountryLevelExposure(cluster.nearestRouteIds ?? [], cluster.coastSide ?? '', hs2);
          fallbackCount++;
        }

        // Commodity values are trade shares expressed as percentages. The HS2
        // energy boost applies only to the chapter's vulnerability index inputs.
        const commodityExposures = {};
        if (comtradeProducts?.length) {
          for (const mapping of mappings) {
            const products = comtradeProducts.filter(product => (
              product.totalValue > 0 && mapping.hs4.includes(product.hs4)
            ));
            const exposures = computeBilateralExposures(iso2, products);
            if (exposures.length > 0) {
              commodityExposures[mapping.id] = Object.fromEntries(
                exposures.map(entry => [entry.chokepointId, entry.exposureScore]),
              );
            }
          }
        }

        const payload = JSON.stringify({
          iso2,
          hs2,
          ...result,
          ...(Object.keys(commodityExposures).length > 0 ? { commodityExposures } : {}),
          fetchedAt: new Date().toISOString(),
        });
        commands.push(['SET', `${KEY_PREFIX}${iso2}:${hs2}:v1`, payload, 'EX', TTL_SECONDS]);
        writtenCount++;
      }
    }

    commands.push([
      'SET', META_KEY,
      JSON.stringify({ fetchedAt: Date.now(), recordCount: writtenCount, status: 'ok', manifestVersion: 1, countryIds: SEEDED_COUNTRY_IDS, hs2Codes: HS2_CODES }),
      'EX', TTL_SECONDS * 3,
    ]);

    const results = await redisPipeline(commands);
    const failures = results.filter(r => r?.error || r?.result === 'ERR');
    if (failures.length > 0) {
      throw new Error(`Redis pipeline: ${failures.length}/${commands.length} commands failed`);
    }

    logSeedResult('supply_chain:chokepoint-exposure', writtenCount, Date.now() - startedAt, {
      countries: countries.length,
      hs2Codes: HS2_CODES,
      flowWeighted: flowWeightedCount,
      fallback: fallbackCount,
      comtradeCountries: comtradeMap.size,
      ttlH: TTL_SECONDS / 3600,
    });
    console.log(`[chokepoint-exposure] Seeded ${writtenCount} keys (${flowWeightedCount} flow-weighted, ${fallbackCount} fallback)`);
  } catch (err) {
    console.error('[chokepoint-exposure] Seed failed:', err.message || err);
    const existingKeys = SEEDED_COUNTRY_IDS
      .flatMap(iso2 => HS2_CODES.map(hs2 => `${KEY_PREFIX}${iso2}:${hs2}:v1`));
    await extendExistingTtl([...existingKeys, META_KEY], TTL_SECONDS)
      .catch(e => console.warn('[chokepoint-exposure] TTL extension failed:', e.message));
    await writeMeta(0, 'error');
    throw err;
  } finally {
    await releaseLock(LOCK_DOMAIN, runId);
  }
}

const isMain = process.argv[1]?.endsWith('seed-hs2-chokepoint-exposure.mjs');
if (isMain) {
  // Terminal success marker. Emitted from .then() so it can ONLY print after main() has fully
  // resolved — a throw anywhere inside, including a late publish step, skips it. Any marker
  // written INSIDE main() would print before later work and could vouch for a run that then
  // died (exactly how #6092 stayed invisible). Format mirrors runSeed() so the crash
  // diagnostic recognises it; without it a clean run is indistinguishable from a silent death.
  const __runStartedAt = Date.now();
  main()
    .then(() => console.log(`\n=== Done (${Date.now() - __runStartedAt}ms) ===`))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
