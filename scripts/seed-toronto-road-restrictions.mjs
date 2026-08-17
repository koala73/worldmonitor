#!/usr/bin/env node
// Runs as the Toronto-Roads member of seed-bundle-canada (#6711), not as its own
// Railway service. Gated on intervalMs 2h, NOT the 15min the other road members
// use: the body is 3.62MB and these are construction permits, not live incidents,
// so */15 cost 348 MB/day for data that changes on a permit desk's schedule.
// Seeder for City of Toronto CART v3 road restrictions.
// Do not add Canada loops to ais-relay.cjs. Separate host/licence/schema from Ontario 511.

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
import {
  fetchTorontoRoadRestrictions,
  declareTorontoRoadRecords,
  validateTorontoRoadEnvelope,
} from './lib/toronto-road-restrictions.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'infra:toronto-roads:v1';
// 6h ≥ 3× the 2h seed-bundle-canada member interval. This MUST stay above that
// interval, not merely above the old */15 cron: at the previous 5400 (90 min)
// the key expired 30 minutes before the next write, so the layer went blank for
// a quarter of every cycle. The cadence and this TTL have to move together.
const CACHE_TTL = 21600;

async function fetchTorontoRoads() {
  return fetchTorontoRoadRestrictions({ userAgent: CHROME_UA });
}

runSeed('infra', 'toronto-roads', CANONICAL_KEY, fetchTorontoRoads, {
  validateFn: validateTorontoRoadEnvelope,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'toronto-roads-v1',
  declareRecords: declareTorontoRoadRecords,
  zeroIsValid: true,
  schemaVersion: 1,
  maxStaleMin: 45,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
