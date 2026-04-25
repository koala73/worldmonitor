#!/usr/bin/env node

// Cross-index benchmark: compares WorldMonitor resilience scores against
// INFORM Risk (JRC), UNDP HDI, and WorldRiskIndex (HDX) using Spearman/Pearson.
//
// All three sources are CC-BY or open-licensed:
//   INFORM Risk       — JRC, CC-BY 4.0
//   UNDP HDI          — UNDP, publicly downloadable HDR statistical annex
//   WorldRiskIndex    — Bündnis Entwicklung Hilft / IFHV, CC-BY 4.0 via HDX
// Scores are used for INTERNAL validation benchmarking only; not displayed
// in product UI or the public resilience ranking.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnvFile, getRedisCredentials, CHROME_UA } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));
const VALIDATION_DIR = join(__dirname, '..', 'docs', 'methodology', 'country-resilience-index', 'validation');
const REFERENCE_DIR = join(VALIDATION_DIR, 'reference-data');
const REDIS_KEY = 'resilience:benchmark:external:v1';
const REDIS_TTL = 7 * 24 * 60 * 60;

// INFORM Risk 2026 — JRC moved away from year-stamped composite CSVs to a JSON
// API. WorkflowId=505 is "INFORM Risk 2026" (queried via /Workflows endpoint,
// bump when a newer release lands).
const INFORM_JSON_URL = 'https://drmkc.jrc.ec.europa.eu/inform-index/API/InformAPI/countries/Scores/?WorkflowId=505&IndicatorId=INFORM';
// UNDP HDI 2025 — composite-indices time series CSV, refreshed annually with
// the new HDR publication. Latest year column is hdi_YYYY (currently 2023 in
// the 2025 HDR). Wide format: one row per country, one column per year.
const HDI_CSV_URL = 'https://hdr.undp.org/sites/default/files/2025_HDR/HDR25_Composite_indices_complete_time_series.csv';
// WorldRiskIndex — migrated from weltrisikobericht.de/download/2944/ (404'd)
// to the HDX dataset which is CDN-stable and not geo-blocked. Multi-year
// "trend" CSV; we pick each country's latest year.
const WRI_CSV_URL = 'https://data.humdata.org/dataset/1efb6ee7-051a-440f-a2cf-e652fecccf73/resource/3a2320fa-41b4-4dda-a847-3f397d865378/download/worldriskindex-trend.csv';
// ND-GAIN 2026 is published ONLY inside a ZIP at
//   https://gain.nd.edu/assets/647440/ndgain_countryindex_2026.zip
// (resources/gain/gain.csv inside). Node has no built-in zip reader and the
// validation Docker image only installs tsx. Deferred until we wire an
// unzip step (adm-zip dep, or `apk add unzip` in
// Dockerfile.seed-bundle-resilience-validation).
//
// Do NOT restore the old `/assets/522870/nd_gain_countryindex_2023data.csv`
// URL — that endpoint now silently serves the 2023 report PDF, parses to
// zero rows, and the fetch logs "Fetched 2.4 MB live" with no error
// (silent-success trap). See feedback_url_200_but_wrong_content_type_silent_zero.md.
// FSI retired — latest bulk download is 2023 XLSX (no parser in image) and
// Fund for Peace stopped publishing 2024/2025 bulk data. Replaced in the
// HYPOTHESES list below by UNDP HDI (fresher, authoritative, CSV).

export const HYPOTHESES = [
  // Higher WM resilience ↔ lower humanitarian/disaster risk: expect negative
  // correlation with INFORM (0-10, higher = more risk).
  { index: 'INFORM', pillar: 'overall', direction: 'negative', minSpearman: 0.60 },
  // Higher WM resilience ↔ higher human development: expect positive
  // correlation with HDI (0-1, higher = more developed).
  { index: 'HDI', pillar: 'overall', direction: 'positive', minSpearman: 0.65 },
  // Higher WM resilience ↔ lower disaster risk: expect negative correlation
  // with WRI (0-100, higher = more risk).
  { index: 'WorldRiskIndex', pillar: 'overall', direction: 'negative', minSpearman: 0.55 },
];

const ISO3_TO_ISO2 = buildIso3ToIso2Map();

