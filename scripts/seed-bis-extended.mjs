#!/usr/bin/env node

/**
 * BIS Extended seeder — ships 2 of 7 BIS dataflows flagged as genuinely new
 * signals with clear plug-ins (see issue koala73/worldmonitor#3026):
 *
 *   WS_DSR   household debt service ratio (% income, quarterly)
 *            → leading indicator of household financial stress
 *   WS_SPP   residential property prices (real, index, quarterly)
 *            → housing cycle early-warning
 *   WS_CPP   commercial property prices (real, index, quarterly)
 *            → commercial-property cycle companion to WS_SPP
 *
 * The 3 legacy BIS dataflows (WS_CBPOL, WS_EER, WS_TC) continue to live in
 * seed-bis-data.mjs; this script stays isolated so a schema change in one
 * batch doesn't take the other down. Extras are written via the same
 * afterPublish + writeExtraKey pattern used by seed-bis-data.mjs.
 *
 * Gold-standard pattern:
 *   - TTL = 3 days ≥ 3× 12h cron interval
 *   - atomic publish + extras written via writeExtraKey
 *   - seed-meta written under seed-meta:economic:bis-extended (runSeed)
 *   - health maxStaleMin = 24h = 2× interval (see api/health.js)
 */

import { loadEnvFile, CHROME_UA, runSeed, writeExtraKey, extendExistingTtl, writeSeedMeta } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const BIS_BASE = 'https://stats.bis.org/api/v1/data';

// Keep this aligned with the BIS_COUNTRIES map in seed-bis-data.mjs and
// server/worldmonitor/economic/v1/_bis-shared.ts. BIS uses XM for Euro Area.
const BIS_COUNTRIES = {
  US: { name: 'United States' },
  GB: { name: 'United Kingdom' },
  JP: { name: 'Japan' },
  XM: { name: 'Euro Area' },
  CH: { name: 'Switzerland' },
  SG: { name: 'Singapore' },
  IN: { name: 'India' },
  AU: { name: 'Australia' },
  CN: { name: 'China' },
  CA: { name: 'Canada' },
  KR: { name: 'South Korea' },
  BR: { name: 'Brazil' },
  DE: { name: 'Germany' },
  FR: { name: 'France' },
  IT: { name: 'Italy' },
  ES: { name: 'Spain' },
  NL: { name: 'Netherlands' },
  SE: { name: 'Sweden' },
  NO: { name: 'Norway' },
  DK: { name: 'Denmark' },
  FI: { name: 'Finland' },
  BE: { name: 'Belgium' },
  IE: { name: 'Ireland' },
  PT: { name: 'Portugal' },
  AT: { name: 'Austria' },
  GR: { name: 'Greece' },
  PL: { name: 'Poland' },
  CZ: { name: 'Czech Republic' },
  HU: { name: 'Hungary' },
  TR: { name: 'Türkiye' },
  ZA: { name: 'South Africa' },
  MX: { name: 'Mexico' },
  CL: { name: 'Chile' },
  CO: { name: 'Colombia' },
  NZ: { name: 'New Zealand' },
  HK: { name: 'Hong Kong SAR' },
  ID: { name: 'Indonesia' },
  MY: { name: 'Malaysia' },
  TH: { name: 'Thailand' },
  PH: { name: 'Philippines' },
  RU: { name: 'Russia' },
  IL: { name: 'Israel' },
};

const BIS_COUNTRY_KEYS = Object.keys(BIS_COUNTRIES).join('+');

export const KEYS = {
  dsr: 'economic:bis:dsr:v1',
  spp: 'economic:bis:property-residential:v1',
  cpp: 'economic:bis:property-commercial:v1',
};

// Per-dataset seed-meta keys. Each is ONLY written when that dataset actually
// published fresh entries — so a DSR-only outage cleanly stales bisDsr in
// health.js while leaving bisPropertyResidential / bisPropertyCommercial green.
// The aggregate seed-meta:economic:bis-extended (written by runSeed) is kept
// as a "seeder ran at all" signal in api/seed-health.js.
export const META_KEYS = {
  dsr: 'seed-meta:economic:bis-dsr',
  spp: 'seed-meta:economic:bis-property-residential',
  cpp: 'seed-meta:economic:bis-property-commercial',
};

// Quarterly data, seeded on 12h cron. 3-day TTL absorbs 2 missed cycles.
const TTL = 3 * 24 * 3600;

// ── HTTP / CSV helpers ─────────────────────────────────────────────────────

