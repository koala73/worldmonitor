#!/usr/bin/env node

import {
  loadEnvFile,
  CHROME_UA,
  runSeed,
  extendExistingTtl,
  writeExtraKeyWithMeta,
  resolveSeedMetaTtl,
} from './_seed-utils.mjs';
import { COUNTRY_COORDS, mapTrafficAnomaly, toEpochMs } from './lib/radar-country-coords.mjs';

loadEnvFile(import.meta.url);

const CF_RADAR_URL = 'https://api.cloudflare.com/client/v4/radar/annotations/outages';
const CF_RADAR_BASE = 'https://api.cloudflare.com/client/v4';
const CANONICAL_KEY = 'infra:outages:v1';
const DDOS_KEY = 'cf:radar:ddos:v1';
const TRAFFIC_ANOMALIES_KEY = 'cf:radar:traffic-anomalies:v1';
const CACHE_TTL = 10800; // 3h — 6x the 30 min cron interval (was 1x = key expired on any missed run)
const DDOS_TTL = 10800;
// Co-pinned with SEED_META.trafficAnomalies.maxStaleMin (60) in api/health.js:
// the data TTL must STRICTLY exceed that gate. #7876 moved trafficAnomalies into
// MISSING_DATA_IS_FAILURE_KEYS, so an absent payload is now EMPTY (crit) rather
// than OK — and at the old 3600s the key expired at exactly the 60-minute mark
// while health still read the meta as fresh (seedAge is rounded, and the test is
// `> maxStaleMin`). A dead seeder therefore reported crit for ~30s before
// settling into the truthful STALE_SEED warn. 2x the gate restores the ordered
// escalation the DDoS sibling already has at 3h.
const ANOMALIES_TTL = 7200;


function mapOutageSeverity(outageType) {
  if (outageType === 'NATIONWIDE') return 'OUTAGE_SEVERITY_TOTAL';
  if (outageType === 'REGIONAL') return 'OUTAGE_SEVERITY_MAJOR';
  return 'OUTAGE_SEVERITY_PARTIAL';
}


/**
 * Unwrap a Cloudflare Radar success envelope, or throw.
 *
 * Radar reports source-side failures with HTTP 200 and `success: false` plus an
 * `errors` array, so `resp.ok` alone does not mean the body carries data. Every
 * `result.<field> || []` read downstream of an unvalidated envelope silently
 * becomes "the source is quiet" — which is exactly the empty result this seeder
 * now publishes authoritatively. Validating first keeps "confirmed empty" and
 * "failed" distinguishable (issue #7845).
 *
 * A non-array `errors` is rejected rather than ignored: the shape is unknown, so
 * the envelope cannot be read as a confirmed success.
 */
function requireRadarResult(data, source) {
  // Name the specific reason: "not configured" is an account/token-scope problem
  // an operator must fix, "success=false" is usually a transient upstream fault
  // to wait out. One shared message would make a Railway log line say which
  // endpoint failed but not which of those two it was.
  const reason = (() => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return 'body is not a JSON object';
    if (data.configured === false) return 'not configured for this token';
    if (data.success !== true) return `success=${JSON.stringify(data.success)}`;
    if (data.errors != null && !Array.isArray(data.errors)) return 'errors field is not an array';
    if (Array.isArray(data.errors) && data.errors.length > 0) return `errors=${JSON.stringify(data.errors).slice(0, 200)}`;
    if (!data.result || typeof data.result !== 'object' || Array.isArray(data.result)) return 'result is missing or not an object';
    return null;
  })();
  if (reason) throw new Error(`Cloudflare Radar ${source}: invalid success envelope (${reason})`);
  return data.result;
}

/** Require an array-valued result field — an absent one is a failure, not zero records. */
function requireRadarArray(result, field, source) {
  if (!Array.isArray(result[field])) {
    throw new Error(`Cloudflare Radar ${source}: result.${field} is missing or not an array`);
  }
  return result[field];
}