function buildIso3ToIso2Map() {
  const mapping = {
    AFG:'AF',ALB:'AL',DZA:'DZ',AND:'AD',AGO:'AO',ATG:'AG',ARG:'AR',ARM:'AM',AUS:'AU',AUT:'AT',
    AZE:'AZ',BHS:'BS',BHR:'BH',BGD:'BD',BRB:'BB',BLR:'BY',BEL:'BE',BLZ:'BZ',BEN:'BJ',BTN:'BT',
    BOL:'BO',BIH:'BA',BWA:'BW',BRA:'BR',BRN:'BN',BGR:'BG',BFA:'BF',BDI:'BI',KHM:'KH',CMR:'CM',
    CAN:'CA',CPV:'CV',CAF:'CF',TCD:'TD',CHL:'CL',CHN:'CN',COL:'CO',COM:'KM',COG:'CG',COD:'CD',
    CRI:'CR',CIV:'CI',HRV:'HR',CUB:'CU',CYP:'CY',CZE:'CZ',DNK:'DK',DJI:'DJ',DMA:'DM',DOM:'DO',
    ECU:'EC',EGY:'EG',SLV:'SV',GNQ:'GQ',ERI:'ER',EST:'EE',SWZ:'SZ',ETH:'ET',FJI:'FJ',FIN:'FI',
    FRA:'FR',GAB:'GA',GMB:'GM',GEO:'GE',DEU:'DE',GHA:'GH',GRC:'GR',GRD:'GD',GTM:'GT',GIN:'GN',
    GNB:'GW',GUY:'GY',HTI:'HT',HND:'HN',HUN:'HU',ISL:'IS',IND:'IN',IDN:'ID',IRN:'IR',IRQ:'IQ',
    IRL:'IE',ISR:'IL',ITA:'IT',JAM:'JM',JPN:'JP',JOR:'JO',KAZ:'KZ',KEN:'KE',KIR:'KI',PRK:'KP',
    KOR:'KR',KWT:'KW',KGZ:'KG',LAO:'LA',LVA:'LV',LBN:'LB',LSO:'LS',LBR:'LR',LBY:'LY',LIE:'LI',
    LTU:'LT',LUX:'LU',MDG:'MG',MWI:'MW',MYS:'MY',MDV:'MV',MLI:'ML',MLT:'MT',MHL:'MH',MRT:'MR',
    MUS:'MU',MEX:'MX',FSM:'FM',MDA:'MD',MCO:'MC',MNG:'MN',MNE:'ME',MAR:'MA',MOZ:'MZ',MMR:'MM',
    NAM:'NA',NRU:'NR',NPL:'NP',NLD:'NL',NZL:'NZ',NIC:'NI',NER:'NE',NGA:'NG',MKD:'MK',NOR:'NO',
    OMN:'OM',PAK:'PK',PLW:'PW',PAN:'PA',PNG:'PG',PRY:'PY',PER:'PE',PHL:'PH',POL:'PL',PRT:'PT',
    QAT:'QA',ROU:'RO',RUS:'RU',RWA:'RW',KNA:'KN',LCA:'LC',VCT:'VC',WSM:'WS',STP:'ST',SAU:'SA',
    SEN:'SN',SRB:'RS',SYC:'SC',SLE:'SL',SGP:'SG',SVK:'SK',SVN:'SI',SLB:'SB',SOM:'SO',ZAF:'ZA',
    SSD:'SS',ESP:'ES',LKA:'LK',SDN:'SD',SUR:'SR',SWE:'SE',CHE:'CH',SYR:'SY',TWN:'TW',TJK:'TJ',
    TZA:'TZ',THA:'TH',TLS:'TL',TGO:'TG',TON:'TO',TTO:'TT',TUN:'TN',TUR:'TR',TKM:'TM',TUV:'TV',
    UGA:'UG',UKR:'UA',ARE:'AE',GBR:'GB',USA:'US',URY:'UY',UZB:'UZ',VUT:'VU',VEN:'VE',VNM:'VN',
    YEM:'YE',ZMB:'ZM',ZWE:'ZW',PSE:'PS',XKX:'XK',COK:'CK',NIU:'NU',
  };
  return mapping;
}

function toIso2(code) {
  if (!code) return null;
  const c = code.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(c)) return c;
  if (/^[A-Z]{3}$/.test(c)) return ISO3_TO_ISO2[c] || null;
  return null;
}

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const values = parseCSVLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h.trim()] = (values[i] || '').trim(); });
    return row;
  });
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { result.push(current); current = ''; continue; }
    current += ch;
  }
  result.push(current);
  return result;
}