async function fetchBisCSV(dataset, keySuffix) {
  const url = `${BIS_BASE}/${dataset}/${keySuffix}${keySuffix.includes('?') ? '&' : '?'}format=csv`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'text/csv' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw Object.assign(new Error(`BIS HTTP ${resp.status} for ${dataset} (${keySuffix})`), { status: resp.status });
  return resp.text();
}

// BIS sometimes rejects startPeriod/endPeriod on specific dataflows. Retry
// without them before surrendering. Broader key (wildcards) is tried last.
export async function fetchBisDataflow(dataset, { countryKeys, startPeriod }) {
  const variants = [];
  if (startPeriod) variants.push(`Q.${countryKeys}?startPeriod=${startPeriod}&detail=dataonly`);
  variants.push(`Q.${countryKeys}?detail=dataonly`);
  variants.push(`Q.${countryKeys}`);
  let lastErr;
  for (const suffix of variants) {
    try {
      return await fetchBisCSV(dataset, suffix);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error(`${dataset}: all fetch variants exhausted`);
}

export function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { result.push(current.trim()); current = ''; }
      else { current += ch; }
    }
  }
  result.push(current.trim());
  return result;
}

export function parseBisCSV(csv) {
  const lines = csv.split('\n');
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const vals = parseCSVLine(line);
    const row = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = vals[j] || '';
    rows.push(row);
  }
  return rows;
}

