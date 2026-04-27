#!/usr/bin/env node
// seed-recovery-reexport-share
// ============================
//
// Publishes `resilience:recovery:reexport-share:v1` from UN Comtrade,
// computing each country's re-export-share-of-imports as a live ratio
// of `flowCode=RX` over `flowCode=M` aggregate merchandise trade.
//
// Consumed by `scripts/seed-sovereign-wealth.mjs` to convert GROSS
// annual imports into NET annual imports when computing the SWF
// `rawMonths` denominator for the `sovereignFiscalBuffer` dimension.
//
//   netAnnualImports = grossAnnualImports × (1 − reexportShareOfImports)
//
// Design decisions — see plan §Phase 1 at
// `docs/plans/2026-04-24-003-feat-reexport-share-comtrade-seeder-plan.md`:
//
//   - Hub cohort resolved by Phase 0 empirical RX+M co-population probe
//     (see the plan's §"Phase 0 cohort validation results"). As of the
//     2026-04-24 probe: AE + PA. Six other candidates (SG, HK, NL, BE,
//     MY, LT) return HTTP 200 with zero RX rows and are excluded until
//     Comtrade exposes RX for those reporters.
//   - Header auth (`Ocp-Apim-Subscription-Key`) — key never leaks into
//     the URL → logs → Redis payload → clipboard.
//   - `maxRecords=250000` cap with truncation detection: a full-cap
//     response triggers per-country omission so partial data never
//     under-reports the share.
//   - 4-year period window (Y-1..Y-4), matching the HHI seeder PR #3372.
//   - Clamps: share < 0.05 → omit (per-run discipline); share > 0.95 →
//     cap at 0.95. computeNetImports requires share < 1.
//   - Envelope schema v2 (bumped from manifestVersion=1 manifest flattener).
//
// Revision cadence: none — the monthly bundle cron re-seeds from Comtrade.
//
// Duplication policy: the retry-classification loop is duplicated here
// rather than extracted into a `_comtrade.mjs` helper. Per CLAUDE.md,
// duplication is cheaper than a premature abstraction — a second
// Comtrade caller in the future can extract then.

import { pathToFileURL } from 'node:url';

import { CHROME_UA, loadEnvFile, runSeed, sleep } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'resilience:recovery:reexport-share:v1';
// Monthly bundle cron. TTL large enough that one missed tick doesn't
// evict (the SWF seeder's bundle-freshness guard falls back to gross
// imports if seed-meta predates the current bundle run, independent
// of data-key TTL).
const CACHE_TTL_SECONDS = 35 * 24 * 3600;

const COMTRADE_URL = 'https://comtradeapi.un.org/data/v1/get/C/A/HS';
const MAX_RECORDS = 250_000;
const FETCH_TIMEOUT_MS = 45_000;
const RETRY_MAX_ATTEMPTS = 3;
const INTER_CALL_PACING_MS = 750;

// Share bounds. Floor 0.05 drops commercially-immaterial contributions
// (Panama's 1.4% observed in Phase 0). Ceiling 0.95 prevents pathological
// share=1 reporters from zeroing the denominator via computeNetImports.
const MIN_MATERIAL_SHARE = 0.05;
const MAX_SHARE_CAP = 0.95;

// Phase 0 resolved cohort — commit 2026-04-24, candidates AE, SG, HK,
// NL, BE, PA, MY, LT probed sequentially via railway run. Only AE and
// PA returned co-populated RX+M rows; see plan §"Phase 0 cohort
// validation results" for full table and HTTP status per candidate.
const REEXPORT_HUB_COHORT = [
  { iso2: 'AE', reporterCode: '784', name: 'United Arab Emirates' },
  { iso2: 'PA', reporterCode: '591', name: 'Panama' },
];

function buildPeriodYears() {
  // Y-1..Y-4. Same window as the HHI seeder (PR #3372). Excludes the
  // current calendar year (Comtrade lag for annual aggregates).
  const now = new Date().getFullYear();
  return [now - 1, now - 2, now - 3, now - 4];
}

function auditSafeSourceUrl(reporterCode, flowCode, years) {
  // Belt-and-suspenders: even though header auth means the
  // subscription-key never gets appended to the URL, construct the
  // displayed source string WITHOUT any credential query-params. If
  // a future refactor ever adds subscription-key to the URL again,
  // this function strips it before it reaches the Redis envelope.
  const u = new URL(COMTRADE_URL);
  u.searchParams.set('reporterCode', reporterCode);
  u.searchParams.set('flowCode', flowCode);
  u.searchParams.set('cmdCode', 'TOTAL');
  u.searchParams.set('period', years.join(','));
  u.searchParams.delete('subscription-key');
  return u.toString();
}

