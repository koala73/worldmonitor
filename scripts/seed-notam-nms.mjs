#!/usr/bin/env node
/**
 * FAA NOTAM Management Service (NMS-API) seeder.
 *
 * Writes:
 *   aviation:notam:airspace:v1        — active + next-24h airspace restrictions
 *                                       (TFRs, restricted/danger/prohibited areas,
 *                                       airspace closures) for the map layer
 *   aviation:notam:nms:closures:v1    — aerodrome closures/restrictions worldwide;
 *                                       seed-aviation.mjs merges them into
 *                                       aviation:notam:closures:v2
 *   notam:nms:state:v1 (internal)     — compact relevant NOTAMs + delta cursor
 *
 * NMS rate limits (FAQ, production): one delta pull every 3 minutes and one
 * bulk load every 24 hours. The bulk files are ~130 MB of JSON for ~80k active
 * NOTAMs, so the seeder never mirrors NMS. It keeps only the NOTAMs that feed
 * the two outputs, refreshes them from a delta pull each run, and re-syncs from
 * the four classification files at most once per FULL_LOAD_MIN_INTERVAL_MS
 * (guarded by its own key, so a lost state key cannot burn the bulk allowance).
 *
 * Non-production hosts (NMS_API_HOST pointing at FIT or staging) run as a dry
 * run unless NMS_ALLOW_NONPROD_WRITE=1: pre-prod carries the FAA's test NOTAMs
 * ("AUTOMATED TEST TEXT" closures at KJFK), which must never reach airport
 * alerts or notam_closure notifications.
 */

import { gunzipSync } from 'node:zlib';
import { CHROME_UA, loadEnvFile, markPreservableFetchFailure, readCanonicalValue, runSeed } from './_seed-utils.mjs';
import { encodeGzipPayload } from './_seed-payload-codec.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import { NMS_CLOSURES_KEY, applyFeatures, buildAirspace, buildClosures, pruneExpired } from './lib/nms-notam.mjs';

loadEnvFile(import.meta.url);

export const NMS_PROD_HOST = 'https://api-nms.aim.faa.gov';
export const AIRSPACE_KEY = 'aviation:notam:airspace:v1';
export const CLOSURES_KEY = NMS_CLOSURES_KEY;
export const CLOSURES_META_KEY = 'seed-meta:aviation:notam-nms-closures';
export const STATE_KEY = 'notam:nms:state:v1';
export const FULL_LOAD_GUARD_KEY = 'notam:nms:full-load-at:v1';
// No TTL: api/health.js ACTIVATION_MARKERS keeps both NMS keys soft
// (EMPTY_ON_DEMAND) until the first real publish, i.e. until production
// NMS credentials are deployed. After that, missing data alarms normally.
export const ACTIVATION_KEY = 'seed-activated:aviation:notam-nms:v1';
export const CLASSIFICATIONS = Object.freeze(['FDC', 'DOMESTIC', 'INTERNATIONAL', 'MILITARY']);

// Cron runs every 5 minutes. Health calls the data stale after 4 missed ticks;
// the TTL outlives that so a late run reads STALE_SEED, not EMPTY.
const CACHE_TTL = 3600;
export const MAX_STALE_MIN = 20;
const STATE_TTL = 3 * 86_400;
// Slightly under 24h so a daily resync does not drift later every day, while
// staying inside "one bulk load every 24 hours".
export const FULL_LOAD_MIN_INTERVAL_MS = 23.5 * 3600_000;
// lastUpdatedDate is capped at 24h back; resync before the cursor gets there.
export const DELTA_MAX_WINDOW_MS = 23 * 3600_000;
// Re-read a few minutes behind the cursor: a cancelled NOTAM can carry a
// lastUpdated a minute older than the NOTAMC that cancelled it. Upserts are
// idempotent, so the overlap only costs bytes.
export const DELTA_OVERLAP_MS = 5 * 60_000;
// Pre-prod allows 1 request/second; production meters by pull, not by call.
const REQUEST_SPACING_MS = 1_100;
const REQUEST_TIMEOUT_MS = 60_000;
const SOURCE_VERSION = 'faa-nms-api-v1';