/** Require an object-valued result field (Radar summary maps). */
function requireRadarObject(result, field, source) {
  const value = result[field];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Cloudflare Radar ${source}: result.${field} is missing or not an object`);
  }
  return value;
}

async function fetchOutages() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    console.log('CLOUDFLARE_API_TOKEN not set — skipping');
    process.exit(0);
  }

  const resp = await fetch(`${CF_RADAR_URL}?dateRange=28d&limit=50`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': CHROME_UA,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Cloudflare Radar API error: ${resp.status}`);

  const result = requireRadarResult(await resp.json(), 'outage annotations');
  const annotations = requireRadarArray(result, 'annotations', 'outage annotations');

  const outages = [];
  for (const raw of annotations) {
    if (!raw.locations?.length) continue;
    const countryCode = raw.locations[0];
    if (!countryCode) continue;

    const coords = COUNTRY_COORDS[countryCode];
    if (!coords) continue;

    const countryName = raw.locationsDetails?.[0]?.name ?? countryCode;

    const categories = ['Cloudflare Radar'];
    if (raw.outage?.outageCause) categories.push(raw.outage.outageCause.replace(/_/g, ' '));
    if (raw.outage?.outageType) categories.push(raw.outage.outageType);
    for (const asn of raw.asnsDetails?.slice(0, 2) || []) {
      if (asn.name) categories.push(asn.name);
    }

    outages.push({
      id: `cf-${raw.id}`,
      title: raw.scope ? `${raw.scope} outage in ${countryName}` : `Internet disruption in ${countryName}`,
      link: raw.linkedUrl || 'https://radar.cloudflare.com/outage-center',
      description: raw.description ?? '',
      detectedAt: toEpochMs(raw.startDate),
      country: countryName,
      region: '',
      location: { latitude: coords[0], longitude: coords[1] },
      severity: mapOutageSeverity(raw.outage?.outageType),
      categories,
      cause: raw.outage?.outageCause || '',
      outageType: raw.outage?.outageType || '',
      endedAt: toEpochMs(raw.endDate),
    });
  }

  return { outages, pagination: undefined };
}

/**
 * DDoS slice contract.
 *
 * REQUIRED: `summary/protocol` and `summary/vector`. They are the payload the
 * DDoS panel and RPC are about, and both feed `recordCount`. If either one
 * cannot be confirmed, there is no DDoS result to publish — the whole companion
 * fails and last-good is retained.
 *
 * OPTIONAL: `top/locations/target`. It only decorates the map with target
 * countries. A failure there degrades `topTargetLocations` to empty and is
 * logged, but must not withhold a confirmed protocol/vector summary. Keep this
 * distinction explicit: silently promoting the optional slice to required (or
 * demoting a required one) changes published coverage without changing counts.
 */
