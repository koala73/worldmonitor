#!/usr/bin/env node
//
// World Bank — female upper-secondary educational attainment
// Canonical key: resilience:education-attainment:v1
//
//   SE.SEC.CUAT.UP.FE.ZS — Educational attainment, at least completed
//                          upper secondary, population 25+, female (%)
//
// Feeds the `education` dimension of the Country Resilience Index
// (`scoreEducation` in `_dimension-scorers.ts`). See
// the "Education" section of `docs/methodology/country-resilience-index.mdx`
// for the construct.
//
// Why the FEMALE variant and not the total:
//   The causal literature this construct rests on (Striessnig, Lutz & Patt
//   2013; Lutz, Muttarak & Striessnig 2014) reports the income-independent
//   effect on female secondary attainment specifically. Coverage is
//   identical — the female, male, and total series cover the same 181 of
//   the 196 rankable countries — so the mechanism-truest variant costs
//   nothing. Measured 2026-08-10 against `scripts/shared/sovereign-status.json`.
//
// Coverage shape (measured, not estimated):
//   181/196 rankable countries. The 15 absent are BB, ER, GA, GQ, KG, KN,
//   KP, LI, LY, MC, SS, ST, SY, TW, VC — micro-states, DPRK, and conflict
//   states. All nine high-income probes (US, DE, JP, GB, FR, CA, AU, NO,
//   CH) are present, which is what disqualified adult literacy
//   (SE.ADT.LITR.ZS) for this construct: it covers only 131 and is missing
//   the entire OECD bloc.
//
// TW is absent from ALL World Bank data and always will be. It is a
// structural absence, not a fetch failure — the practical ceiling for any
// World Bank series against this universe is 195/196.

import {
  loadEnvFile, CHROME_UA, runSeed, resolveProxyForConnect, httpsProxyFetchRaw,
  getRedisCredentials, redisCommand,
} from './_seed-utils.mjs';
import { wbCountryDictContentMeta } from './_wb-country-dict-content-age-helpers.mjs';
import iso3ToIso2 from './shared/iso3-to-iso2.json' with { type: 'json' };
import sovereignStatus from './shared/sovereign-status.json' with { type: 'json' };

loadEnvFile(import.meta.url);

const WB_BASE = 'https://api.worldbank.org/v2';
const _proxyAuth = resolveProxyForConnect();
const CANONICAL_KEY = 'resilience:education-attainment:v1';
const CACHE_TTL = 35 * 24 * 3600; // 35 days; the series publishes annually
const SEED_META_KEY = 'seed-meta:resilience:education-attainment';
const COUNTRY_SET_BASELINE_KEY = 'seed-baseline:resilience:education-attainment:v1';

// Content-age budget. Educational attainment of the 25+ population is a
// slow-moving stock published on an irregular survey cadence — 39 of the
// 181 covered countries already carry an observation older than 5 years,
// including JP, CN, NZ, and KZ. 48 months mirrors the WB IDS budget and
// fires STALE_CONTENT only when the World Bank stops publishing entirely.
const MAX_CONTENT_AGE_MIN = 48 * 30 * 24 * 60;

const ATTAINMENT_INDICATOR = 'SE.SEC.CUAT.UP.FE.ZS';

// Rolling observation window. The 2026 coverage measurement used 2011..2026;
// deriving the start keeps the same 15-year lookback as the calendar advances
// instead of retaining progressively older observations forever.
const OBSERVATION_WINDOW_YEARS = 15;
export function observationWindowStart(nowYear) {
  return nowYear - OBSERVATION_WINDOW_YEARS;
}

