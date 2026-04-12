#!/usr/bin/env node

// Cross-index benchmark: compares WorldMonitor resilience scores against
// INFORM Global, ND-GAIN, WorldRiskIndex, and FSI using Spearman/Pearson.
//
// FSI data sourced from the Fund for Peace under non-commercial academic license.
// WorldMonitor uses FSI scores for internal validation benchmarking only.
// FSI scores are NOT displayed in the product UI or included in the public ranking.

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

const INFORM_CSV_URL = 'https://drmkc.jrc.ec.europa.eu/inform-index/Portals/0/InfoRM/INFORM_Composite_2024.csv';
const NDGAIN_CSV_URL = 'https://gain.nd.edu/assets/522870/nd_gain_countryindex_2023data.csv';
const WRI_CSV_URL = 'https://weltrisikobericht.de/download/2944/';
const FSI_CSV_URL = 'https://fragilestatesindex.org/wp-content/uploads/2024/06/fsi-2024.csv';

export const HYPOTHESES = [
  { index: 'INFORM', pillar: 'overall', direction: 'negative', minSpearman: 0.60 },
  { index: 'ND-GAIN', pillar: 'structural-readiness', direction: 'positive', minSpearman: 0.65 },
  { index: 'WorldRiskIndex', pillar: 'overall', direction: 'negative', minSpearman: 0.55 },
  { index: 'FSI', pillar: 'overall', direction: 'negative', minSpearman: 0.60 },
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

export async function fetchInformGlobal() {
  const { text, source } = await fetchCSV(INFORM_CSV_URL, 'INFORM');
  if (!text) return { scores: new Map(), source };
  const rows = parseCSV(text);
  const scores = new Map();
  let isoCol = findColumn(Object.keys(rows[0] || {}), 'iso3', 'iso', 'country_iso');
  let scoreCol = findColumn(Object.keys(rows[0] || {}), 'inform_risk', 'inform', 'risk_score', 'composite');
  for (const row of rows) {
    const keys = Object.keys(row);
    const code = toIso2(row[isoCol || keys[0]]);
    const val = parseFloat(row[scoreCol || keys[keys.length - 1]]);
    if (code && !Number.isNaN(val)) scores.set(code, val);
  }
  return { scores, source };
}

export async function fetchNdGain() {
  const { text, source } = await fetchCSV(NDGAIN_CSV_URL, 'ND-GAIN');
  if (!text) return { scores: new Map(), source };
  const rows = parseCSV(text);
  const scores = new Map();
  const isoCol = findColumn(Object.keys(rows[0] || {}), 'iso3', 'iso', 'country');
  const scoreCol = findColumn(Object.keys(rows[0] || {}), 'gain', 'nd-gain', 'score', 'readiness', 'index');
  for (const row of rows) {
    const keys = Object.keys(row);
    const code = toIso2(row[isoCol || keys[0]]);
    const val = parseFloat(row[scoreCol || keys[keys.length - 1]]);
    if (code && !Number.isNaN(val)) scores.set(code, val);
  }
  return { scores, source };
}

export async function fetchWorldRiskIndex() {
  const { text, source } = await fetchCSV(WRI_CSV_URL, 'WorldRiskIndex');
  if (!text) return { scores: new Map(), source };
  const rows = parseCSV(text);
  const scores = new Map();
  const isoCol = findColumn(Object.keys(rows[0] || {}), 'iso3', 'iso', 'country_code');
  const scoreCol = findColumn(Object.keys(rows[0] || {}), 'worldriskindex', 'wri', 'risk_index', 'score');
  for (const row of rows) {
    const keys = Object.keys(row);
    const code = toIso2(row[isoCol || keys[0]]);
    const val = parseFloat(row[scoreCol || keys[keys.length - 1]]);
    if (code && !Number.isNaN(val)) scores.set(code, val);
  }
  return { scores, source };
}

export async function fetchFsi() {
  const { text, source } = await fetchCSV(FSI_CSV_URL, 'FSI');
  if (!text) return { scores: new Map(), source };
  const rows = parseCSV(text);
  const scores = new Map();
  const isoCol = findColumn(Object.keys(rows[0] || {}), 'iso', 'country_code', 'code');
  const scoreCol = findColumn(Object.keys(rows[0] || {}), 'total', 'fsi', 'score', 'fragility');
  for (const row of rows) {
    const keys = Object.keys(row);
    const code = toIso2(row[isoCol || keys[0]]);
    const val = parseFloat(row[scoreCol || keys[keys.length - 1]]);
    if (code && !Number.isNaN(val)) scores.set(code, val);
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
    'ND-GAIN': wmHigh
      ? `${countryCode}: WM structural readiness aligns with ND-GAIN readiness; external rank ${direction} than expected`
      : `${countryCode}: WM structural readiness diverges from ND-GAIN; possible data-vintage or indicator-coverage gap`,
    'WorldRiskIndex': wmHigh
      ? `${countryCode}: WM rates resilience high; WRI emphasizes exposure/vulnerability dimensions differently`
      : `${countryCode}: WM rates resilience low; WRI susceptibility weighting drives rank ${direction}`,
    'FSI': wmHigh
      ? `${countryCode}: WM resilience high; FSI fragility captures governance/legitimacy dimensions WM weights differently`
      : `${countryCode}: WM resilience low; FSI cohesion/economic indicators drive ${direction} fragility rank`,
  };
  return templates[indexName] || `${countryCode}: WM diverges from ${indexName} by ${residual} sigma`;
}

function median(arr) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function readWmScoresFromRedis() {
  const { url, token } = getRedisCredentials();
  const rankingResp = await fetch(`${url}/get/${encodeURIComponent('resilience:ranking:v9')}`, {
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
  // The ranking cache stores a GetResilienceRankingResponse object
  // with { items, greyedOut }, not a bare array.
  const ranking = Array.isArray(parsed) ? parsed : (parsed?.items ?? []);
  const scores = new Map();
  for (const item of ranking) {
    if (item.countryCode && typeof item.overallScore === 'number' && item.overallScore > 0) {
      scores.set(item.countryCode, item.overallScore);
    }
  }
  console.log(`[benchmark] Read ${scores.size} WM resilience scores from Redis`);
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
    { name: 'ND-GAIN', fn: opts.fetchNdGain || fetchNdGain },
    { name: 'WorldRiskIndex', fn: opts.fetchWri || fetchWorldRiskIndex },
    { name: 'FSI', fn: opts.fetchFsi || fetchFsi },
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
    license: 'FSI data: Fund for Peace, non-commercial academic license. For internal validation only.',
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