async function fetchCSV(url, label) {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    console.log(`[benchmark] Fetched ${label} live (${text.length} bytes)`);
    return { text, source: 'live' };
  } catch (err) {
    console.warn(`[benchmark] Live fetch failed for ${label}: ${err.message}`);
    const refPath = join(REFERENCE_DIR, `${label.toLowerCase().replace(/[^a-z0-9]/g, '-')}.csv`);
    if (existsSync(refPath)) {
      const text = readFileSync(refPath, 'utf8');
      console.log(`[benchmark] Loaded ${label} from reference CSV (${text.length} bytes)`);
      return { text, source: 'stub' };
    }
    console.warn(`[benchmark] No reference CSV at ${refPath}, skipping ${label}`);
    return { text: null, source: 'unavailable' };
  }
}

function findColumn(headers, ...candidates) {
  const lower = headers.map(h => h.toLowerCase().trim());
  for (const c of candidates) {
    const idx = lower.findIndex(h => h.includes(c.toLowerCase()));
    if (idx >= 0) return headers[idx];
  }
  return null;
}

// INFORM JSON API returns an array of { Iso3, IndicatorId, IndicatorScore, … }.
// We filter IndicatorId='INFORM' (the composite top-level score) and convert
// ISO3→ISO2 via the shared toIso2 helper. Falls back to a reference JSON file
// at REFERENCE_DIR/inform.json if the live API is unreachable.
export async function fetchInformGlobal() {
  const label = 'INFORM';
  let rows = null;
  let source = 'live';
  try {
    // JRC's WAF returns an HTML bot-check page to desktop-browser UAs (including
    // our shared CHROME_UA). Using a plain programmatic UA bypasses the
    // challenge and gets the raw JSON response.
    const resp = await fetch(INFORM_JSON_URL, {
      headers: { 'User-Agent': 'WorldMonitor-Benchmark/1.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    rows = await resp.json();
    // Type-guard before logging row count: a successful HTTP 200 with a
    // null/object body would otherwise throw "Cannot read properties of null"
    // and the catch below would log it as a misleading "Live fetch failed"
    // when the real issue is a payload-shape regression.
    if (!Array.isArray(rows)) throw new Error(`expected JSON array, got ${typeof rows}`);
    console.log(`[benchmark] Fetched ${label} live (${rows.length} rows)`);
  } catch (err) {
    console.warn(`[benchmark] Live fetch failed for ${label}: ${err.message}`);
    const refPath = join(REFERENCE_DIR, 'inform.json');
    if (existsSync(refPath)) {
      rows = JSON.parse(readFileSync(refPath, 'utf8'));
      source = 'stub';
      console.log(`[benchmark] Loaded ${label} from reference JSON (${Array.isArray(rows) ? rows.length : 0} rows)`);
    } else {
      console.warn(`[benchmark] No reference JSON at ${refPath}, skipping ${label}`);
      return { scores: new Map(), source: 'unavailable' };
    }
  }

  const scores = new Map();
  if (!Array.isArray(rows)) return { scores, source };
  for (const row of rows) {
    if (row.IndicatorId !== 'INFORM') continue;
    const code = toIso2(row.Iso3);
    const val = typeof row.IndicatorScore === 'number' ? row.IndicatorScore : parseFloat(row.IndicatorScore);
    if (code && Number.isFinite(val)) scores.set(code, val);
  }
  return { scores, source };
}

// ND-GAIN deferred — the 2026 release ships only as a ZIP (resources/gain/gain.csv
// inside NDGAIN_ZIP_URL above). Add a zip reader (adm-zip dep or apk add unzip
// in Dockerfile.seed-bundle-resilience-validation) then restore a fetchNdGain()
// that unzips-and-parses. Legacy /assets/522870/nd_gain_countryindex_2023data.csv
// URL now returns the 2023 report PDF, which silently produced 0 parsed rows
// while logging 2.4 MB "fetched" — misleading. Dropped entirely rather than
// keep a broken source.

// WorldRiskIndex — HDX publishes a multi-year "trend" CSV
// (worldriskindex-trend.csv) with columns: WRI.Country, ISO3.Code, Year, W
// (composite), plus pillar components. Filter to each country's latest
// year and use W as the composite score (0-100 scale).
export async function fetchWorldRiskIndex() {
  const { text, source } = await fetchCSV(WRI_CSV_URL, 'WorldRiskIndex');
  if (!text) return { scores: new Map(), source };
  const rows = parseCSV(text);
  const scores = new Map();
  const latestYear = new Map(); // iso2 → latest year seen
  for (const row of rows) {
    const code = toIso2(row['ISO3.Code'] || row.iso3 || row.ISO3);
    if (!code) continue;
    const year = parseInt(row.Year ?? row.year, 10);
    const val = parseFloat(row.W ?? row.WRI ?? row.worldriskindex);
    if (!Number.isFinite(year) || !Number.isFinite(val)) continue;
    const prev = latestYear.get(code);
    if (prev == null || year > prev) {
      latestYear.set(code, year);
      scores.set(code, val);
    }
  }
  return { scores, source };
}

// UNDP HDI — wide-format CSV, columns: iso3, country, hdicode, region,
// hdi_rank_2023, hdi_1990..hdi_2023, plus other composite indices. Pick each
// country's latest non-null hdi_YYYY column. Higher HDI = more developed =
// expect positive correlation with our resilience score.
export async function fetchHdi() {
  const { text, source } = await fetchCSV(HDI_CSV_URL, 'HDI');
  if (!text) return { scores: new Map(), source };
  const rows = parseCSV(text);
  const scores = new Map();
  if (rows.length === 0) return { scores, source };
  // Find the highest-year hdi_* column with any data; callers care about
  // "latest snapshot" not a specific year.
  const headers = Object.keys(rows[0]);
  const yearCols = headers
    .filter((h) => /^hdi_\d{4}$/i.test(h))
    .map((h) => ({ col: h, year: Number(h.slice(4)) }))
    .sort((a, b) => b.year - a.year);
  for (const row of rows) {
    const iso2 = toIso2(row.iso3 || row.ISO3);
    if (!iso2) continue;
    for (const { col } of yearCols) {
      const val = parseFloat(row[col]);
      if (Number.isFinite(val)) {
        scores.set(iso2, val);
        break;
      }
    }
  }
  return { scores, source };
}

export function rankArray(arr) {
  const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array(arr.length);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j < sorted.length && sorted[j].v === sorted[i].v) j++;
    const avgRank = (i + j + 1) / 2;
    for (let k = i; k < j; k++) ranks[sorted[k].i] = avgRank;
    i = j;
  }
  return ranks;
}

export function spearman(x, y) {
  if (x.length !== y.length || x.length < 3) return NaN;
  const rx = rankArray(x);
  const ry = rankArray(y);
  return pearson(rx, ry);
}

export function pearson(x, y) {
  const n = x.length;
  if (n < 3) return NaN;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx;
    const b = y[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const denom = Math.sqrt(dx * dy);
  return denom === 0 ? 0 : num / denom;
}

export function detectOutliers(wmScores, extScores, countryCodes) {
  if (wmScores.length < 5) return [];
  const rx = rankArray(wmScores);
  const ry = rankArray(extScores);
  const n = rx.length;
  const mRx = rx.reduce((s, v) => s + v, 0) / n;
  const mRy = ry.reduce((s, v) => s + v, 0) / n;

  let slope_num = 0, slope_den = 0;
  for (let i = 0; i < n; i++) {
    slope_num += (rx[i] - mRx) * (ry[i] - mRy);
    slope_den += (rx[i] - mRx) ** 2;
  }
  const slope = slope_den === 0 ? 0 : slope_num / slope_den;
  const intercept = mRy - slope * mRx;

  const residuals = rx.map((r, i) => ry[i] - (slope * r + intercept));
  const meanRes = residuals.reduce((s, v) => s + v, 0) / n;
  const stdRes = Math.sqrt(residuals.reduce((s, v) => s + (v - meanRes) ** 2, 0) / n);
  if (stdRes === 0) return [];

  return residuals
    .map((r, i) => ({ i, z: (r - meanRes) / stdRes }))
    .filter(({ z }) => Math.abs(z) > 2)
    .map(({ i, z }) => ({
      countryCode: countryCodes[i],
      wmScore: wmScores[i],
      externalScore: extScores[i],
      residual: Math.round(z * 100) / 100,
    }));
}

function generateCommentary(outlier, indexName, wmScores, _extScores) {
  const { countryCode, residual } = outlier;
  const wmHigh = outlier.wmScore > median(wmScores);
  const direction = residual > 0 ? 'higher' : 'lower';

  const templates = {
    'INFORM': wmHigh
      ? `${countryCode}: WM scores high (fiscal/institutional capacity); INFORM penalizes geographic/hazard exposure`
      : `${countryCode}: WM scores low (limited structural buffers); INFORM rates risk ${direction} than WM resilience inversion`,
    'HDI': wmHigh
      ? `${countryCode}: WM resilience tracks HDI human-development levels; external rank ${direction} than expected`
      : `${countryCode}: WM resilience and HDI diverge — HDI weights health/education/income; WM weights stress buffers`,
    'WorldRiskIndex': wmHigh
      ? `${countryCode}: WM rates resilience high; WRI emphasizes exposure/vulnerability dimensions differently`
      : `${countryCode}: WM rates resilience low; WRI susceptibility weighting drives rank ${direction}`,
  };
  return templates[indexName] || `${countryCode}: WM diverges from ${indexName} by ${residual} sigma`;
}

function median(arr) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Mirror of _shared.ts#currentCacheFormula. Must stay in lockstep; a
// mixed-formula benchmark would produce a meaningless Spearman / Pearson
// against INFORM / HDI / WRI reference indices.
function currentCacheFormulaLocal() {
  const combine = (process.env.RESILIENCE_PILLAR_COMBINE_ENABLED ?? 'false').toLowerCase() === 'true';
  const v2 = (process.env.RESILIENCE_SCHEMA_V2_ENABLED ?? 'true').toLowerCase() === 'true';
  return combine && v2 ? 'pc' : 'd6';
}

async function readWmScoresFromRedis() {
  const { url, token } = getRedisCredentials();
  const rankingResp = await fetch(`${url}/get/${encodeURIComponent('resilience:ranking:v13')}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!rankingResp.ok) {
    console.warn(`[benchmark] Failed to read ranking: HTTP ${rankingResp.status} — skipping (scores may not be populated yet after cache key bump)`);
    return new Map();
  }
  const rankingData = await rankingResp.json();
  if (!rankingData.result) {
    console.warn('[benchmark] No ranking data in Redis — skipping (cold start after cache key bump)');
    return new Map();
  }
  const parsed = JSON.parse(rankingData.result);
  // Cross-formula gate: the ranking payload carries a `_formula` tag
  // written by get-resilience-ranking.ts#stampRankingCacheTag. If the
  // tag disagrees with the current formula (because the flag just
  // flipped and the ranking cron hasn't rebuilt yet), reject the
  // ranking rather than benchmarking against a stale-formula cohort.
  const current = currentCacheFormulaLocal();
  if (parsed && typeof parsed === 'object' && parsed._formula !== current) {
    console.warn(`[benchmark] Ranking _formula=${parsed._formula ?? 'undefined'} does not match current=${current} — skipping (stale-formula cache entry)`);
    return new Map();
  }
  // The ranking cache stores a GetResilienceRankingResponse object
  // with { items, greyedOut, _formula }, not a bare array.
  const ranking = Array.isArray(parsed) ? parsed : (parsed?.items ?? []);
  const scores = new Map();
  for (const item of ranking) {
    if (item.countryCode && typeof item.overallScore === 'number' && item.overallScore > 0) {
      scores.set(item.countryCode, item.overallScore);
    }
  }
  console.log(`[benchmark] Read ${scores.size} WM resilience scores from Redis (formula=${current})`);
  return scores;
}

function alignScores(wmScores, externalScores) {
  const commonCodes = [];
  const wmArr = [];
  const extArr = [];
  for (const [code, wm] of wmScores) {
    const ext = externalScores.get(code);
    if (ext != null && !Number.isNaN(ext)) {
      commonCodes.push(code);
      wmArr.push(wm);
      extArr.push(ext);
    }
  }
  return { commonCodes, wmArr, extArr };
}

function evaluateHypothesis(hypothesis, sp) {
  const absSpearman = Math.abs(sp);
  const directionCorrect = hypothesis.direction === 'negative' ? sp < 0 : sp > 0;
  return directionCorrect && absSpearman >= hypothesis.minSpearman;
}

export async function runBenchmark(opts = {}) {
  const wmScores = opts.wmScores || await readWmScoresFromRedis();

  if (wmScores.size === 0) {
    console.warn('[benchmark] No WM resilience scores available — skipping benchmark run (cold start after cache key bump)');
    return { skipped: true, reason: 'no-wm-scores', generatedAt: Date.now() };
  }

  const fetchers = [
    { name: 'INFORM', fn: opts.fetchInform || fetchInformGlobal },
    { name: 'HDI', fn: opts.fetchHdi || fetchHdi },
    { name: 'WorldRiskIndex', fn: opts.fetchWri || fetchWorldRiskIndex },
  ];

  const externalResults = {};
  const sourceStatus = {};
  for (const { name, fn } of fetchers) {
    const result = await fn();
    externalResults[name] = result.scores;
    sourceStatus[name] = result.source;
  }

  const correlations = {};
  const allOutliers = [];
  const hypothesisResults = [];

  for (const { name } of fetchers) {
    const extScores = externalResults[name];
    if (!extScores || extScores.size === 0) {
      correlations[name] = { spearman: NaN, pearson: NaN, n: 0 };
      continue;
    }

    const { commonCodes, wmArr, extArr } = alignScores(wmScores, extScores);
    const sp = spearman(wmArr, extArr);
    const pe = pearson(wmArr, extArr);
    correlations[name] = {
      spearman: Math.round(sp * 10000) / 10000,
      pearson: Math.round(pe * 10000) / 10000,
      n: commonCodes.length,
    };

    const outliers = detectOutliers(wmArr, extArr, commonCodes);
    for (const o of outliers) {
      const commentary = generateCommentary(o, name, wmArr, extArr);
      allOutliers.push({ ...o, index: name, commentary });
    }
  }

  for (const h of HYPOTHESES) {
    const corr = correlations[h.index];
    const sp = corr?.spearman ?? NaN;
    const pass = !Number.isNaN(sp) && evaluateHypothesis(h, sp);
    hypothesisResults.push({
      index: h.index,
      pillar: h.pillar,
      direction: h.direction,
      expected: h.minSpearman,
      actual: Number.isNaN(sp) ? null : Math.round(sp * 10000) / 10000,
      pass,
    });
  }

  const result = {
    generatedAt: Date.now(),
    license: 'INFORM Risk (JRC) CC-BY 4.0, UNDP HDI public, WorldRiskIndex (HDX) CC-BY 4.0. Internal validation only.',
    hypotheses: hypothesisResults,
    correlations,
    outliers: allOutliers,
    sourceStatus,
  };

  if (!opts.dryRun) {
    mkdirSync(VALIDATION_DIR, { recursive: true });
    writeFileSync(
      join(VALIDATION_DIR, 'benchmark-results.json'),
      JSON.stringify(result, null, 2) + '\n',
    );
    console.log(`[benchmark] Wrote benchmark-results.json`);

    try {
      const { url, token } = getRedisCredentials();
      const payload = JSON.stringify(result);
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['SET', REDIS_KEY, payload, 'EX', REDIS_TTL]),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) console.warn('[benchmark] Redis write failed:', resp.status);
      console.log(`[benchmark] Wrote to Redis key ${REDIS_KEY} (TTL ${REDIS_TTL}s)`);
    } catch (err) {
      console.warn(`[benchmark] Redis write failed: ${err.message}`);
    }
  }

  return result;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runBenchmark()
    .then(result => {
      if (result.skipped) {
        console.log(`\n[benchmark] Skipped: ${result.reason}`);
        return;
      }
      console.log('\n=== Benchmark Results ===');
      console.log(`Hypotheses: ${(result.hypotheses ?? []).filter(h => h.pass).length}/${(result.hypotheses ?? []).length} passed`);
      for (const h of (result.hypotheses ?? [])) {
        console.log(`  ${h.pass ? 'PASS' : 'FAIL'} ${h.index} (${h.pillar}): expected ${h.direction} >= ${h.expected}, got ${h.actual}`);
      }
      console.log(`\nCorrelations:`);
      for (const [name, c] of Object.entries(result.correlations ?? {})) {
        console.log(`  ${name}: spearman=${c.spearman}, pearson=${c.pearson}, n=${c.n}`);
      }
      console.log(`\nOutliers: ${(result.outliers ?? []).length}`);
      for (const o of (result.outliers ?? []).slice(0, 10)) {
        console.log(`  ${o.countryCode} (${o.index}): residual=${o.residual} - ${o.commentary}`);
      }
    })
    .catch(err => {
      console.error('[benchmark] Fatal:', err);
      process.exit(1);
    });
}