// The measured 3975-row response fits in one World Bank page at this size.
// runSeed's outer withRetry allows four attempts with 1s + 2s + 4s backoff.
// Four fully degraded attempts therefore cost at most 4 x
// (30s direct + 30s proxy) + 7s = 247s. The fetch deadline adds 13s for JSON
// parsing and reduction; the lock and bundle section retain publish/cleanup
// headroom.
const WB_PAGE_SIZE = 5_000;
const EDUCATION_MAX_EXPECTED_PAGES = 1;
const EDUCATION_PAGE_WORST_CASE_MS = 60_000;
const EDUCATION_OUTER_ATTEMPTS = 4;
const EDUCATION_RETRY_BACKOFF_MS = 7_000;
const EDUCATION_FETCH_PROCESSING_HEADROOM_MS = 13_000;
const EDUCATION_FETCH_PHASE_TIMEOUT_MS = 260_000;
const EDUCATION_LOCK_TTL_MS = 280_000;
const EDUCATION_SECTION_TIMEOUT_MS = 300_000;

// Validation floor. Deliberately well below the measured 181 so a transient
// World Bank dip does not refresh seed-meta on a truncated payload and
// freeze the bundle (memory: `feedback_strict_floor_validate_fail_poisons_seed_meta`).
// This is NOT the flag-flip gate — that separately requires recordCount >= 180,
// because `tests/resilience-indicator-tiering.test.mts` sets CORE_MIN_COVERAGE
// = 180 and fails any tier='core' indicator below it. Measured coverage is 181,
// so promotion clears that floor by one country. See
// `docs/methodology/education-flag-flip-runbook.md`.
const MIN_COUNTRIES = 150;
const ACTIVATION_MIN_COUNTRIES = 180;
const RANKABLE_COUNTRY_CODES = new Set(sovereignStatus.entries.map((entry) => entry.iso2));

// Coverage-drop warning (#6460), shipped before the flag flip as the runbook
// requires. While the dimension is dark a silent drop moves nothing published;
// once it is live the same drop shifts real scores, so this has to exist first.
//
// The floor alone leaves a real gap: a fetch that returns 161 countries clears
// both it and any naive percentage delta check, while silently moving ~20
// countries onto the 50/0.3 `unmonitored` imputation with no alarm.
//
// Sized to CADENCE, not to a percentage borrowed from a volatile feed. A 15%
// delta is nearly a no-op here: 181 x 0.85 = 154, and validate() already
// rejects below 150, so it would only fire in the 4-country band between them.
// This seeder runs weekly against a series that republishes annually, so the
// expected week-over-week delta is exactly ZERO — which buys a far tighter
// trigger than a daily feed could afford.
const MAX_EXPECTED_COUNTRY_DROP = 2; // warn from the 3rd disappearance onward

// Count is a weak proxy: 181 -> 181 with three countries swapped is invisible
// to any count check. The previous run's sorted RANKABLE ISO2 set is persisted
// so the comparison is a true set-diff and the log names the codes.
// "Which countries did we lose" is the question an operator actually has to
// answer; "did the number move" is not, and this feeds a public 196-country
// ranking.
//
// Stored as a comma-joined string rather than a hash: a hash proves only THAT
// the set changed, and the whole point is to say WHICH codes went missing
// without a second round-trip for the previous payload. The dedicated baseline
// key is updated only after a successful read-and-compare. That keeps the last
// confirmed set intact when Redis has a transient read failure, while seed-meta
// still carries the latest diagnostic for operators.
export const COUNTRY_SET_META_FIELD = 'countrySet';

export function rankableCountryCodes(codes) {
  return [...new Set(codes ?? [])]
    .filter((cc) => RANKABLE_COUNTRY_CODES.has(cc))
    .sort();
}

export function diffCountrySets(previousCodes, currentCodes) {
  const prev = new Set(previousCodes ?? []);
  const curr = new Set(currentCodes ?? []);
  return {
    dropped: [...prev].filter((cc) => !curr.has(cc)).sort(),
    added: [...curr].filter((cc) => !prev.has(cc)).sort(),
  };
}

export function parseCountrySetMeta(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const codes = raw.split(',').map((cc) => cc.trim()).filter((cc) => /^[A-Z]{2}$/.test(cc));
  return codes.length > 0 ? codes : null;
}

/**
 * Pure decision half, exported so the threshold and the first-run behavior are
 * testable without Redis. WARN-only by contract: a legitimate World Bank
 * republication does move the set, and hard-failing would poison seed-meta on a
 * real revision — reintroducing, at a tighter threshold, exactly the failure the
 * deliberately-low 150 floor exists to avoid.
 */
