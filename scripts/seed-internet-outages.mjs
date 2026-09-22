#!/usr/bin/env node

import {
  loadEnvFile,
  CHROME_UA,
  runSeed,
  extendExistingTtl,
  writeExtraKeyWithMeta,
  resolveSeedMetaTtl,
} from './_seed-utils.mjs';

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

const COUNTRY_COORDS = {
  AF:[33.94,67.71],AL:[41.15,20.17],DZ:[28.03,1.66],AO:[-11.20,17.87],
  AR:[-38.42,-63.62],AM:[40.07,45.04],AU:[-25.27,133.78],AT:[47.52,14.55],
  AZ:[40.14,47.58],BH:[26.07,50.56],BD:[23.69,90.36],BY:[53.71,27.95],
  BE:[50.50,4.47],BJ:[9.31,2.32],BO:[-16.29,-63.59],BA:[43.92,17.68],
  BW:[-22.33,24.68],BR:[-14.24,-51.93],BG:[42.73,25.49],BF:[12.24,-1.56],
  BI:[-3.37,29.92],KH:[12.57,104.99],CM:[7.37,12.35],CA:[56.13,-106.35],
  CF:[6.61,20.94],TD:[15.45,18.73],CL:[-35.68,-71.54],CN:[35.86,104.20],
  CO:[4.57,-74.30],CG:[-0.23,15.83],CD:[-4.04,21.76],CR:[9.75,-83.75],
  HR:[45.10,15.20],CU:[21.52,-77.78],CY:[35.13,33.43],CZ:[49.82,15.47],
  DK:[56.26,9.50],DJ:[11.83,42.59],EC:[-1.83,-78.18],EG:[26.82,30.80],
  SV:[13.79,-88.90],ER:[15.18,39.78],EE:[58.60,25.01],ET:[9.15,40.49],
  FI:[61.92,25.75],FR:[46.23,2.21],GA:[-0.80,11.61],GM:[13.44,-15.31],
  GE:[42.32,43.36],DE:[51.17,10.45],GH:[7.95,-1.02],GR:[39.07,21.82],
  GT:[15.78,-90.23],GN:[9.95,-9.70],HT:[18.97,-72.29],HN:[15.20,-86.24],
  HK:[22.32,114.17],HU:[47.16,19.50],IN:[20.59,78.96],ID:[-0.79,113.92],
  IR:[32.43,53.69],IQ:[33.22,43.68],IE:[53.14,-7.69],IL:[31.05,34.85],
  IT:[41.87,12.57],CI:[7.54,-5.55],JP:[36.20,138.25],JO:[30.59,36.24],
  KZ:[48.02,66.92],KE:[-0.02,37.91],KW:[29.31,47.48],KG:[41.20,74.77],
  LA:[19.86,102.50],LV:[56.88,24.60],LB:[33.85,35.86],LY:[26.34,17.23],
  LT:[55.17,23.88],LU:[49.82,6.13],MG:[-18.77,46.87],MW:[-13.25,34.30],
  MY:[4.21,101.98],ML:[17.57,-4.00],MR:[21.01,-10.94],MX:[23.63,-102.55],
  MD:[47.41,28.37],MN:[46.86,103.85],MA:[31.79,-7.09],MZ:[-18.67,35.53],
  MM:[21.92,95.96],NA:[-22.96,18.49],NP:[28.39,84.12],NL:[52.13,5.29],
  NZ:[-40.90,174.89],NI:[12.87,-85.21],NE:[17.61,8.08],NG:[9.08,8.68],
  KP:[40.34,127.51],NO:[60.47,8.47],OM:[21.47,55.98],PK:[30.38,69.35],
  PS:[31.95,35.23],PA:[8.54,-80.78],PG:[-6.32,143.96],PY:[-23.44,-58.44],
  PE:[-9.19,-75.02],PH:[12.88,121.77],PL:[51.92,19.15],PT:[39.40,-8.22],
  QA:[25.35,51.18],RO:[45.94,24.97],RU:[61.52,105.32],RW:[-1.94,29.87],
  SA:[23.89,45.08],SN:[14.50,-14.45],RS:[44.02,21.01],SL:[8.46,-11.78],
  SG:[1.35,103.82],SK:[48.67,19.70],SI:[46.15,14.99],SO:[5.15,46.20],
  ZA:[-30.56,22.94],KR:[35.91,127.77],SS:[6.88,31.31],ES:[40.46,-3.75],
  LK:[7.87,80.77],SD:[12.86,30.22],SE:[60.13,18.64],CH:[46.82,8.23],
  SY:[34.80,38.997],TW:[23.70,120.96],TJ:[38.86,71.28],TZ:[-6.37,34.89],
  TH:[15.87,100.99],TG:[8.62,0.82],TT:[10.69,-61.22],TN:[33.89,9.54],
  TR:[38.96,35.24],TM:[38.97,59.56],UG:[1.37,32.29],UA:[48.38,31.17],
  AE:[23.42,53.85],GB:[55.38,-3.44],US:[37.09,-95.71],UY:[-32.52,-55.77],
  UZ:[41.38,64.59],VE:[6.42,-66.59],VN:[14.06,108.28],YE:[15.55,48.52],
  ZM:[-13.13,27.85],ZW:[-19.02,29.15],
};

function mapOutageSeverity(outageType) {
  if (outageType === 'NATIONWIDE') return 'OUTAGE_SEVERITY_TOTAL';
  if (outageType === 'REGIONAL') return 'OUTAGE_SEVERITY_MAJOR';
  return 'OUTAGE_SEVERITY_PARTIAL';
}

function toEpochMs(value) {
  if (!value) return 0;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
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

  const anomalies = raw.map((item) => {
    const coords = COUNTRY_COORDS[item.locationDetails?.code] || null;
    return {
      uuid: item.uuid || '',
      type: item.type || '',
      status: item.status || '',
      startDate: toEpochMs(item.startDate),
      endDate: toEpochMs(item.endDate),
      asn: item.asnDetails?.asn ? String(item.asnDetails.asn) : '',
      asnName: item.asnDetails?.name || '',
      locationCode: item.locationDetails?.code || '',
      locationName: item.locationDetails?.name || '',
      latitude: coords ? coords[0] : 0,
      longitude: coords ? coords[1] : 0,
    };
  });

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
