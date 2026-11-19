#!/usr/bin/env node
//
// Cross-country capital flows — where money is leaving and where it is going.
// Canonical key: economic:capital-flows:v1
//
// Three official sources, all free and keyless:
//
//   1. IMF Balance of Payments (IMF.STA/BOP, SDMX 3.0). Gross financial-account
//      flows, ex reserves: inflows = L_NIL_T (non-residents' new claims on the
//      country), outflows = A_NFA_T (residents' new claims abroad), each the sum
//      of D_F (direct), P_F (portfolio) and O_F (other investment). Quarterly
//      where reported, annual otherwise (some economies report annual only).
//      Quarterly series are classified with Forbes & Warnock (2012) — see
//      _capital-flow-episodes.mjs. Values are raw USD on the wire.
//
//   2. BIS Locational Banking Statistics (WS_LBS_D_PUB). Cross-border bank
//      positions by reporting country × counterparty country × sector. An
//      empty key position expands to every code, so the pair query leaves
//      reporter and counterparty empty, and the totals query names reporter
//      5A (all reporting countries). L_MEASURE F is the FX- and
//      break-adjusted change, the right flow measure. Values are USD millions.
//      Only ~30 jurisdictions publish a bilateral breakdown; deposits placed in
//      the others are invisible here.
//
//   3. IMF Portfolio Investment Positions (IMF.STA/PIP, formerly CPIS). Who
//      holds whose securities. Summing every reporter's holdings OF a country
//      gives the mirror measure of foreign portfolio money in that country.
//
//   4. IMF Direct Investment Positions (IMF.STA/DIP, formerly CDIS). FDI
//      positions by immediate counterpart, reported by both sides of a pair.
//
// Bilateral matrices for all three bilateral sources go to PAIRS_KEY so any
// country pair can be read in both directions.
//
// Everything is measured official data except the episode labels, which are
// derived (basis: "derived"). Wealth migration — a person changing residence —
// is not a BOP transaction under BPM6, so it does not appear in these flows.
//
// Output (USD billions throughout):
//   { countries: { [iso2]: { iso2, iso3, bop, bank, portfolio } },
//     latest: { bopQuarter, bopYear, bisQuarter, pipYear },
//     coverage: {...}, sources, method, seededAt }

import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import { loadEnvFile, CHROME_UA, runSeed, resolveProxyForConnect, httpsProxyFetchRaw, imfAuthHeaders } from './_seed-utils.mjs';
import { tokensToContentMeta, DAY_MIN } from './_content-age-helpers.mjs';
import { sumGrossFlows, classifyCountry, nextQuarter } from './_capital-flow-episodes.mjs';
import iso3ToIso2 from './shared/iso3-to-iso2.json' with { type: 'json' };

loadEnvFile(import.meta.url);

const _proxyAuth = resolveProxyForConnect();

export const CANONICAL_KEY = 'economic:capital-flows:v1';
// Full bilateral matrices (bank and portfolio), read for country-pair queries.
export const PAIRS_KEY = 'economic:capital-flows:pairs:v1';
// Durable activation marker (no TTL). Until it exists, /api/health softens a
// missing key to the on-demand warn, so the reader can ship before the weekly
// bundle's first publish.
export const CAPITAL_FLOWS_ACTIVATION_KEY = 'seed-activated:economic:capital-flows';
export const CACHE_TTL = 100 * 24 * 3600; // quarterly sources; outlives a missed publish
// Newest IMF BOP quarter is normally 1–2 quarters old. 12 months flags a frozen
// feed after ~two missed quarterly releases.
export const CAPITAL_FLOWS_MAX_CONTENT_AGE_MIN = 12 * 30 * DAY_MIN;
// seed-bundle-macro gives the section 300s. The fetch phase ends 50s before
// that, leaving runSeed's publish reserve; the lock outlives the section.
export const FETCH_PHASE_TIMEOUT_MS = 250_000;
export const LOCK_TTL_MS = 330_000;

const IMF_BASE = 'https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.STA';
const BIS_BASE = 'https://stats.bis.org/api/v1/data/WS_LBS_D_PUB';
const WB_GDP_URL = 'https://api.worldbank.org/v2/country/all/indicator/NY.GDP.MKTP.CD?format=json&per_page=500&mrv=3';

// Quarters of BOP history fetched: Forbes-Warnock needs 8 quarters for one ΔC
// value plus a 16–20 quarter window, and we report episodes from the last 10y.
const BOP_HISTORY_YEARS = 16;
const QUARTERLY_SERIES_KEPT = 12;
const ANNUAL_SERIES_KEPT = 6;
const EPISODE_LOOKBACK_YEARS = 10;
const TOP_N = 5;
// A country is "quarterly" only if its quarterly BOP is reasonably current.
const QUARTERLY_STALE_YEARS = 2;

const bn = (usd) => (Number.isFinite(usd) ? Math.round(usd / 1e7) / 100 : null); // raw USD → bn, 2dp
const bnFromMillions = (m) => (Number.isFinite(m) ? Math.round(m / 10) / 100 : null);
const pct = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

export function toIso2(iso3) {
  if (typeof iso3 !== 'string' || !/^[A-Z]{3}$/.test(iso3)) return null;
  return iso3ToIso2[iso3] ?? null;
}

const ISO2_SET = new Set(Object.values(iso3ToIso2));
const ISO2_TO_ISO3 = Object.fromEntries(Object.entries(iso3ToIso2).map(([k, v]) => [v, k]));

// BIS counterparty / reporter codes: ISO2 for countries, digit-bearing codes
// for aggregates (5A, 5J, 1C …). Keep only real ISO2 countries.
export function isBisCountry(code) {
  return typeof code === 'string' && /^[A-Z]{2}$/.test(code) && ISO2_SET.has(code);
}

// ── HTTP ────────────────────────────────────────────────────────────────────