export function isProductionHost(host) {
  return String(host || '').replace(/\/+$/, '') === NMS_PROD_HOST;
}

function nmsTime(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Minimal NMS-API client. Authenticates once per run (tokens last 30 minutes
 * and a run takes seconds) and spaces calls to respect pre-prod's 1 req/s.
 */
export function createNmsClient({ host, clientId, clientSecret, fetchImpl = (...args) => globalThis.fetch(...args), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const base = String(host).replace(/\/+$/, '');
  let token = null;
  let lastCallAt = 0;

  async function spaced(url, init) {
    const wait = lastCallAt + REQUEST_SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    return fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }

  async function authenticate() {
    const resp = await spaced(`${base}/v1/auth/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': CHROME_UA,
      },
      body: 'grant_type=client_credentials',
    });
    const body = await resp.json().catch(() => null);
    // invalid_client is a credential problem, not an outage: let it crash loudly.
    if (resp.status === 401 || body?.ErrorCode === 'invalid_client') throw new Error(`NMS auth rejected (HTTP ${resp.status}): check NOTAM_KEY / NOTAM_SECRET`);
    if (!resp.ok || typeof body?.access_token !== 'string') throw markPreservableFetchFailure(new Error(`NMS auth failed: HTTP ${resp.status}`));
    token = body.access_token;
  }

  async function get(path, headers = {}) {
    if (!token) await authenticate();
    const resp = await spaced(`${base}/nmsapi${path}`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': CHROME_UA, ...headers },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      const err = new Error(`NMS GET ${path.split('?')[0]} HTTP ${resp.status}: ${text.slice(0, 160)}`);
      throw resp.status >= 500 || resp.status === 408 || resp.status === 429 ? markPreservableFetchFailure(err) : err;
    }
    return resp;
  }

  async function getNotamJson(query) {
    const resp = await get(`/v1/notams?${query}`, { nmsResponseFormat: 'GEOJSON' });
    const body = await resp.json();
    if (body?.status !== 'Success' || !Array.isArray(body?.data?.geojson)) {
      throw markPreservableFetchFailure(new Error(`NMS notams?${query.split('=')[0]} returned ${body?.status || 'no status'} without a geojson array`));
    }
    return body.data.geojson;
  }

  return {
    /** NOTAMs created, updated or cancelled since `sinceMs` (active and inactive). */
    async delta(sinceMs) {
      return getNotamJson(`lastUpdatedDate=${encodeURIComponent(nmsTime(sinceMs))}`);
    },
    /** Every active NOTAM of one classification, from the gzipped bulk file. */
    async classification(cls) {
      const pointer = await get(`/v1/notams?classification=${cls}&allowRedirect=false`, { nmsResponseFormat: 'GEOJSON' });
      const url = (await pointer.json())?.data?.url;
      if (typeof url !== 'string' || !url.startsWith('/nmsapi/')) {
        throw markPreservableFetchFailure(new Error(`NMS classification ${cls} returned no content path`));
      }
      const content = await get(url.slice('/nmsapi'.length));
      const raw = Buffer.from(await content.arrayBuffer());
      const json = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
      const features = JSON.parse(json.toString('utf8'));
      if (!Array.isArray(features)) throw markPreservableFetchFailure(new Error(`NMS classification ${cls} file is not a feature array`));
      return features;
    },
  };
}

/**
 * Bring `state` up to date. Pure apart from the injected client, so tests
 * drive every branch (cold start, delta, resync, guard-blocked resync).
 *
 * @param {object} args
 * @param {{ cursor: number, fullLoadAt: number, items: Record<string, object> } | null} args.state
 * @param {number | null} args.lastFullLoadAt from FULL_LOAD_GUARD_KEY
 * @param {(at: number) => Promise<void>} args.markFullLoad persists the guard BEFORE the bulk pull
 * @returns {Promise<{ state: object, mode: 'full' | 'delta', stats: object }>}
 */
export async function syncState({ state, lastFullLoadAt, markFullLoad, client, nowMs = Date.now(), log = console.log }) {
  const fullLoadAllowed = lastFullLoadAt === null || nowMs - lastFullLoadAt >= FULL_LOAD_MIN_INTERVAL_MS;
  const needsFullLoad = !state || nowMs - state.cursor > DELTA_MAX_WINDOW_MS || nowMs - state.fullLoadAt >= FULL_LOAD_MIN_INTERVAL_MS;

  if (needsFullLoad && fullLoadAllowed) {
    // Claim the daily allowance first: a crash mid-download must not let the
    // next tick pull the bulk files again.
    await markFullLoad(nowMs);
    const items = {};
    const stats = { mode: 'full' };
    for (const cls of CLASSIFICATIONS) {
      const features = await client.classification(cls);
      stats[cls] = { features: features.length, ...applyFeatures(items, features, nowMs) };
    }
    // The bulk files are snapshots cut a few minutes before download; the next
    // delta re-reads from before the run started to cover the gap.
    return { state: { cursor: nowMs - DELTA_OVERLAP_MS, fullLoadAt: nowMs, items }, mode: 'full', stats };
  }

  if (needsFullLoad && !state) {
    // Cold start inside the bulk allowance window (state key lost after a
    // resync). Build what the 24h delta window can see; the next allowed
    // resync fills in NOTAMs issued earlier.
    log(`[NMS] state missing and bulk load used ${Math.round((nowMs - lastFullLoadAt) / 60_000)}min ago — rebuilding from a 23h delta`);
    state = { cursor: nowMs - DELTA_MAX_WINDOW_MS, fullLoadAt: lastFullLoadAt, items: {} };
  } else if (needsFullLoad) {
    log(`[NMS] resync due but bulk load used ${Math.round((nowMs - lastFullLoadAt) / 60_000)}min ago — continuing on deltas`);
  }

  const since = Math.max(state.cursor - DELTA_OVERLAP_MS, nowMs - DELTA_MAX_WINDOW_MS);
  const features = await client.delta(since);
  const items = { ...state.items };
  const applied = applyFeatures(items, features, nowMs);
  const expired = pruneExpired(items, nowMs);
  return {
    state: { cursor: nowMs, fullLoadAt: state.fullLoadAt, items },
    mode: 'delta',
    stats: { mode: 'delta', since: nmsTime(since), features: features.length, ...applied, expired },
  };
}

export function buildPayload(state, nowMs) {
  const notams = buildAirspace(state.items, nowMs);
  const closures = buildClosures(state.items, nowMs);
  return {
    generatedAt: nowMs,
    source: 'FAA NMS',
    notams,
    closures: { ...closures, generatedAt: nowMs },
  };
}

function isValidState(value) {
  return value && typeof value === 'object' && Number.isFinite(value.cursor) && Number.isFinite(value.fullLoadAt)
    && value.items && typeof value.items === 'object' && !Array.isArray(value.items);
}

async function readState() {
  // strict: a Redis blip must fail the run, not read as "no state" and spend
  // the daily bulk allowance on a resync.
  const raw = await readCanonicalValue(STATE_KEY, { strict: true });
  if (raw === null || raw === undefined) return null;
  if (!isValidState(raw)) {
    console.warn('[NMS] stored state is malformed — treating as missing');
    return null;
  }
  return raw;
}

async function readLastFullLoadAt() {
  const value = await readCanonicalValue(FULL_LOAD_GUARD_KEY, { strict: true });
  const at = Number(value);
  return value === null || value === undefined || !Number.isFinite(at) ? null : at;
}

function requireCreds() {
  const creds = getOptionalUpstashCreds();
  if (!creds) throw new Error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set');
  return creds;
}

async function writeFullLoadGuard(at) {
  await upstashCommand(requireCreds(), ['SET', FULL_LOAD_GUARD_KEY, String(at), 'EX', STATE_TTL]);
}

async function writeState(state) {
  await upstashCommand(requireCreds(), ['SET', STATE_KEY, encodeGzipPayload(JSON.stringify(state)), 'EX', STATE_TTL]);
}

function validate(data) {
  return Array.isArray(data?.notams) && Array.isArray(data?.closures?.closedIcaos) && Array.isArray(data?.closures?.restrictedIcaos);
}

function summarize(result, payload) {
  const kinds = {};
  for (const n of payload.notams) kinds[n.kind] = (kinds[n.kind] || 0) + 1;
  return `${result.mode} sync ${JSON.stringify(result.stats)} → ${Object.keys(result.state.items).length} tracked, `
    + `${payload.notams.length} airspace ${JSON.stringify(kinds)}, `
    + `${payload.closures.closedIcaos.length} closed / ${payload.closures.restrictedIcaos.length} restricted aerodromes`;
}

async function main() {
  const host = (process.env.NMS_API_HOST || NMS_PROD_HOST).replace(/\/+$/, '');
  const clientId = process.env.NOTAM_KEY;
  const clientSecret = process.env.NOTAM_SECRET;
  if (!clientId || !clientSecret) {
    console.log('[NMS] NOTAM_KEY / NOTAM_SECRET not set — skipping');
    process.exit(0);
  }
  const client = createNmsClient({ host, clientId, clientSecret });
  const nonProd = !isProductionHost(host);

  if (nonProd && process.env.NMS_ALLOW_NONPROD_WRITE !== '1') {
    // Dry run: no Redis reads or writes, so every run is a bulk load. Pre-prod
    // allows that; production never takes this branch.
    const nowMs = Date.now();
    const result = await syncState({ state: null, lastFullLoadAt: null, markFullLoad: async () => {}, client, nowMs });
    const payload = buildPayload(result.state, nowMs);
    console.log(`[NMS] DRY RUN against ${host}: ${summarize(result, payload)}`);
    console.log('[NMS] Set NMS_ALLOW_NONPROD_WRITE=1 to publish pre-prod data.');
    process.exit(0);
  }

  let nextState = null;
  return runSeed('aviation', 'notam-airspace', AIRSPACE_KEY, async () => {
    const nowMs = Date.now();
    const [state, lastFullLoadAt] = await Promise.all([readState(), readLastFullLoadAt()]);
    const result = await syncState({ state, lastFullLoadAt, markFullLoad: writeFullLoadGuard, client, nowMs });
    nextState = result.state;
    const payload = buildPayload(result.state, nowMs);
    console.log(`[NMS] ${nonProd ? `(non-prod ${host}) ` : ''}${summarize(result, payload)}`);
    return payload;
  }, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    lockTtlMs: 300_000,
    sourceVersion: SOURCE_VERSION,
    schemaVersion: 1,
    declareRecords: (data) => data.notams.length,
    zeroIsValid: true,
    maxStaleMin: MAX_STALE_MIN,
    allowPreservedFetchFailure: true,
    publishTransform: ({ generatedAt, source, notams }) => ({ generatedAt, source, notams }),
    extraKeys: [{
      key: CLOSURES_KEY,
      ttl: CACHE_TTL,
      transform: (data) => data.closures,
      declareRecords: (closures) => closures.closedIcaos.length + closures.restrictedIcaos.length,
      metaKey: CLOSURES_META_KEY,
    }],
    // State advances only after both outputs published: a failed publish
    // re-reads the same delta window next tick.
    afterPublish: async () => {
      if (nextState) await writeState(nextState);
      await upstashCommand(requireCreds(), ['SET', ACTIVATION_KEY, '1']);
    },
  });
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ''));
if (isMain) main().catch((err) => {
  const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + cause);
  process.exit(1);
});
