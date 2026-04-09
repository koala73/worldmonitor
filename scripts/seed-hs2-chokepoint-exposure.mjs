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

loadEnvFile(import.meta.url);

// ── Constants ─────────────────────────────────────────────────────────────────

/** @type {string} */
export const META_KEY = 'seed-meta:supply_chain:chokepoint-exposure';
/** @type {string} */
export const KEY_PREFIX = 'supply-chain:exposure:';
/** @type {number} */
export const TTL_SECONDS = 172800; // 48h — 2× daily cron interval
const LOCK_DOMAIN = 'supply_chain:chokepoint-exposure';
const LOCK_TTL_MS = 5 * 60 * 1000;

// HS2 chapters to pre-seed. '27' = energy/mineral fuels (primary use case).
const HS2_CODES = ['27'];

// Lightweight copy of the chokepoint registry fields needed for exposure computation.
// Kept in sync with src/config/chokepoint-registry.ts — update both together.
/** @type {Array<{id: string, displayName: string, routeIds: string[], shockModelSupported: boolean}>} */
const CHOKEPOINT_REGISTRY = [
  { id: 'suez',            displayName: 'Suez Canal',            shockModelSupported: true,  routeIds: ['china-europe-suez','china-us-east-suez','gulf-europe-oil','qatar-europe-lng','singapore-med','india-europe'] },
  { id: 'malacca_strait',  displayName: 'Strait of Malacca',     shockModelSupported: true,  routeIds: ['china-europe-suez','china-us-east-suez','gulf-asia-oil','qatar-asia-lng','india-se-asia','china-africa','cpec-route'] },
  { id: 'hormuz_strait',   displayName: 'Strait of Hormuz',      shockModelSupported: true,  routeIds: ['gulf-europe-oil','gulf-asia-oil','qatar-europe-lng','qatar-asia-lng','gulf-americas-cape'] },
  { id: 'bab_el_mandeb',   displayName: 'Bab el-Mandeb',         shockModelSupported: true,  routeIds: ['china-europe-suez','china-us-east-suez','gulf-europe-oil','qatar-europe-lng','singapore-med','india-europe'] },
  { id: 'panama',          displayName: 'Panama Canal',          shockModelSupported: false, routeIds: ['china-us-east-panama','panama-transit'] },
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

const require = createRequire(import.meta.url);
/** @type {Record<string, {nearestRouteIds: string[], coastSide: string}>} */
const COUNTRY_PORT_CLUSTERS = require('./shared/country-port-clusters.json');

// ── Exposure computation ──────────────────────────────────────────────────────

/**
 * @param {string[]} nearestRouteIds
 * @param {string} coastSide
 * @param {string} hs2
 * @returns {{ exposures: object[], primaryChokepointId: string, vulnerabilityIndex: number }}
 */
function computeExposure(nearestRouteIds, coastSide, hs2) {
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

  // Attach coastSide to top entry only
  if (entries[0]) entries[0] = { ...entries[0], coastSide };

  const weights = [0.5, 0.3, 0.2];
  const vulnerabilityIndex = Math.round(
    entries.slice(0, 3).reduce((sum, e, i) => sum + e.exposureScore * weights[i], 0) * 10,
  ) / 10;

  return {
    exposures: entries,
    primaryChokepointId: entries[0]?.chokepointId ?? '',
    vulnerabilityIndex,
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

// ── Main ──────────────────────────────────────────────────────────────────────

export async function main() {
  const startedAt = Date.now();
  const runId = `${LOCK_DOMAIN}:${startedAt}`;
  const lock = await acquireLockSafely(LOCK_DOMAIN, runId, LOCK_TTL_MS, { label: LOCK_DOMAIN });

  if (lock.skipped) {
    const allKeys = Object.keys(COUNTRY_PORT_CLUSTERS)
      .filter(k => k !== '_comment' && k.length === 2)
      .flatMap(iso2 => HS2_CODES.map(hs2 => `${KEY_PREFIX}${iso2}:${hs2}:v1`));
    await extendExistingTtl([...allKeys, META_KEY], TTL_SECONDS)
      .catch(e => console.warn('[chokepoint-exposure] TTL extension (skipped) failed:', e.message));
    return;
  }
  if (!lock.locked) {
    console.log('[chokepoint-exposure] Lock held, skipping');
    return;
  }

  /** @param {number} count @param {string} [status] */
  const writeMeta = async (count, status = 'ok') => {
    const meta = JSON.stringify({ fetchedAt: Date.now(), recordCount: count, status });
    await redisPipeline([['SET', META_KEY, meta, 'EX', TTL_SECONDS * 3]])
      .catch(e => console.warn('[chokepoint-exposure] Failed to write seed-meta:', e.message));
  };

  try {
    const countries = Object.entries(COUNTRY_PORT_CLUSTERS).filter(
      ([k]) => k !== '_comment' && k.length === 2,
    );
    console.log(`[chokepoint-exposure] Computing exposure for ${countries.length} countries × ${HS2_CODES.length} HS2 code(s)...`);

    const commands = [];
    let writtenCount = 0;

    for (const hs2 of HS2_CODES) {
      for (const [iso2, cluster] of countries) {
        const result = computeExposure(cluster.nearestRouteIds ?? [], cluster.coastSide ?? '', hs2);
        const payload = JSON.stringify({
          iso2,
          hs2,
          ...result,
          fetchedAt: new Date().toISOString(),
        });
        commands.push(['SET', `${KEY_PREFIX}${iso2}:${hs2}:v1`, payload, 'EX', TTL_SECONDS]);
        writtenCount++;
      }
    }

    // Write seed-meta in same pipeline
    commands.push([
      'SET', META_KEY,
      JSON.stringify({ fetchedAt: Date.now(), recordCount: writtenCount, status: 'ok' }),
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
      ttlH: TTL_SECONDS / 3600,
    });
    console.log(`[chokepoint-exposure] Seeded ${writtenCount} exposure keys`);
  } catch (err) {
    console.error('[chokepoint-exposure] Seed failed:', err.message || err);
    // Extend TTL on failure — stale is better than missing
    const existingKeys = Object.keys(COUNTRY_PORT_CLUSTERS)
      .filter(k => k !== '_comment' && k.length === 2)
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
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