export function buildCoverageDropReport(
  previousCodes,
  currentCodes,
  activationMinCountries = ACTIVATION_MIN_COUNTRIES,
) {
  const countrySet = [...currentCodes].sort().join(',');
  const belowActivationFloor = currentCodes.length < activationMinCountries;
  // No previous set: the first run after this ships, or after a seed-meta
  // reset. A missing prior is not evidence of a drop, but a baseline below the
  // binding activation floor still has to warn.
  if (previousCodes == null) {
    return {
      countrySet,
      countryCount: currentCodes.length,
      baseline: true,
      belowActivationFloor,
      dropExceeded: false,
      warn: belowActivationFloor,
      dropped: [],
      added: [],
    };
  }
  const { dropped, added } = diffCountrySets(previousCodes, currentCodes);
  const dropExceeded = dropped.length > MAX_EXPECTED_COUNTRY_DROP;
  return {
    countrySet,
    countryCount: currentCodes.length,
    baseline: false,
    belowActivationFloor,
    dropExceeded,
    warn: dropExceeded || belowActivationFloor,
    dropped,
    added,
  };
}

// Pure record reducer, exported so the parsing traps below are testable
// without network. Folds a page of World Bank rows into `out`, keeping the
// most recent observation per ISO2 country.
export function reduceAttainmentRecords(records, out = {}) {
  for (const record of records ?? []) {
    const rawCode = record?.countryiso3code ?? record?.country?.id ?? '';
    const iso2 = rawCode.length === 3 ? (iso3ToIso2[rawCode] ?? null) : (rawCode.length === 2 ? rawCode : null);
    if (!iso2) continue;
    // CRITICAL: skip nulls BEFORE Number() coercion. Number(null) === 0,
    // which is finite, so a `value: null` record for a late reporter would
    // otherwise overwrite a real earlier observation with a false 0%
    // attainment — and 0% is a *plausible* value for this series (the
    // observed minimum is Niger at 1.15%), so it would not look wrong
    // downstream. Same trap as PR #3427 / #3432.
    if (record?.value == null) continue;
    const value = Number(record.value);
    if (!Number.isFinite(value)) continue;
    // The series is a percentage of population; anything outside 0..100 is
    // upstream corruption, not a real reading.
    if (value < 0 || value > 100) continue;
    const year = Number(record?.date);
    if (!Number.isSafeInteger(year) || year < 1900 || year > 2200) continue;

    const existing = out[iso2];
    if (!existing || year > existing.year) {
      out[iso2] = { value, year };
    }
  }
  return out;
}

async function fetchAttainment() {
  const out = {};
  let page = 1;
  let totalPages = 1;
  const windowEnd = new Date().getUTCFullYear();
  const windowStart = observationWindowStart(windowEnd);

  while (page <= totalPages) {
    const url = `${WB_BASE}/country/all/indicator/${ATTAINMENT_INDICATOR}`
      + `?format=json&per_page=${WB_PAGE_SIZE}&page=${page}&date=${windowStart}:${windowEnd}`;
    let json;
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      json = await resp.json();
    } catch (directErr) {
      if (!_proxyAuth) throw new Error(`World Bank ${ATTAINMENT_INDICATOR}: ${directErr.message}`);
      console.warn(`  WB ${ATTAINMENT_INDICATOR} p${page}: direct failed (${directErr.message}), retrying via proxy`);
      const { buffer } = await httpsProxyFetchRaw(url, _proxyAuth, { accept: 'application/json', timeoutMs: 30_000 });
      json = JSON.parse(buffer.toString('utf8'));
    }

    const meta = json[0];
    totalPages = meta?.pages ?? 1;
    reduceAttainmentRecords(json[1] ?? [], out);
    page++;
  }
  return out;
}

async function fetchEducationAttainment() {
  const countries = await fetchAttainment();
  return {
    countries,
    sources: [`https://data.worldbank.org/indicator/${ATTAINMENT_INDICATOR}`],
    seededAt: new Date().toISOString(),
  };
}