async function fetchComtradeFlow(apiKey, reporterCode, flowCode, years, { iso2 }) {
  const u = new URL(COMTRADE_URL);
  u.searchParams.set('reporterCode', reporterCode);
  u.searchParams.set('flowCode', flowCode);
  u.searchParams.set('cmdCode', 'TOTAL');
  u.searchParams.set('period', years.join(','));
  u.searchParams.set('maxRecords', String(MAX_RECORDS));
  const urlStr = u.toString();

  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      const resp = await fetch(urlStr, {
        headers: {
          'Ocp-Apim-Subscription-Key': apiKey,
          'User-Agent': CHROME_UA,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (resp.status === 429) {
        if (attempt === RETRY_MAX_ATTEMPTS) {
          console.warn(`[reexport-share] ${iso2} ${flowCode}: 429 after ${RETRY_MAX_ATTEMPTS} attempts; omitting`);
          return { rows: [], truncated: false, status: 429 };
        }
        const backoffMs = 2000 * attempt;
        console.warn(`[reexport-share] ${iso2} ${flowCode}: 429 rate-limited, backoff ${backoffMs}ms (attempt ${attempt}/${RETRY_MAX_ATTEMPTS})`);
        await sleep(backoffMs);
        continue;
      }
      if (resp.status >= 500) {
        if (attempt === RETRY_MAX_ATTEMPTS) {
          console.warn(`[reexport-share] ${iso2} ${flowCode}: HTTP ${resp.status} after ${RETRY_MAX_ATTEMPTS} attempts; omitting`);
          return { rows: [], truncated: false, status: resp.status };
        }
        const backoffMs = 5000 * attempt;
        console.warn(`[reexport-share] ${iso2} ${flowCode}: HTTP ${resp.status}, backoff ${backoffMs}ms (attempt ${attempt}/${RETRY_MAX_ATTEMPTS})`);
        await sleep(backoffMs);
        continue;
      }
      if (!resp.ok) {
        console.warn(`[reexport-share] ${iso2} ${flowCode}: HTTP ${resp.status}; omitting`);
        return { rows: [], truncated: false, status: resp.status };
      }

      const json = await resp.json();
      const rows = Array.isArray(json?.data) ? json.data : [];
      if (rows.length >= MAX_RECORDS) {
        console.warn(`[reexport-share] ${iso2} ${flowCode}: response at cap (${rows.length}>=${MAX_RECORDS}); possible truncation — omitting country`);
        return { rows: [], truncated: true, status: 200 };
      }
      return { rows, truncated: false, status: 200 };
    } catch (err) {
      if (attempt === RETRY_MAX_ATTEMPTS) {
        console.warn(`[reexport-share] ${iso2} ${flowCode}: exhausted retries (${err?.message || err}); omitting`);
        return { rows: [], truncated: false, status: null, error: err?.message || String(err) };
      }
      const backoffMs = 3000 * attempt;
      console.warn(`[reexport-share] ${iso2} ${flowCode}: fetch error "${err?.message || err}", backoff ${backoffMs}ms (attempt ${attempt}/${RETRY_MAX_ATTEMPTS})`);
      await sleep(backoffMs);
    }
  }
  return { rows: [], truncated: false, status: null };
}

/**
 * Sum primaryValue per year from a Comtrade flow response.
 * USES world-aggregate rows only (partnerCode='0' / 0 / absent) —
 * this construct wants the country-total flow as a single figure, not
 * a partner-level breakdown. The `cmdCode=TOTAL` query without a
 * partner filter defaults to returning only world-aggregate rows in
 * practice, but this filter is defensive: if a future refactor asks
 * Comtrade for partner-level decomposition (e.g. to cross-check),
 * summing partner rows ON TOP of the world-aggregate row would
 * silently double-count and cut the derived share in half.
 *
 * Pure function — exported for tests.
 *
 * @param {Array} rows
 * @returns {Map<number, number>}  year → summed primaryValue in USD
 */
export function parseComtradeFlowResponse(rows) {
  const byYear = new Map();
  for (const r of rows) {
    // Accept world-aggregate rows only: string '0', numeric 0, or
    // the field absent entirely (older response shapes). Any specific
    // partnerCode (e.g. '842' for US, '826' for UK) is a per-partner
    // breakdown row and must be excluded to avoid double-counting
    // against the world-aggregate row for the same year.
    const partnerCode = r?.partnerCode;
    const isWorldAggregate = partnerCode == null
      || partnerCode === '0'
      || partnerCode === 0;
    if (!isWorldAggregate) continue;

    const yRaw = r?.period ?? r?.refPeriodId;
    const y = Number(yRaw);
    const v = Number(r?.primaryValue ?? 0);
    if (!Number.isInteger(y) || !Number.isFinite(v) || v <= 0) continue;
    byYear.set(y, (byYear.get(y) ?? 0) + v);
  }
  return byYear;
}

/**
 * Given per-year RX and M sums, pick the latest year where BOTH are
 * populated (>0), and return the share = RX / M plus metadata.
 *
 * Returns null if no co-populated year exists.
 *
 * Pure function — exported for tests.
 *
 * @param {Map<number, number>} rxByYear
 * @param {Map<number, number>} mByYear
 * @returns {{ year: number, share: number, reexportsUsd: number, importsUsd: number } | null}
 */
export function computeShareFromFlows(rxByYear, mByYear) {
  const coPopulated = [];
  for (const y of rxByYear.keys()) {
    if (mByYear.has(y)) coPopulated.push(y);
  }
  if (coPopulated.length === 0) return null;
  coPopulated.sort((a, b) => b - a);
  const year = coPopulated[0];
  const reexportsUsd = rxByYear.get(year);
  const importsUsd = mByYear.get(year);
  if (!(importsUsd > 0)) return null;
  const rawShare = reexportsUsd / importsUsd;
  return { year, share: rawShare, reexportsUsd, importsUsd };
}

/**
 * Clamp a raw share into the material-and-safe range. Returns null for
 * sub-floor shares (caller omits the country); caps at MAX_SHARE_CAP
 * for above-ceiling shares. Pure function — exported for tests.
 *
 * @param {number} rawShare
 * @returns {number | null}  clamped share, or null if sub-floor
 */
export function clampShare(rawShare) {
  if (!Number.isFinite(rawShare) || rawShare < 0) return null;
  if (rawShare < MIN_MATERIAL_SHARE) return null;
  if (rawShare > MAX_SHARE_CAP) return MAX_SHARE_CAP;
  return rawShare;
}

async function fetchReexportShare() {
  const apiKey = (process.env.COMTRADE_API_KEYS || '').split(',').filter(Boolean)[0];
  if (!apiKey) {
    throw new Error('[reexport-share] COMTRADE_API_KEYS not set — cannot fetch');
  }

  const years = buildPeriodYears();
  const countries = {};

  for (const { iso2, reporterCode } of REEXPORT_HUB_COHORT) {
    const mResult = await fetchComtradeFlow(apiKey, reporterCode, 'M', years, { iso2 });
    await sleep(INTER_CALL_PACING_MS);
    const rxResult = await fetchComtradeFlow(apiKey, reporterCode, 'RX', years, { iso2 });
    await sleep(INTER_CALL_PACING_MS);

    if (mResult.truncated || rxResult.truncated) {
      console.warn(`[reexport-share] ${iso2}: skipping due to truncation`);
      continue;
    }

    const mByYear = parseComtradeFlowResponse(mResult.rows);
    const rxByYear = parseComtradeFlowResponse(rxResult.rows);
    const picked = computeShareFromFlows(rxByYear, mByYear);
    if (!picked) {
      console.warn(`[reexport-share] ${iso2}: no co-populated RX+M year in window ${years.join(',')}; omitting`);
      continue;
    }

    const clamped = clampShare(picked.share);
    if (clamped == null) {
      console.log(`[reexport-share] ${iso2}: raw share ${(picked.share * 100).toFixed(2)}% below floor (${MIN_MATERIAL_SHARE * 100}%) at Y=${picked.year}; omitting`);
      continue;
    }

    countries[iso2] = {
      reexportShareOfImports: clamped,
      year: picked.year,
      reexportsUsd: picked.reexportsUsd,
      grossImportsUsd: picked.importsUsd,
      source: 'comtrade',
      sources: [
        auditSafeSourceUrl(reporterCode, 'RX', years),
        auditSafeSourceUrl(reporterCode, 'M', years),
      ],
    };
    console.log(`[reexport-share] ${iso2}: share=${(clamped * 100).toFixed(1)}% at Y=${picked.year} (RX $${(picked.reexportsUsd / 1e9).toFixed(1)}B / M $${(picked.importsUsd / 1e9).toFixed(1)}B)`);
  }

  const payload = {
    manifestVersion: 2,
    lastReviewed: new Date().toISOString().slice(0, 10),
    externalReviewStatus: 'REVIEWED',
    countries,
    seededAt: new Date().toISOString(),
  };

  // Hard guarantee: no serialized field may contain the subscription-
  // key query param. If any future refactor leaks it into the sources
  // array or anywhere else in the envelope, fail the run loudly
  // instead of publishing the credential.
  const serialized = JSON.stringify(payload);
  if (/subscription-key=/i.test(serialized)) {
    throw new Error('[reexport-share] serialized payload contains subscription-key — refusing to publish');
  }

  return payload;
}

function validate(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.manifestVersion !== 2) return false;
  if (!data.countries || typeof data.countries !== 'object') return false;
  return true;
}

export function declareRecords(data) {
  return Object.keys(data?.countries ?? {}).length;
}

// Guard top-level runSeed so the module can be imported by tests without
// triggering the full fetch/publish flow. Uses the canonical
// `pathToFileURL` comparison — unambiguous across path forms (symlink,
// case-different on macOS HFS+, Windows backslash vs slash) — rather
// than the basename-suffix matching pattern used by some older seeders.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runSeed('resilience', 'recovery:reexport-share', CANONICAL_KEY, fetchReexportShare, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL_SECONDS,
    sourceVersion: 'comtrade-rx-m-ratio-v2',
    declareRecords,
    schemaVersion: 2,
    // Empty-countries is ACCEPTABLE if every cohort member omits (Phase 0
    // may prune all; per-country floor may omit all). Downstream SWF
    // seeder handles an empty map as "all gross imports". Not strict.
    zeroIsValid: true,
    maxStaleMin: 10080,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