// One direct attempt, then one proxy attempt carrying the same headers (the
// IMF subscription key among them). Worst case per call is 2 × timeoutMs; the
// per-call timeouts in fetchCapitalFlows keep that inside FETCH_PHASE_TIMEOUT_MS.
async function fetchJson(url, { accept = 'application/json', timeoutMs = 60_000, headers = {} } = {}) {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: accept, ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url.split('?')[0]}`);
    return await resp.json();
  } catch (directErr) {
    if (!_proxyAuth) throw directErr;
    console.warn(`  direct fetch failed (${directErr.message}), retrying via proxy`);
    const { buffer } = await httpsProxyFetchRaw(url, _proxyAuth, { accept, timeoutMs, headers });
    return JSON.parse(buffer.toString('utf8'));
  }
}

// ── SDMX parsing ────────────────────────────────────────────────────────────

// IMF SDMX 3.0 JSON → [{ ...dimId: code, period, value }]
export function parseImfSdmx(json) {
  const ds = json?.data?.dataSets?.[0];
  const st = json?.data?.structures?.[Number.isInteger(ds?.structure) ? ds.structure : 0];
  if (!ds?.series || !st?.dimensions?.series) return [];
  const dims = st.dimensions.series;
  const tv = st.dimensions.observation?.[0]?.values ?? [];
  const rows = [];
  for (const [key, s] of Object.entries(ds.series)) {
    const idx = key.split(':').map(Number);
    const base = {};
    for (let i = 0; i < dims.length; i++) base[dims[i].id] = dims[i].values[idx[i]]?.id;
    for (const [oi, obs] of Object.entries(s.observations ?? {})) {
      const raw = Array.isArray(obs) ? obs[0] : null;
      if (raw == null || raw === '') continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      const t = tv[Number(oi)];
      rows.push({ ...base, period: t?.value ?? t?.id, value });
    }
  }
  return rows;
}

// BIS SDMX-JSON 1.0 → [{ ...dimId: code, period, value }]
export function parseBisSdmx(json) {
  const ds = json?.data?.dataSets?.[0] ?? json?.dataSets?.[0];
  const st = json?.data?.structure ?? json?.structure;
  if (!ds?.series || !st?.dimensions?.series) return [];
  const dims = st.dimensions.series;
  const tv = st.dimensions.observation?.[0]?.values ?? [];
  const rows = [];
  for (const [key, s] of Object.entries(ds.series)) {
    const idx = key.split(':').map(Number);
    const base = {};
    for (let i = 0; i < dims.length; i++) base[dims[i].id] = dims[i].values[idx[i]]?.id;
    for (const [oi, obs] of Object.entries(s.observations ?? {})) {
      const raw = Array.isArray(obs) ? obs[0] : null;
      if (raw == null || raw === '' || raw === 'NaN') continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      rows.push({ ...base, period: tv[Number(oi)]?.id, value });
    }
  }
  return rows;
}

// ── BOP ─────────────────────────────────────────────────────────────────────

function groupBy(rows, keyFn) {
  const out = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}

function componentTable(rows) {
  // period → { in: {D_F,P_F,O_F}, out: {...}, eo }
  const t = new Map();
  for (const r of rows) {
    if (!t.has(r.period)) t.set(r.period, { in: {}, out: {}, eo: null });
    const cell = t.get(r.period);
    if (r.INDICATOR === 'EO') { if (r.BOP_ACCOUNTING_ENTRY === 'NETCD_T') cell.eo = r.value; continue; }
    if (r.BOP_ACCOUNTING_ENTRY === 'L_NIL_T') cell.in[r.INDICATOR] = r.value;
    else if (r.BOP_ACCOUNTING_ENTRY === 'A_NFA_T') cell.out[r.INDICATOR] = r.value;
  }
  return t;
}

function flowRow(period, cell) {
  const side = (o) => {
    const complete = o.D_F != null && o.P_F != null && o.O_F != null;
    return {
      fdi: bn(o.D_F ?? NaN), portfolio: bn(o.P_F ?? NaN), other: bn(o.O_F ?? NaN),
      total: complete ? bn(o.D_F + o.P_F + o.O_F) : null,
    };
  };
  return { period, inflows: side(cell.in), outflows: side(cell.out), errorsOmissions: bn(cell.eo ?? NaN) };
}

function toEntryRows(rows) {
  return rows
    .filter((r) => r.BOP_ACCOUNTING_ENTRY === 'L_NIL_T' || r.BOP_ACCOUNTING_ENTRY === 'A_NFA_T')
    .map((r) => ({ entry: r.BOP_ACCOUNTING_ENTRY, indicator: r.INDICATOR, period: r.period, value: r.value }));
}

// Sum of the last n values, only when their periods are consecutive quarters.
function trailingSum(periods, series, n) {
  if (series.length < n) return null;
  const tail = series.slice(-n);
  const tailPeriods = periods.slice(-n);
  if (tail.some((v) => v == null)) return null;
  for (let i = 1; i < n; i++) if (nextQuarter(tailPeriods[i - 1]) !== tailPeriods[i]) return null;
  return Math.round(tail.reduce((s, v) => s + v, 0) * 100) / 100;
}

// The episode type still open at the latest quarter, among `types`.
export function currentState(episodes, latestPeriod, types = ['surge', 'stop', 'flight', 'retrenchment']) {
  for (const type of types) {
    const ep = episodes[type].at(-1);
    if (ep && ep.end === latestPeriod) return type;
  }
  return null;
}

function quarterYear(p) { return Number(String(p).slice(0, 4)); }

export function buildBopCountry({ quarterlyRows = [], annualRows = [], gdpUsd = null, nowYear = new Date().getUTCFullYear() }) {
  const qInflows = sumGrossFlows(toEntryRows(quarterlyRows), 'L_NIL_T');
  const qOutflows = sumGrossFlows(toEntryRows(quarterlyRows), 'A_NFA_T');
  // Latest quarter BOTH sides report completely (FDI, portfolio and other).
  // When one side is never complete (an economy that does not report one
  // component at all), the other side is classified alone.
  const outflowPeriods = new Set(qOutflows.periods);
  const latestQ = qOutflows.periods.length === 0 ? (qInflows.periods.at(-1) ?? null)
    : qInflows.periods.length === 0 ? (qOutflows.periods.at(-1) ?? null)
      : (qInflows.periods.filter((p) => outflowPeriods.has(p)).at(-1) ?? null);
  const quarterlyUsable = latestQ && nowYear - quarterYear(latestQ) <= QUARTERLY_STALE_YEARS;

  if (quarterlyUsable) {
    // Classify both sides only up to the latest quarter they share, so state,
    // z-scores, episodes and series all describe the same quarter.
    const upTo = ({ periods, values }) => {
      const n = periods.filter((p) => p <= latestQ).length;
      return { periods: periods.slice(0, n), values: values.slice(0, n) };
    };
    const res = classifyCountry({ inflows: upTo(qInflows), outflows: upTo(qOutflows) });
    const fromYear = nowYear - EPISODE_LOOKBACK_YEARS;
    const episodes = {};
    for (const t of ['surge', 'stop', 'flight', 'retrenchment']) {
      episodes[t] = res[t].filter((e) => quarterYear(e.end) >= fromYear);
    }
    const table = componentTable(quarterlyRows);
    const periods = [...table.keys()].filter((p) => p <= latestQ).sort();
    const series = periods.slice(-QUARTERLY_SERIES_KEPT).map((p) => flowRow(p, table.get(p)));
    const inTotals = periods.map((p) => flowRow(p, table.get(p)).inflows.total);
    const outTotals = periods.map((p) => flowRow(p, table.get(p)).outflows.total);
    const in4q = trailingSum(periods, inTotals, 4);
    const out4q = trailingSum(periods, outTotals, 4);
    const round = (z) => (z == null ? null : Math.round(z * 100) / 100);
    return {
      frequency: 'quarterly',
      latestPeriod: latestQ,
      state: {
        inflow: currentState(res, latestQ, ['surge', 'stop']),
        outflow: currentState(res, latestQ, ['flight', 'retrenchment']),
        inflowZ: round(res.inflowZ.get(latestQ) ?? null),
        outflowZ: round(res.outflowZ.get(latestQ) ?? null),
        basis: 'derived',
      },
      episodes,
      trailing4q: {
        inflowsUsdBn: in4q,
        outflowsUsdBn: out4q,
        netUsdBn: in4q != null && out4q != null ? Math.round((in4q - out4q) * 100) / 100 : null,
        inflowsPctGdp: in4q != null && gdpUsd ? pct((in4q * 1e9 * 100) / gdpUsd) : null,
        outflowsPctGdp: out4q != null && gdpUsd ? pct((out4q * 1e9 * 100) / gdpUsd) : null,
      },
      series,
    };
  }

  if (annualRows.length === 0) return null;
  const table = componentTable(annualRows);
  const periods = [...table.keys()].sort();
  const rows = periods.map((p) => flowRow(p, table.get(p))).filter((r) => r.inflows.total != null || r.outflows.total != null);
  if (rows.length === 0) return null;
  const last = rows.at(-1);
  const prior = rows.at(-2);
  const prev = prior && Number(prior.period) === Number(last.period) - 1 ? prior : null;
  const yoy = (a, b) => (a != null && b != null && b !== 0 ? pct(((a - b) / Math.abs(b)) * 100) : null);
  return {
    frequency: 'annual',
    latestPeriod: last.period,
    state: null,
    episodes: null,
    latestYear: {
      inflowsUsdBn: last.inflows.total,
      outflowsUsdBn: last.outflows.total,
      netUsdBn: last.inflows.total != null && last.outflows.total != null ? Math.round((last.inflows.total - last.outflows.total) * 100) / 100 : null,
      inflowsYoyPct: yoy(last.inflows.total, prev?.inflows.total),
      outflowsYoyPct: yoy(last.outflows.total, prev?.outflows.total),
      inflowsPctGdp: last.inflows.total != null && gdpUsd ? pct((last.inflows.total * 1e9 * 100) / gdpUsd) : null,
      outflowsPctGdp: last.outflows.total != null && gdpUsd ? pct((last.outflows.total * 1e9 * 100) / gdpUsd) : null,
    },
    series: rows.slice(-ANNUAL_SERIES_KEPT),
  };
}

// ── BIS LBS ─────────────────────────────────────────────────────────────────

// Latest stock and trailing 4-quarter adjusted flow for one series of rows.
// Rows hold one series (fixed dims) with L_MEASURE S and F mixed.
export function stockAndFlow(rows) {
  const stocks = rows.filter((r) => r.L_MEASURE === 'S').sort((a, b) => a.period.localeCompare(b.period));
  const flows = rows.filter((r) => r.L_MEASURE === 'F').sort((a, b) => a.period.localeCompare(b.period));
  const latest = stocks.at(-1) ?? null;
  let flow4q = null;
  if (flows.length >= 4) {
    const tail = flows.slice(-4);
    // Require 4 consecutive quarters ending at the latest flow quarter.
    let ok = true;
    for (let i = 1; i < 4; i++) if (nextQuarter(tail[i - 1].period) !== tail[i].period) ok = false;
    // The flow window must end at the reported stock quarter.
    if (latest && tail[3].period !== latest.period) ok = false;
    if (ok) flow4q = tail.reduce((s, r) => s + r.value, 0);
  }
  return {
    period: latest?.period ?? flows.at(-1)?.period ?? null,
    stockUsdBn: latest ? bnFromMillions(latest.value) : null,
    flow4qUsdBn: flow4q == null ? null : bnFromMillions(flow4q),
  };
}

// Bilateral bank rows arrive for two instruments: G (loans and deposits) and A
// (all instruments, which adds debt securities). Use G for every reporter that
// publishes it; fall back to A only for reporters that publish no G breakdown,
// and name them so readers can tell the two measures apart.
export function selectBankInstrument(rows) {
  const instrOf = (r) => r.L_INSTR ?? 'G';
  const hasG = new Set(rows.filter((r) => instrOf(r) === 'G' && isBisCountry(r.L_CP_COUNTRY)).map((r) => r.L_REP_CTY));
  const allInstrumentReporters = new Set();
  const kept = rows.filter((r) => {
    const instr = instrOf(r);
    if (hasG.has(r.L_REP_CTY)) return instr === 'G';
    if (instr === 'A') { allInstrumentReporters.add(r.L_REP_CTY); return true; }
    return false;
  });
  return { rows: kept, allInstrumentReporters };
}

// totalsRows: reporter 5A × every counterparty, sectors N and H, positions L and C.
// bilateralRows: every reporter × every counterparty, sector N, positions L and C.
export function buildBankByCountry(totalsRows, bilateralRows) {
  const out = {};
  const totalsRowsClean = totalsRows.filter((r) => r.L_REP_CTY === '5A' && isBisCountry(r.L_CP_COUNTRY));
  // Every position in the view is as of the latest BIS quarter. A series that
  // ended earlier is reported as absent, not as a current figure.
  const latest = totalsRowsClean.filter((r) => r.L_MEASURE === 'S').map((r) => r.period).sort().at(-1) ?? null;
  const current = (sf) => (sf.period === latest ? sf : { period: null, stockUsdBn: null, flow4qUsdBn: null });

  const totals = groupBy(totalsRowsClean, (r) => r.L_CP_COUNTRY);
  for (const [cp, rows] of totals) {
    const pick = (pos, sector) => current(stockAndFlow(rows.filter((r) => r.L_POSITION === pos && r.L_CP_SECTOR === sector)));
    const deposits = pick('L', 'N');
    const household = pick('L', 'H');
    const borrowing = pick('C', 'N');
    out[cp] = {
      latestPeriod: deposits.period ?? borrowing.period ?? household.period,
      nonBankDepositsAbroad: { stockUsdBn: deposits.stockUsdBn, flow4qUsdBn: deposits.flow4qUsdBn },
      householdDepositsAbroad: { stockUsdBn: household.stockUsdBn, flow4qUsdBn: household.flow4qUsdBn },
      nonBankBorrowingFromAbroad: { stockUsdBn: borrowing.stockUsdBn, flow4qUsdBn: borrowing.flow4qUsdBn },
      topBankLocations: [],
      publishesBilateral: false,
      topDepositorOrigins: [],
    };
  }

  const pairs = groupBy(
    selectBankInstrument(bilateralRows).rows.filter((r) => r.L_POSITION === 'L' && r.L_CP_SECTOR === 'N' && isBisCountry(r.L_REP_CTY) && isBisCountry(r.L_CP_COUNTRY) && r.L_REP_CTY !== r.L_CP_COUNTRY),
    (r) => `${r.L_REP_CTY}|${r.L_CP_COUNTRY}`,
  );
  const byCp = new Map();
  const byRep = new Map();
  for (const [k, rows] of pairs) {
    const [rep, cp] = k.split('|');
    const sf = current(stockAndFlow(rows));
    if (sf.stockUsdBn == null) continue;
    if (!byCp.has(cp)) byCp.set(cp, []);
    byCp.get(cp).push({ iso2: rep, ...sf });
    if (!byRep.has(rep)) byRep.set(rep, []);
    byRep.get(rep).push({ iso2: cp, ...sf });
  }
  const top = (list) => list
    .sort((a, b) => b.stockUsdBn - a.stockUsdBn)
    .slice(0, TOP_N)
    .map(({ iso2, stockUsdBn, flow4qUsdBn }) => ({ iso2, stockUsdBn, flow4qUsdBn }));
  for (const [cp, list] of byCp) {
    if (out[cp]) out[cp].topBankLocations = top(list);
  }
  for (const [rep, list] of byRep) {
    if (!out[rep]) continue;
    // True only when the country's banks publish a by-counterparty breakdown;
    // some reporting systems publish aggregates only.
    out[rep].publishesBilateral = true;
    out[rep].topDepositorOrigins = top(list);
  }
  return { byCountry: out, latestPeriod: latest };
}

// Full bank matrix: byReporter[rep][cp] = [depositsStock, depositsFlow4q,
// lendingStock, lendingFlow4q] in USD bn, where deposits are rep-located
// banks' liabilities to cp's non-banks and lending their claims on them.
// `reporters` lists systems that publish at least one bilateral position, so a
// reader can tell "no position" from "not published".
//
// `quarters` lists the last PAIR_HISTORY_QUARTERS quarters ending at `period`;
// cells [4] and [5] are the deposit and lending adjusted flows for those
// quarters, aligned to `quarters`, null where not reported.
export const PAIR_HISTORY_QUARTERS = 8;

export function buildBankPairs(bilateralRows) {
  const { rows: selected, allInstrumentReporters } = selectBankInstrument(bilateralRows);
  const rows = selected.filter((r) => r.L_CP_SECTOR === 'N' && (r.L_POSITION === 'L' || r.L_POSITION === 'C')
    && isBisCountry(r.L_REP_CTY) && isBisCountry(r.L_CP_COUNTRY) && r.L_REP_CTY !== r.L_CP_COUNTRY);
  const grouped = groupBy(rows, (r) => `${r.L_REP_CTY}|${r.L_CP_COUNTRY}`);
  const stockPeriods = rows.filter((r) => r.L_MEASURE === 'S').map((r) => r.period).sort();
  const period = stockPeriods.at(-1) ?? null;
  const quarters = [];
  if (period) {
    let q = period;
    for (let i = 0; i < PAIR_HISTORY_QUARTERS; i++) {
      quarters.unshift(q);
      const [y, n] = q.split('-Q').map(Number);
      q = n === 1 ? `${y - 1}-Q4` : `${y}-Q${n - 1}`;
    }
  }
  const history = (list) => {
    const byPeriod = new Map(list.filter((r) => r.L_MEASURE === 'F').map((r) => [r.period, r.value]));
    const values = quarters.map((p) => (byPeriod.has(p) ? bnFromMillions(byPeriod.get(p)) : null));
    return values.some((v) => v != null) ? values : null;
  };
  const byReporter = {};
  for (const [k, list] of grouped) {
    const [rep, cp] = k.split('|');
    const depRows = list.filter((r) => r.L_POSITION === 'L');
    const lendRows = list.filter((r) => r.L_POSITION === 'C');
    // A leg whose series ended before the matrix quarter has no current
    // position; keep its history (labelled by quarter) but not a stock or flow
    // that would read as current.
    const current = (sf) => (sf.period === period ? sf : { stockUsdBn: null, flow4qUsdBn: null });
    const dep = current(stockAndFlow(depRows));
    const lend = current(stockAndFlow(lendRows));
    const depHistory = history(depRows);
    const lendHistory = history(lendRows);
    if (dep.stockUsdBn == null && lend.stockUsdBn == null && !depHistory && !lendHistory) continue;
    (byReporter[rep] ??= {})[cp] = [dep.stockUsdBn, dep.flow4qUsdBn, lend.stockUsdBn, lend.flow4qUsdBn, depHistory, lendHistory];
  }
  const reporters = Object.keys(byReporter).sort();
  return {
    period,
    quarters,
    reporters,
    // Reporters whose figures are all instruments (A), not loans and deposits (G).
    allInstrumentReporters: reporters.filter((r) => allInstrumentReporters.has(r)),
    byReporter,
  };
}

// ── IMF PIP ─────────────────────────────────────────────────────────────────

// rows: holder COUNTRY × COUNTERPART_COUNTRY, total portfolio assets (annual).
function cleanPipRows(rows) {
  return rows.filter((r) =>
    r.ACCOUNTING_ENTRY === 'A' && r.INDICATOR === 'P_TOTINV_P_USD' && r.FREQUENCY === 'A' &&
    toIso2(r.COUNTRY) && toIso2(r.COUNTERPART_COUNTRY) && r.COUNTRY !== r.COUNTERPART_COUNTRY);
}

// The newest year is often partial (late reporters). Use the newest year whose
// reporter count is at least 80% of the prior year's.
function selectPipYear(clean) {
  const years = [...new Set(clean.map((r) => String(r.period)))].sort();
  const reporters = (y) => new Set(clean.filter((r) => String(r.period) === y).map((r) => r.COUNTRY)).size;
  let year = years.at(-1) ?? null;
  if (years.length >= 2 && reporters(years.at(-1)) < 0.8 * reporters(years.at(-2))) year = years.at(-2);
  return year;
}

// Full portfolio matrix: byHolder[holder][issuer] = [usdBn, prevYearUsdBn|null].
// `holders` lists economies reporting holdings in the reference year.
export function buildPortfolioPairs(rows) {
  const clean = cleanPipRows(rows);
  const year = selectPipYear(clean);
  if (!year) return { year: null, holders: [], byHolder: {} };
  const prevYear = String(Number(year) - 1);
  const byHolder = {};
  const prev = new Map();
  for (const r of clean) {
    if (String(r.period) === prevYear) prev.set(`${r.COUNTRY}|${r.COUNTERPART_COUNTRY}`, r.value);
  }
  for (const r of clean) {
    if (String(r.period) !== year) continue;
    const before = prev.get(`${r.COUNTRY}|${r.COUNTERPART_COUNTRY}`);
    (byHolder[toIso2(r.COUNTRY)] ??= {})[toIso2(r.COUNTERPART_COUNTRY)] = [bn(r.value), before == null ? null : bn(before)];
  }
  return { year: Number(year), holders: Object.keys(byHolder).sort(), byHolder };
}

export function buildPortfolioByCountry(rows) {
  const clean = cleanPipRows(rows);
  const year = selectPipYear(clean);
  if (!year) return { byCountry: {}, year: null };
  const prevYear = String(Number(year) - 1);

  const out = {};
  const ensure = (iso2) => (out[iso2] ??= {
    year: Number(year), foreignHoldingsUsdBn: null, foreignHoldingsPrevYearUsdBn: null, changePct: null,
    reporterCount: 0, topHolders: [], holdingsAbroadUsdBn: null, topDestinations: [],
  });
  const holders = new Map();
  const dests = new Map();
  const prev = new Map();
  for (const r of clean) {
    const holder = toIso2(r.COUNTRY);
    const issuer = toIso2(r.COUNTERPART_COUNTRY);
    if (String(r.period) === year) {
      if (!holders.has(issuer)) holders.set(issuer, []);
      holders.get(issuer).push({ iso2: holder, usd: r.value });
      if (!dests.has(holder)) dests.set(holder, []);
      dests.get(holder).push({ iso2: issuer, usd: r.value });
    } else if (String(r.period) === prevYear) {
      // Same-reporter comparison: only holders that also report in `year`.
      if (!prev.has(issuer)) prev.set(issuer, new Map());
      prev.get(issuer).set(holder, r.value);
    }
  }
  const top = (list) => list.filter((x) => x.usd > 0).sort((a, b) => b.usd - a.usd).slice(0, TOP_N).map((x) => ({ iso2: x.iso2, usdBn: bn(x.usd) }));
  for (const [issuer, list] of holders) {
    const o = ensure(issuer);
    const total = list.reduce((s, x) => s + x.usd, 0);
    o.foreignHoldingsUsdBn = bn(total);
    o.reporterCount = list.length;
    o.topHolders = top(list);
    const p = prev.get(issuer);
    if (p) {
      const matched = list.filter((x) => p.has(x.iso2));
      const cur = matched.reduce((s, x) => s + x.usd, 0);
      const before = matched.reduce((s, x) => s + p.get(x.iso2), 0);
      o.foreignHoldingsPrevYearUsdBn = bn(before);
      o.changePct = before > 0 ? pct(((cur - before) / before) * 100) : null;
    }
  }
  for (const [holder, list] of dests) {
    const o = ensure(holder);
    o.holdingsAbroadUsdBn = bn(list.reduce((s, x) => s + x.usd, 0));
    o.topDestinations = top(list);
  }
  return { byCountry: out, year: Number(year) };
}

// ── IMF DIP ─────────────────────────────────────────────────────────────────

// rows: reporting COUNTRY × COUNTERPART_COUNTRY, DV_TYPE O (the reporter's own
// figures), INWD_D_NETLA_FALL_ALL (direct investment in the reporter by the
// counterpart) and OTWD_D_NETAL_FALL_ALL (the reporter's direct investment in
// the counterpart), annual positions in raw USD.
//
// Pairs: byReporter[rep][cp] = [inwardFromCp, outwardToCp] in USD bn, for the
// newest year at least 80% as well reported as the year before. Both sides of a
// pair report the same position, and they disagree, so readers keep both.
// Countries: total inward/outward positions with the largest investors and
// destinations, as the country itself reports them.
//
// Conduit economies (Luxembourg, the Netherlands, Ireland and others) carry
// large pass-through positions through special-purpose entities; these are
// immediate-counterpart figures, not ultimate investors.
export function buildFdi(rows) {
  const clean = rows.filter((r) => (r.DV_TYPE ?? 'O') === 'O' && toIso2(r.COUNTRY) && toIso2(r.COUNTERPART_COUNTRY)
    && r.COUNTRY !== r.COUNTERPART_COUNTRY
    && (r.INDICATOR === 'INWD_D_NETLA_FALL_ALL' || r.INDICATOR === 'OTWD_D_NETAL_FALL_ALL'));
  const year = selectPipYear(clean);
  if (!year) return { pairs: { year: null, reporters: [], byReporter: {} }, byCountry: {} };
  const byReporter = {};
  for (const r of clean) {
    if (String(r.period) !== year) continue;
    const cell = ((byReporter[toIso2(r.COUNTRY)] ??= {})[toIso2(r.COUNTERPART_COUNTRY)] ??= [null, null]);
    cell[r.INDICATOR === 'INWD_D_NETLA_FALL_ALL' ? 0 : 1] = bn(r.value);
  }
  const byCountry = {};
  const top = (entries) => entries.filter(([, v]) => v != null && v > 0).sort((a, b) => b[1] - a[1]).slice(0, TOP_N).map(([iso2, usdBn]) => ({ iso2, usdBn }));
  const sum = (entries) => Math.round(entries.reduce((s, [, v]) => s + (v ?? 0), 0) * 100) / 100;
  for (const [rep, cps] of Object.entries(byReporter)) {
    const inward = Object.entries(cps).map(([cp, c]) => [cp, c[0]]).filter(([, v]) => v != null);
    const outward = Object.entries(cps).map(([cp, c]) => [cp, c[1]]).filter(([, v]) => v != null);
    byCountry[rep] = {
      year: Number(year),
      inwardUsdBn: inward.length ? sum(inward) : null,
      topInvestors: top(inward),
      outwardUsdBn: outward.length ? sum(outward) : null,
      topDestinations: top(outward),
    };
  }
  return { pairs: { year: Number(year), reporters: Object.keys(byReporter).sort(), byReporter }, byCountry };
}

// ── GDP ─────────────────────────────────────────────────────────────────────

export function parseWorldBankGdp(pages) {
  const out = {};
  for (const json of pages) {
    for (const rec of json?.[1] ?? []) {
      const iso2 = toIso2(rec?.countryiso3code);
      if (!iso2 || rec?.value == null) continue;
      const value = Number(rec.value);
      const year = Number(rec.date);
      if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(year)) continue;
      if (!out[iso2] || year > out[iso2].year) out[iso2] = { value, year };
    }
  }
  return out;
}

async function fetchGdp() {
  const first = await fetchJson(`${WB_GDP_URL}&page=1`, { timeoutMs: 30_000 });
  const pages = [first];
  const total = first?.[0]?.pages ?? 1;
  for (let p = 2; p <= total; p++) pages.push(await fetchJson(`${WB_GDP_URL}&page=${p}`, { timeoutMs: 30_000 }));
  return parseWorldBankGdp(pages);
}

// ── Assembly ────────────────────────────────────────────────────────────────

export function assembleCapitalFlows({ bopQuarterlyRows, bopAnnualRows, bank, portfolio, fdi = { byCountry: {} }, pairs = null, gdp, nowYear = new Date().getUTCFullYear(), seededAt = new Date().toISOString() }) {
  const qByIso3 = groupBy(bopQuarterlyRows, (r) => (toIso2(r.COUNTRY) ? r.COUNTRY : null));
  const aByIso3 = groupBy(bopAnnualRows, (r) => (toIso2(r.COUNTRY) ? r.COUNTRY : null));
  const iso2s = new Set([
    ...[...qByIso3.keys(), ...aByIso3.keys()].map(toIso2),
    ...Object.keys(bank.byCountry),
    ...Object.keys(portfolio.byCountry),
    ...Object.keys(fdi.byCountry),
  ]);

  const countries = {};
  let quarterly = 0;
  let annual = 0;
  const bopQuarters = [];
  const bopYears = [];
  for (const iso2 of [...iso2s].filter(Boolean).sort()) {
    const iso3 = ISO2_TO_ISO3[iso2] ?? null;
    const bop = iso3
      ? buildBopCountry({ quarterlyRows: qByIso3.get(iso3) ?? [], annualRows: aByIso3.get(iso3) ?? [], gdpUsd: gdp[iso2]?.value ?? null, nowYear })
      : null;
    if (bop?.frequency === 'quarterly') { quarterly++; bopQuarters.push(bop.latestPeriod); }
    if (bop?.frequency === 'annual') { annual++; bopYears.push(bop.latestPeriod); }
    const entry = {
      iso2,
      iso3,
      gdpUsdBn: gdp[iso2] ? bn(gdp[iso2].value) : null,
      gdpYear: gdp[iso2]?.year ?? null,
      bop,
      bank: bank.byCountry[iso2] ?? null,
      portfolio: portfolio.byCountry[iso2] ?? null,
      fdi: fdi.byCountry[iso2] ?? null,
    };
    if (!entry.bop && !entry.bank && !entry.portfolio && !entry.fdi) continue;
    countries[iso2] = entry;
  }

  // Mode of latest quarters: the "current" quarter most reporters have reached.
  const mode = (list) => {
    const counts = list.reduce((acc, p) => { acc[p] = (acc[p] || 0) + 1; return acc; }, {});
    return Object.entries(counts).sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0]?.[0] ?? null;
  };

  return {
    countries,
    latest: {
      bopQuarter: mode(bopQuarters),
      bopNewestQuarter: bopQuarters.sort().at(-1) ?? null,
      bopYear: mode(bopYears),
      bisQuarter: bank.latestPeriod,
      pipYear: portfolio.year,
      fdiYear: pairs?.fdi?.year ?? null,
    },
    coverage: {
      countries: Object.keys(countries).length,
      bopQuarterly: quarterly,
      bopAnnualOnly: annual,
      bisCounterparties: Object.keys(bank.byCountry).length,
      bisReporters: Object.values(bank.byCountry).filter((b) => b.publishesBilateral).length,
      bankPairReporters: pairs?.bank?.reporters?.length ?? 0,
      portfolioPairHolders: pairs?.portfolio?.holders?.length ?? 0,
      fdiPairReporters: pairs?.fdi?.reporters?.length ?? 0,
      portfolioCountries: Object.keys(portfolio.byCountry).length,
    },
    units: 'USD billions',
    // Raw-only: publishTransform moves this to PAIRS_KEY.
    pairs,
    method: {
      bop: 'IMF BOP (BPM6) gross flows ex reserves: inflows = net incurrence of liabilities, outflows = net acquisition of financial assets; FDI + portfolio + other investment.',
      episodes: 'Forbes & Warnock (2012): year-on-year change in the 4-quarter sum vs trailing 20-quarter mean; episode starts beyond 1 sd, must reach 2 sd, lasts more than one quarter. Inflows up = surge, down = stop; outflows up = flight, down = retrenchment. Derived, not reported.',
      bank: 'BIS LBS cross-border loans and deposits (instrument G, excluding debt securities) of banks in all reporting countries vs non-bank residents of the country; flow = sum of last 4 FX- and break-adjusted quarterly changes. Positions are as of the latest BIS quarter; deposits placed in banking systems that publish no bilateral breakdown are not visible.',
      portfolio: 'IMF PIP (formerly CPIS) mirror: sum of every reporter\'s holdings of the country\'s securities; change compares the same reporters year on year.',
      fdi: 'IMF DIP (formerly CDIS) direct-investment positions by immediate counterpart, as the country reports them. Conduit economies carry large pass-through positions; these are not ultimate investors.',
      pairs: 'Pair legs: bank deposits and lending are reported by the bank location; portfolio holdings by the holder; FDI by both sides, which often disagree, so both figures are kept. not_itemized means the reporting side omits that partner (zero, small or confidential); not_published means it publishes no bilateral breakdown.',
      caveat: 'A person changing country of residence is not a BOP transaction under BPM6, so wealth migration does not appear in these flows.',
    },
    sources: [
      `${IMF_BASE}/BOP`,
      `${IMF_BASE}/PIP`,
      `${IMF_BASE}/DIP`,
      BIS_BASE,
      'https://api.worldbank.org/v2/country/all/indicator/NY.GDP.MKTP.CD',
      'https://www.bis.org/statistics/bankstats.htm',
    ],
    seededAt,
  };
}

// A parse that yields nothing means the upstream shape changed; fail rather
// than publish a payload with a whole view silently missing. Each request is
// checked on its own, so one empty half of a split pull cannot hide behind
// the other.
export function emptyUpstreams(parsed) {
  return Object.entries(parsed).filter(([, rows]) => !Array.isArray(rows) || rows.length === 0).map(([name]) => name);
}

export async function fetchCapitalFlows() {
  const nowYear = new Date().getUTCFullYear();
  const imfHeaders = imfAuthHeaders();
  const bopQ = `${IMF_BASE}/BOP/+/*.A_NFA_T+L_NIL_T+NETCD_T.D_F+P_F+O_F+EO.USD.Q?c%5BTIME_PERIOD%5D=ge:${nowYear - BOP_HISTORY_YEARS}-Q1&dimensionAtObservation=TIME_PERIOD`;
  const bopA = `${IMF_BASE}/BOP/+/*.A_NFA_T+L_NIL_T+NETCD_T.D_F+P_F+O_F+EO.USD.A?c%5BTIME_PERIOD%5D=ge:${nowYear - 10}&dimensionAtObservation=TIME_PERIOD`;
  const pip = `${IMF_BASE}/PIP/+/*.A.P_TOTINV_P_USD.S1.S1.*.A?c%5BTIME_PERIOD%5D=ge:${nowYear - 4}&dimensionAtObservation=TIME_PERIOD`;
  const dip = (indicator) => `${IMF_BASE}/DIP/+/*.O.${indicator}.*.A?c%5BTIME_PERIOD%5D=ge:${nowYear - 4}&dimensionAtObservation=TIME_PERIOD`;
  const bisStart = `${nowYear - 3}-Q1`;
  // L_INSTR=G (loans and deposits): A (all instruments) would add banks' debt
  // securities liabilities and their securities holdings, which are not deposits or lending.
  const bisTotals = `${BIS_BASE}/Q.F+S.L+C.G.TO1.A.5J.A.5A.N+H..N?startPeriod=${bisStart}`;
  // A+G: G for most reporters, A as the fallback for reporters without G.
  const bisPairs = `${BIS_BASE}/Q.F+S.L+C.A+G.TO1.A.5J.A..N..N?startPeriod=${bisStart}`;
  const bisAccept = 'application/vnd.sdmx.data+json;version=1.0.0';

  // Every pull runs in parallel (three-plus to api.imf.org, as seed-imf-external
  // does). Measured 2026-10-19: DIP ~55s, PIP ~43s, BIS pairs ~14s, BOP ~12s.
  // Worst case per call is direct + proxy = 2 × its timeout (180s for PIP/DIP),
  // inside FETCH_PHASE_TIMEOUT_MS; World Bank GDP pages run alongside.
  const imfJob = Promise.all([
    fetchJson(bopQ, { headers: imfHeaders, timeoutMs: 60_000 }),
    fetchJson(bopA, { headers: imfHeaders, timeoutMs: 60_000 }),
    fetchJson(pip, { headers: imfHeaders, timeoutMs: 90_000 }),
    // DIP is split by indicator: one request for both took >4 minutes.
    fetchJson(dip('INWD_D_NETLA_FALL_ALL'), { headers: imfHeaders, timeoutMs: 90_000 }),
    fetchJson(dip('OTWD_D_NETAL_FALL_ALL'), { headers: imfHeaders, timeoutMs: 90_000 }),
  ]).then(([q, a, p, dIn, dOut]) => {
    const inward = parseImfSdmx(dIn);
    const outward = parseImfSdmx(dOut);
    return { q: parseImfSdmx(q), a: parseImfSdmx(a), p: parseImfSdmx(p), dIn: inward, dOut: outward, d: [...inward, ...outward] };
  });
  const bisJob = Promise.all([
    fetchJson(bisTotals, { accept: bisAccept, timeoutMs: 45_000 }),
    fetchJson(bisPairs, { accept: bisAccept, timeoutMs: 60_000 }),
  ]).then(([totals, pairs]) => ({ totals: parseBisSdmx(totals), pairs: parseBisSdmx(pairs) }));
  const [imf, bis, gdp] = await Promise.all([imfJob, bisJob, fetchGdp()]);
  const empty = emptyUpstreams({
    bopQuarterly: imf.q, bopAnnual: imf.a, pip: imf.p, dipInward: imf.dIn, dipOutward: imf.dOut, bisTotals: bis.totals, bisPairs: bis.pairs,
  });
  if (empty.length > 0) throw new Error(`capital-flows: upstream returned no rows for ${empty.join(', ')}`);
  console.log(`  IMF BOP quarterly rows=${imf.q.length} annual rows=${imf.a.length}; PIP rows=${imf.p.length}; BIS totals rows=${bis.totals.length} pairs rows=${bis.pairs.length}; GDP countries=${Object.keys(gdp).length}`);

  const fdi = buildFdi(imf.d);
  return assembleCapitalFlows({
    bopQuarterlyRows: imf.q,
    bopAnnualRows: imf.a,
    bank: buildBankByCountry(bis.totals, bis.pairs),
    portfolio: buildPortfolioByCountry(imf.p),
    fdi,
    pairs: { bank: buildBankPairs(bis.pairs), portfolio: buildPortfolioPairs(imf.p), fdi: fdi.pairs },
    gdp,
    nowYear,
  });
}

// BOP quarterly covers ~160 economies and annual adds the rest; BIS and PIP
// widen the union past 200. Floors reject a broken upstream, not normal gaps.
export function validate(data) {
  const c = data?.coverage;
  return typeof data?.countries === 'object'
    && Object.keys(data.countries).length >= 150
    && (c?.bopQuarterly ?? 0) >= 80
    && (c?.bopAnnualOnly ?? 0) >= 10
    && (c?.bisCounterparties ?? 0) >= 100
    && (c?.bisReporters ?? 0) >= 20
    && (c?.portfolioCountries ?? 0) >= 100
    && (c?.bankPairReporters ?? 0) >= 20
    && (c?.portfolioPairHolders ?? 0) >= 50
    && (c?.fdiPairReporters ?? 0) >= 50;
}

// The canonical key carries per-country views; the matrices go to PAIRS_KEY.
export function publishTransform(data) {
  const { pairs: _pairs, ...rest } = data ?? {};
  return rest;
}

export function pairsPayload(data) {
  return { ...(data?.pairs ?? { bank: null, portfolio: null, fdi: null }), seededAt: data?.seededAt ?? null };
}

export function declarePairRecords(data) {
  // runSeed hands extra-key declarers the TRANSFORMED payload (pairsPayload).
  return (data?.bank?.reporters?.length ?? 0) + (data?.portfolio?.holders?.length ?? 0) + (data?.fdi?.reporters?.length ?? 0);
}

export function declareRecords(data) {
  return Object.keys(data?.countries || {}).length;
}

export function capitalFlowsContentMeta(data) {
  return tokensToContentMeta(data?.latest?.bopNewestQuarter ?? data?.latest?.bopQuarter);
}

// Best-effort: a missed marker costs one more cycle of on-demand softening.
async function markActivated() {
  try {
    const creds = getOptionalUpstashCreds();
    if (!creds) return;
    await upstashCommand(creds, ['SET', CAPITAL_FLOWS_ACTIVATION_KEY, '1']);
  } catch (err) {
    console.warn(`  WARN: activation marker write failed: ${err?.message || err}`);
  }
}

if (process.argv[1]?.endsWith('seed-capital-flows.mjs')) {
  runSeed('economic', 'capital-flows', CANONICAL_KEY, fetchCapitalFlows, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: 'imf-bop-pip+bis-lbs-v1',
    recordCount: (data) => Object.keys(data?.countries ?? {}).length,
    emptyDataIsFailure: true,
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 14400,
    contentMeta: capitalFlowsContentMeta,
    maxContentAgeMin: CAPITAL_FLOWS_MAX_CONTENT_AGE_MIN,
    fetchPhaseTimeoutMs: FETCH_PHASE_TIMEOUT_MS,
    lockTtlMs: LOCK_TTL_MS,
    publishTransform,
    extraKeys: [{
      key: PAIRS_KEY,
      ttl: CACHE_TTL,
      transform: pairsPayload,
      declareRecords: declarePairRecords,
    }],
    afterPublish: markActivated,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