/**
 * Reads the last successfully compared rankable-country set. Missing state is a
 * real first run; Redis and parse failures are separate so they cannot silently
 * replace the confirmed baseline with the current payload.
 */
export async function readPreviousCountrySet({
  credentials = getRedisCredentials(),
  command = redisCommand,
} = {}) {
  if (!credentials?.url || !credentials?.token) {
    return { status: 'error', reason: 'redis-credentials-missing' };
  }
  try {
    const body = await command(
      credentials.url,
      credentials.token,
      ['GET', COUNTRY_SET_BASELINE_KEY],
      { label: 'education-attainment coverage baseline', timeoutMs: 5_000 },
    );
    if (body?.result == null) return { status: 'missing', codes: null };
    const codes = parseCountrySetMeta(body.result);
    return codes == null
      ? { status: 'error', reason: 'coverage-baseline-malformed' }
      : { status: 'ok', codes };
  } catch (error) {
    return { status: 'error', reason: error?.message ?? 'coverage-baseline-read-failed' };
  }
}

export async function writeCountrySetBaseline(countrySet, {
  credentials = getRedisCredentials(),
  command = redisCommand,
} = {}) {
  if (!credentials?.url || !credentials?.token) {
    return { status: 'error', reason: 'redis-credentials-missing' };
  }
  try {
    await command(
      credentials.url,
      credentials.token,
      ['SET', COUNTRY_SET_BASELINE_KEY, countrySet, 'EX', String(CACHE_TTL)],
      { label: 'education-attainment coverage baseline write', timeoutMs: 5_000 },
    );
    return { status: 'ok' };
  } catch (error) {
    return { status: 'error', reason: error?.message ?? 'coverage-baseline-write-failed' };
  }
}

export async function afterPublish(data, context = {}) {
  const currentCodes = rankableCountryCodes(Object.keys(data?.countries ?? {}));
  const readBaseline = context.readCountrySetBaseline ?? readPreviousCountrySet;
  const writeBaseline = context.writeCountrySetBaseline ?? writeCountrySetBaseline;
  const previous = await readBaseline();
  const comparisonUnavailable = previous.status === 'error' ? previous.reason : null;
  const report = buildCoverageDropReport(previous.status === 'ok' ? previous.codes : null, currentCodes);

  let baselineWriteError = null;
  if (previous.status !== 'error') {
    const writeResult = await writeBaseline(report.countrySet);
    if (writeResult.status === 'error') baselineWriteError = writeResult.reason;
  }

  if (comparisonUnavailable) {
    console.warn(
      `  WARN education-attainment coverage comparison unavailable: ${comparisonUnavailable}. `
      + 'The last confirmed baseline was not replaced; the next clean run will compare against it.',
    );
  } else if (report.warn) {
    const reasons = [
      ...(report.dropExceeded
        ? [`${report.dropped.length} rankable countries disappeared (threshold ${MAX_EXPECTED_COUNTRY_DROP})`]
        : []),
      ...(report.belowActivationFloor
        ? [`rankable coverage ${report.countryCount} is below activation floor ${ACTIVATION_MIN_COUNTRIES}`]
        : []),
    ];
    // Stable leading marker so a log scanner groups every occurrence as one
    // condition; the varying detail rides in the payload, not the marker.
    console.warn(
      `  WARN education-attainment coverage: ${reasons.join('; ')}. This series republishes ANNUALLY, `
      + `so the expected week-over-week delta is zero. dropped=[${report.dropped.join(',')}] `
      + `added=[${report.added.join(',')}] rankableCount ${report.countryCount}. Not a publish failure: `
      + 'a real World Bank revision can move the set, and failing here would poison seed-meta.',
    );
  } else if (report.baseline) {
    console.log(`  coverage baseline recorded: ${report.countryCount} countries (no previous set to compare)`);
  } else if (report.dropped.length > 0 || report.added.length > 0) {
    console.log(
      `  coverage churn within tolerance: dropped=[${report.dropped.join(',')}] `
      + `added=[${report.added.join(',')}] count ${report.countryCount}`,
    );
  }

  if (baselineWriteError) {
    console.warn(
      `  WARN education-attainment coverage baseline write failed: ${baselineWriteError}. `
      + 'The prior baseline remains authoritative and will be compared again next run.',
    );
  }

  // Keep total recordCount and rankableRecordCount distinct. The World Bank
  // payload includes territories outside the 196-country headline universe,
  // while the active Core contract requires at least 180 rankable countries.
  // countrySet remains the exact diagnostic and transition fallback.
  return {
    freshnessMetaPatch: {
      [COUNTRY_SET_META_FIELD]: report.countrySet,
      rankableRecordCount: report.countryCount,
      // Persisted so an operator reading seed-meta after the fact sees the same
      // verdict the run logged, without needing the Railway log retained.
      ...(report.dropExceeded ? { coverageDropped: report.dropped.join(',') } : {}),
      ...(report.belowActivationFloor
        ? { rankableCoverageBelowFloor: `${report.countryCount}/${ACTIVATION_MIN_COUNTRIES}` }
        : {}),
      ...(comparisonUnavailable || baselineWriteError
        ? { coverageComparisonUnavailable: comparisonUnavailable ?? baselineWriteError }
        : {}),
    },
  };
}