function parseBisNumber(val) {
  if (!val || val === '.' || val.trim() === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

// Shift a BIS quarter string by `delta` quarters. Returns null on unparsable
// inputs so callers can fall back to their empty-data path.
export function shiftQuarter(period, delta) {
  const m = /^(\d{4})-Q([1-4])$/.exec(period ?? '');
  if (!m) return null;
  let year = Number(m[1]);
  let quarter = Number(m[2]) + delta;
  while (quarter < 1) { quarter += 4; year -= 1; }
  while (quarter > 4) { quarter -= 4; year += 1; }
  return `${year}-Q${quarter}`;
}

// BIS returns quarters as `2023-Q3`. Normalise to first day of quarter.
export function quarterToDate(period) {
  if (!period) return null;
  const m = /^(\d{4})-Q([1-4])$/.exec(period);
  if (!m) return period; // let through anything that's already YYYY-MM or YYYY-MM-DD
  const year = m[1];
  const month = ({ '1': '01', '2': '04', '3': '07', '4': '10' })[m[2]];
  return `${year}-${month}-01`;
}

// ── Series selection ───────────────────────────────────────────────────────

// Score a CSV row's series fit against a preferences map.
// Each dimension preference either:
//   - 'match' adds +2
//   - 'mismatch' subtracts −1
//   - 'unknown' (column absent) is neutral
// Ties broken by observation count (longer series wins).
function scoreSeriesMatch(firstRow, prefs) {
  let score = 0;
  for (const [dim, want] of Object.entries(prefs)) {
    const v = firstRow[dim];
    if (v === undefined || v === null || v === '') continue;
    score += (v === want) ? 2 : -1;
  }
  return score;
}

// A "series" = all rows sharing the same dimension key (all columns except
// TIME_PERIOD / OBS_VALUE). Pick the best series per country using prefs and
// observation count, then emit the full time-series for the winner.
export function selectBestSeriesByCountry(rows, { countryColumns, prefs }) {
  const groupedByCountry = new Map();
  for (const row of rows) {
    const cc = countryColumns.map(col => row[col]).find(v => v && /^[A-Z]{2}$/.test(v));
    if (!cc) continue;
    const date = row.TIME_PERIOD || row['Time period'] || '';
    const val = parseBisNumber(row.OBS_VALUE ?? row['Observation value']);
    if (!date || val === null) continue;

    // Build a stable series key from the row (everything that uniquely
    // identifies a time series, minus the observation coordinates).
    const omit = new Set(['TIME_PERIOD', 'Time period', 'OBS_VALUE', 'Observation value']);
    const sigParts = [];
    for (const [k, v] of Object.entries(row)) {
      if (omit.has(k)) continue;
      sigParts.push(`${k}=${v}`);
    }
    const seriesKey = sigParts.join('|');
    if (!groupedByCountry.has(cc)) groupedByCountry.set(cc, new Map());
    const perCountry = groupedByCountry.get(cc);
    if (!perCountry.has(seriesKey)) perCountry.set(seriesKey, { firstRow: row, obs: [] });
    perCountry.get(seriesKey).obs.push({ date, value: val });
  }

  const out = new Map();
  for (const [cc, perCountry] of groupedByCountry) {
    let best = null;
    let bestScore = -Infinity;
    let bestLen = -1;
    for (const info of perCountry.values()) {
      const s = scoreSeriesMatch(info.firstRow, prefs);
      if (s > bestScore || (s === bestScore && info.obs.length > bestLen)) {
        best = info;
        bestScore = s;
        bestLen = info.obs.length;
      }
    }
    if (best) {
      best.obs.sort((a, b) => a.date.localeCompare(b.date));
      out.set(cc, best.obs);
    }
  }
  return out;
}

function latestTwo(obs) {
  if (!obs || obs.length === 0) return { latest: null, previous: null };
  const latest = obs[obs.length - 1];
  const previous = obs.length >= 2 ? obs[obs.length - 2] : null;
  return { latest, previous };
}

function pctChange(latest, prev) {
  if (latest == null || prev == null || prev === 0) return null;
  return Math.round(((latest - prev) / prev) * 1000) / 10;
}

// ── Dataflow builders ──────────────────────────────────────────────────────

// Household debt service ratio. BIS_DSR key dimensions:
// FREQ.BORROWERS_CTY.DSR_BORROWERS e.g. Q.US.H (households), Q.US.P (private
// non-financial). The UI labels this "Household DSR" and resilience scoring
// uses it as `householdDebtService`, so we MUST prefer H — picking P would
// mislabel private-non-financial data as household data. Countries without
// an H series are dropped (honest absence beats silent mis-attribution).
export function buildDsr(rows) {
  const byCountry = selectBestSeriesByCountry(rows, {
    countryColumns: ['BORROWERS_CTY', 'REF_AREA', 'Reference area', 'Borrowers\u2019 country'],
    prefs: {
      DSR_BORROWERS: 'H', // households
      DSR_ADJUST: 'A',    // adjusted
    },
  });

  const entries = [];
  for (const [cc, obs] of byCountry) {
    const info = BIS_COUNTRIES[cc];
    if (!info) continue;
    const { latest, previous } = latestTwo(obs);
    if (!latest) continue;
    entries.push({
      countryCode: cc,
      countryName: info.name,
      dsrPct: Math.round(latest.value * 10) / 10,
      previousDsrPct: previous ? Math.round(previous.value * 10) / 10 : null,
      change: pctChange(latest.value, previous?.value),
      date: quarterToDate(latest.date),
      period: latest.date,
    });
  }
  return entries;
}

// Residential or commercial property prices, real (PP_VALUATION=R) index
// (UNIT_MEASURE=628). Some series use UNIT_MEASURE=771 (YoY change %) which
// we de-prefer so that the headline value is the price index level.
export function buildPropertyPrices(rows, kind /* 'residential' | 'commercial' */) {
  const byCountry = selectBestSeriesByCountry(rows, {
    countryColumns: ['REF_AREA', 'Reference area'],
    prefs: {
      PP_VALUATION: 'R',   // real
      UNIT_MEASURE: '628', // index
    },
  });

  const entries = [];
  for (const [cc, obs] of byCountry) {
    const info = BIS_COUNTRIES[cc];
    if (!info) continue;
    const { latest, previous } = latestTwo(obs);
    if (!latest) continue;
    // Year-over-year = same quarter one year ago. Match by exact period
    // rather than index-offset so missing quarters don't silently skew YoY.
    const yoyPeriod = shiftQuarter(latest.date, -4);
    const yoyPrev = yoyPeriod ? obs.find(o => o.date === yoyPeriod) : null;
    entries.push({
      countryCode: cc,
      countryName: info.name,
      kind,
      indexValue: Math.round(latest.value * 10) / 10,
      previousIndex: previous ? Math.round(previous.value * 10) / 10 : null,
      qoqChange: pctChange(latest.value, previous?.value),
      yoyChange: pctChange(latest.value, yoyPrev?.value),
      date: quarterToDate(latest.date),
      period: latest.date,
    });
  }
  return entries;
}

// ── Fetchers ───────────────────────────────────────────────────────────────

function startPeriodYearsAgo(years) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return `${d.getFullYear()}-Q1`;
}

async function fetchDsr() {
  const csv = await fetchBisDataflow('WS_DSR', {
    countryKeys: BIS_COUNTRY_KEYS,
    startPeriod: startPeriodYearsAgo(3),
  });
  const entries = buildDsr(parseBisCSV(csv));
  console.log(`  BIS DSR: ${entries.length} countries`);
  return entries.length > 0 ? { entries, fetchedAt: new Date().toISOString() } : null;
}

async function fetchProperty(dataset, kind) {
  const csv = await fetchBisDataflow(dataset, {
    countryKeys: BIS_COUNTRY_KEYS,
    startPeriod: startPeriodYearsAgo(5),
  });
  const entries = buildPropertyPrices(parseBisCSV(csv), kind);
  console.log(`  BIS ${dataset}: ${entries.length} countries`);
  return entries.length > 0 ? { entries, fetchedAt: new Date().toISOString() } : null;
}

// Each dataset is handled independently: a single fetch failure in any ONE
// of DSR/SPP/CPP must not block the healthy ones from publishing fresh data.
// We do SPP/CPP writes as side-effects of fetchAll (via writeExtraKey or
// extendExistingTtl, per-dataset). The DSR slice flows through the normal
// runSeed canonical-write path; when DSR is empty, publishTransform yields
// an empty payload that fails validate() → atomicPublish.skipped=true →
// runSeed extends the canonical DSR key's TTL in its own skipped branch.
export async function fetchAll() {
  const [dsr, spp, cpp] = await Promise.all([
    fetchDsr().catch(err => { console.warn(`  DSR failed: ${err.message}`); return null; }),
    fetchProperty('WS_SPP', 'residential').catch(err => { console.warn(`  SPP failed: ${err.message}`); return null; }),
    fetchProperty('WS_CPP', 'commercial').catch(err => { console.warn(`  CPP failed: ${err.message}`); return null; }),
  ]);
  const total = (dsr?.entries?.length || 0) + (spp?.entries?.length || 0) + (cpp?.entries?.length || 0);
  if (total === 0) throw new Error('All BIS extended fetches returned empty');

  // Publish SPP/CPP independently NOW — they must not be gated on DSR. Any
  // that came back empty get their existing snapshot's TTL extended so a
  // transient upstream failure doesn't silently expire healthy data.
  await publishDatasetIndependently(KEYS.spp, spp, META_KEYS.spp);
  await publishDatasetIndependently(KEYS.cpp, cpp, META_KEYS.cpp);

  // NOTE: DSR per-dataset seed-meta is written by `dsrAfterPublish` (passed to
  // runSeed below), NOT here. That guarantees seed-meta:economic:bis-dsr is
  // refreshed only AFTER atomicPublish succeeds on the canonical DSR key — a
  // Redis hiccup at publish time must not leave health reporting "fresh"
  // while the canonical key is stale.

  return { dsr, spp, cpp };
}

// runSeed afterPublish hook — fires only on a successful atomicPublish of the
// canonical DSR key. `data` is the raw fetchAll() return value; we re-derive
// the DSR slice and refresh its per-dataset seed-meta.
export async function dsrAfterPublish(data) {
  if (planDatasetAction(data?.dsr) !== 'write') return;
  await writeSeedMeta(KEYS.dsr, data.dsr.entries.length, META_KEYS.dsr).catch(() => {});
}

// Pure decision function: classifies what action should be taken for a
// dataset slice (write fresh vs. extend existing TTL). Unit-testable; the
// Redis side-effects live in publishDatasetIndependently below.
export function planDatasetAction(payload) {
  if (payload && Array.isArray(payload.entries) && payload.entries.length > 0) {
    return 'write';
  }
  return 'extend';
}

export async function publishDatasetIndependently(key, payload, metaKey) {
  const action = planDatasetAction(payload);
  if (action === 'write') {
    try {
      await writeExtraKey(key, payload, TTL);
      // Per-dataset seed-meta is written ONLY on a successful fresh write.
      // On the extend-TTL branch we deliberately do NOT refresh seed-meta —
      // that is what lets api/health.js flag a stale per-dataset outage.
      if (metaKey) {
        await writeSeedMeta(key, payload.entries.length, metaKey).catch(() => {});
      }
    } catch (err) {
      console.warn(`  ${key}: write failed (${err.message}); extending existing TTL`);
      await extendExistingTtl([key], TTL).catch(() => {});
    }
  } else {
    await extendExistingTtl([key], TTL).catch(() => {});
  }
}

// validate() is invoked by atomicPublish against the POST-publishTransform
// payload (the DSR slice). Returning false when DSR is empty makes runSeed
// take its skipped branch, which extends the canonical DSR key's TTL and
// refreshes seed-meta without overwriting the existing DSR snapshot.
export function validate(publishData) {
  return Array.isArray(publishData?.entries) && publishData.entries.length > 0;
}

export function publishTransform(data) {
  return data.dsr && data.dsr.entries?.length > 0
    ? data.dsr
    : { entries: [] };
}

if (process.argv[1]?.endsWith('seed-bis-extended.mjs')) {
  runSeed('economic', 'bis-extended', KEYS.dsr, fetchAll, {
    validateFn: validate,
    ttlSeconds: TTL,
    sourceVersion: 'bis-sdmx-csv-extended',
    publishTransform,
    afterPublish: dsrAfterPublish,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