async function fetchDdosData(token) {
  const headers = {
    'User-Agent': CHROME_UA,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  // Reports `degraded` rather than just returning [] so the caller can stamp the
  // shortfall on seed-meta. An unconfirmed empty slice riding inside a CONFIRMED
  // payload is the exact conflation this issue is about: without the marker, a
  // permanently 4xx target endpoint would blank the DDoS map's target countries
  // forever while recordCount (protocol+vector) never moves and health stays OK.
  const fetchOptionalTargetLocations = async () => {
    try {
      const resp = await fetch(`${CF_RADAR_BASE}/radar/attacks/layer3/top/locations/target?dateRange=7d`, { headers, signal: AbortSignal.timeout(15_000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const result = requireRadarResult(await resp.json(), 'DDoS target locations');
      return {
        items: requireRadarArray(result, 'top_0', 'DDoS target locations')
          .filter((item) => item && typeof item === 'object' && !Array.isArray(item)),
        degraded: false,
      };
    } catch (err) {
      console.warn(`  CF Radar DDoS target locations unavailable (optional slice): ${err?.message || err}`);
      return { items: [], degraded: true };
    }
  };

  const [protocolResp, vectorResp, targetSlice] = await Promise.all([
    fetch(`${CF_RADAR_BASE}/radar/attacks/layer3/summary/protocol?dateRange=7d`, { headers, signal: AbortSignal.timeout(15_000) }),
    fetch(`${CF_RADAR_BASE}/radar/attacks/layer3/summary/vector?dateRange=7d`, { headers, signal: AbortSignal.timeout(15_000) }),
    fetchOptionalTargetLocations(),
  ]);

  if (!protocolResp.ok || !vectorResp.ok) {
    throw new Error(`CF Radar DDoS API error: protocol=${protocolResp.status} vector=${vectorResp.status}`);
  }

  const [protocolResult, vectorResult] = await Promise.all([
    protocolResp.json().then((data) => requireRadarResult(data, 'DDoS protocol')),
    vectorResp.json().then((data) => requireRadarResult(data, 'DDoS vector')),
  ]);

  function toEntries(summary) {
    return Object.entries(summary).map(([label, pct]) => ({ label, percentage: parseFloat(pct) || 0 }))
      .sort((a, b) => b.percentage - a.percentage);
  }

  const topTargetLocations = targetSlice.items.map((item) => {
    const code = item.clientCountryAlpha2 || '';
    const coords = COUNTRY_COORDS[code] || null;
    return {
      countryCode: code,
      countryName: item.clientCountryName || code,
      percentage: parseFloat(item.value) || 0,
      latitude: coords ? coords[0] : 0,
      longitude: coords ? coords[1] : 0,
    };
  }).filter((item) => item.latitude !== 0 || item.longitude !== 0);

  const meta = protocolResult.meta;
  return {
    protocol: toEntries(requireRadarObject(protocolResult, 'summary_0', 'DDoS protocol')),
    vector: toEntries(requireRadarObject(vectorResult, 'summary_0', 'DDoS vector')),
    dateRangeStart: meta?.dateRange?.[0]?.startTime || '',
    dateRangeEnd: meta?.dateRange?.[0]?.endTime || '',
    topTargetLocations,
    _targetLocationsDegraded: targetSlice.degraded,
  };
}


async function fetchTrafficAnomalies(token) {
  const headers = {
    'User-Agent': CHROME_UA,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const resp = await fetch(`${CF_RADAR_BASE}/radar/traffic_anomalies?dateRange=7d&limit=100`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`CF Radar traffic anomalies API error: ${resp.status}`);

  const result = requireRadarResult(await resp.json(), 'traffic anomalies');
  const raw = requireRadarArray(result, 'trafficAnomalies', 'traffic anomalies');

  const anomalies = raw.map(mapTrafficAnomaly);

  return { anomalies, totalCount: anomalies.length };
}


// The two Radar companion products. Each owns its consumer key, its TTL and its
// own success clock; neither is derived from the canonical outage annotations.
//
// `toPayload` strips producer diagnostics (leading underscore) so the published
// value stays exactly the shape the RPC reads; `metaExtra` carries them onto
// seed-meta instead, where health and an operator can see them.
const COMPANIONS = [
  {
    label: 'DDoS',
    key: DDOS_KEY,
    ttlSeconds: DDOS_TTL,
    fetch: fetchDdosData,
    recordCount: (data) => data.protocol.length + data.vector.length,
    toPayload: ({ _targetLocationsDegraded, ...payload }) => payload,
    metaExtra: (data) => (data._targetLocationsDegraded ? { targetLocationsDegraded: true } : undefined),
  },
  {
    label: 'traffic anomalies',
    key: TRAFFIC_ANOMALIES_KEY,
    ttlSeconds: ANOMALIES_TTL,
    fetch: fetchTrafficAnomalies,
    recordCount: (data) => data.totalCount,
  },
];

/** The seed-meta key writeExtraKeyWithMeta derives for a companion. */
function companionMetaKey(companion) {
  return `seed-meta:${companion.key.replace(/:v\d+$/, '')}`;
}

/**
 * Fetch and publish one companion, or retain its last-good data.
 *
 * A confirmed result — including a confirmed EMPTY one — publishes the payload
 * and only then advances the success clock, through the shared
 * `writeExtraKeyWithMeta` path (which carries its own Upstash retry, so a
 * transient blip does not cost a confirmed result a whole cron interval; the
 * retry is around the WRITE, so no Radar request is replayed).
 *
 * The ordering is the guarantee, deliberately NOT a MULTI/EXEC transaction:
 * Redis EXEC has no rollback, so a per-command runtime error (an over-size
 * payload, OOM at the maxmemory boundary) can land the small meta write while
 * the large payload write fails — a fresh success clock over the PREVIOUS
 * payload, which is exactly the bug this issue is about. Writing data first
 * makes the only reachable torn state the harmless one: a new payload whose
 * clock did not advance, which reads as STALE_SEED and self-heals next tick.
 *
 * A failed fetch or a failed payload write publishes nothing, leaves the success
 * clock where it was, and retains last-good so readers keep being served.
 *
 * Retention extends the consumer key at its own TTL AND the seed-meta key at the
 * shared 7-day meta floor (never rewriting `fetchedAt`). Extending the payload
 * alone would make it immortal under a sustained outage while the meta expired
 * out from under it — and a present payload with no meta reads as plain OK in
 * classifyKey, so a week-long failure would decay from STALE_SEED back to green
 * with a frozen payload behind it. The retention TTL is resolved through
 * `resolveSeedMetaTtl`, the same function that computed the marker's TTL when it
 * was written, rather than hardcoding the 7-day floor: for a data TTL longer
 * than the floor the marker is written at the DATA TTL, and EXPIRE replaces
 * rather than extends, so re-arming at the floor would SHORTEN such a marker and
 * recreate the very alarm-before-data failure this retention exists to prevent.
 *
 * Never rejects: a companion's outcome is its own, and must not decide the
 * annotations leg's.
 */
async function runCompanion(companion, token) {
  try {
    const data = await companion.fetch(token);
    const recordCount = companion.recordCount(data);
    const clockAdvanced = await writeExtraKeyWithMeta(
      companion.key,
      companion.toPayload ? companion.toPayload(data) : data,
      companion.ttlSeconds,
      recordCount,
      undefined,  // metaKey — the derived seed-meta:<key> is correct
      undefined,  // metaTtlSeconds — resolves to the 7-day floor
      undefined,  // coverage — not a coverage-bearing source
      companion.metaExtra?.(data),
    );
    if (!clockAdvanced) {
      // Payload landed, clock did not. Safe direction: health reports
      // STALE_SEED over data that is actually fresh, and the next tick repairs.
      console.warn(`  CF Radar ${companion.label}: payload published but seed-meta write failed — clock not advanced`);
      return { published: true, clockAdvanced: false };
    }
    console.log(`  CF Radar ${companion.label}: published ${recordCount} record(s)`);
    return { published: true, clockAdvanced: true };
  } catch (err) {
    console.warn(`  CF Radar ${companion.label} update failed: ${err?.message || err}`);
    // Two calls, not one pipeline: EXPIRE sets a TTL absolutely, so the payload
    // and its meta must each be extended at their own value.
    const [dataRetained, metaRetained] = await Promise.all([
      extendExistingTtl([companion.key], companion.ttlSeconds),
      extendExistingTtl([companionMetaKey(companion)], resolveSeedMetaTtl(undefined, companion.ttlSeconds)),
    ]);
    const retained = dataRetained && metaRetained;
    // Deliberately does not claim WHICH payload survives: writeExtraKeyWithMeta
    // writes data before meta, so a throw from the meta half leaves a freshly
    // published payload behind an un-advanced clock. Either way the key is
    // retained and the success clock did not move, which is what this says.
    console.warn(
      retained
        ? `  CF Radar ${companion.label}: ${companion.key} retained at ${companion.ttlSeconds}s, success clock untouched`
        : `  CF Radar ${companion.label}: ${companion.key} could not be retained — /api/health is the alarm`,
    );
    return { published: false, retained };
  }
}

/**
 * Companion attempts, memoized for the life of the process.
 *
 * runSeed wraps fetchAll in withRetry, so a retryable annotations failure
 * re-enters fetchAll. Without this memo each retry would replay four Radar
 * requests that already succeeded and republish keys that already published.
 * One bounded pass per companion per run; the cron tick is the retry for a
 * companion that failed.
 */
const companionAttempts = new Map();

function publishCompanion(companion, token) {
  if (!companionAttempts.has(companion.key)) {
    companionAttempts.set(companion.key, runCompanion(companion, token));
  }
  return companionAttempts.get(companion.key);
}

// NOTE: runSeed() writes only the canonical key and its own extraKeys, and the
// canonical publish is skipped whenever the annotations leg fails. The companion
// keys MUST therefore be published here, before the annotations rejection is
// rethrown, or an annotations outage would withhold two healthy sibling updates.
async function fetchAll() {
  const token = process.env.CLOUDFLARE_API_TOKEN;

  const [outagesResult] = await Promise.allSettled([
    fetchOutages(),
    ...COMPANIONS.map((companion) => publishCompanion(companion, token)),
  ]);

  if (outagesResult.status === 'rejected') throw outagesResult.reason;
  return outagesResult.value;
}

function validate(data) {
  return data && Array.isArray(data.outages);
}

export function declareRecords(data) {
  return Array.isArray(data?.outages) ? data.outages.length : 0;
}

runSeed('infra', 'outages', CANONICAL_KEY, fetchAll, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'cloudflare-radar-28d',

  declareRecords,
  // The companion keys are written by publishCompanion(), outside runSeed's own
  // extra-key phase, so runSeed does not know to retain them when the
  // annotations leg fails, times out or is SIGTERMed. Each is declared at its
  // OWN TTL — the canonical 3h would extend the anomalies key's 2h
  // contract, and each meta key resolves through the same `resolveSeedMetaTtl`
  // that wrote it, so an EXPIRE can never shorten one. Meta is listed so a
  // retained payload can never outlive the clock that reports on it (see
  // runCompanion's retention note).
  preserveKeyTtls: [
    ...COMPANIONS.map((companion) => ({ key: companion.key, ttlSeconds: companion.ttlSeconds })),
    ...COMPANIONS.map((companion) => ({ key: companionMetaKey(companion), ttlSeconds: resolveSeedMetaTtl(undefined, companion.ttlSeconds) })),
  ],
  // CF Radar curated outage annotations are sparse (~1-2/wk, clustered, with
  // multi-day gaps). Zero mappable outages is the NORMAL state, not a fetch
  // failure — without this, runSeed takes the contract RETRY path on every
  // quiet cycle, never refreshing seed-meta.fetchedAt → false STALE_SEED in
  // /api/health after maxStaleMin. zeroIsValid publishes an empty {outages:[]}
  // envelope + fresh meta (recordCount=0) instead. Health-side: 'outages' is in
  // ZERO_RECORD_DATA_OK_KEYS (narrow) so present+0 is OK while a MISSING key
  // still alarms EMPTY (real publish failure).
  zeroIsValid: true,
  schemaVersion: 1,
  maxStaleMin: 30,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