export function validate(data) {
  return typeof data?.countries === 'object' && Object.keys(data.countries).length >= MIN_COUNTRIES;
}

export function declareRecords(data) {
  return Object.keys(data?.countries || {}).length;
}

export {
  CANONICAL_KEY,
  CACHE_TTL,
  MIN_COUNTRIES,
  ACTIVATION_MIN_COUNTRIES,
  MAX_EXPECTED_COUNTRY_DROP,
  SEED_META_KEY,
  COUNTRY_SET_BASELINE_KEY,
  ATTAINMENT_INDICATOR,
  OBSERVATION_WINDOW_YEARS,
  WB_PAGE_SIZE,
  EDUCATION_MAX_EXPECTED_PAGES,
  EDUCATION_PAGE_WORST_CASE_MS,
  EDUCATION_OUTER_ATTEMPTS,
  EDUCATION_RETRY_BACKOFF_MS,
  EDUCATION_FETCH_PROCESSING_HEADROOM_MS,
  EDUCATION_FETCH_PHASE_TIMEOUT_MS,
  EDUCATION_LOCK_TTL_MS,
  EDUCATION_SECTION_TIMEOUT_MS,
  fetchEducationAttainment,
  fetchAttainment,
};

if (process.argv[1]?.endsWith('seed-education-attainment.mjs')) {
  runSeed('resilience', 'education-attainment', CANONICAL_KEY, fetchEducationAttainment, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: `wb-education-${new Date().getFullYear()}`,
    recordCount: (data) => Object.keys(data?.countries ?? {}).length,
    // Empty result = real upstream failure, not a world with no schooling.
    emptyDataIsFailure: true,
    declareRecords,
    schemaVersion: 1,
    // 8 days, matching the api/health.js budget for this key and sitting well
    // inside the 35-day CACHE_TTL. The invariant (enforced by
    // tests/seed-ttl-outlives-staleness-fleet.test.mjs) is that the data key
    // must OUTLIVE its staleness gate: if the gate is longer than the TTL,
    // a merely-late seeder surfaces as EMPTY_DATA rather than STALE_SEED,
    // telling an operator the data is gone when the real fault is a dead cron.
    //
    // Do not copy 100800 from seed-wb-external-debt.mjs — that pairing (35d TTL
    // against a 70d gate) is a grandfathered violation of this invariant, which
    // is why the test only enforces it on new seeders.
    maxStaleMin: 11520,
    contentMeta: wbCountryDictContentMeta,
    maxContentAgeMin: MAX_CONTENT_AGE_MIN,
    fetchPhaseTimeoutMs: EDUCATION_FETCH_PHASE_TIMEOUT_MS,
    lockTtlMs: EDUCATION_LOCK_TTL_MS,
    // Coverage-drop set-diff. Runs before the seed-meta write, so it can still
    // read the previous run's country set from seed-meta to diff against.
    afterPublish,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
