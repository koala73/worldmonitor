// @ts-check
// Hormuz LNG supplier shares from UN Comtrade HS 271111 (liquefied natural gas
// only; HS4 2711 mixes in LPG and pipeline gas).
//
// The bilateral seeder makes three all-reporter requests and this module turns
// them into one share per importer for each of the two baselines the energy
// shock model reports:
//   - pre-crisis: the 12 months of PRE_CRISIS_WINDOW when the reporter filed
//     every one of them monthly, else the calendar year before the crisis
//     (then the year before that, for late filers);
//   - current flows: the latest CURRENT_FLOWS_WINDOW.months monthly
//     observations, none before CURRENT_FLOWS_WINDOW.earliestMonth.
//
// Lives in scripts/shared/ because the seeder ships as a nixpacks-root-scripts
// service (#3811); it reads the scripts/shared mirror of the crisis dates.
import { CURRENT_FLOWS_WINDOW, PRE_CRISIS_WINDOW } from './hormuz-crisis.js';
import { ComtradeResponseError } from './comtrade-bilateral.mjs';

export const LNG_CMD_CODE = '271111';
export const LNG_HORMUZ_SHARE_KEY = 'comtrade:lng-hormuz-share:v1';

/**
 * LNG loaded inside the Strait: Qatar (Ras Laffan) and the UAE (Das Island).
 * Oman (512) is absent on purpose: its Qalhat terminal loads outside the Strait.
 */
export const HORMUZ_LNG_PARTNER_CODES = Object.freeze(['634', '784']);
const HORMUZ = new Set(HORMUZ_LNG_PARTNER_CODES);

/**
 * Above this fraction of imports not attributed to a named country, the origin
 * is withheld and no share is published. Unattributed means booked to a
 * non-country partner ("Areas, nes", "Special categories") or missing from the
 * partner rows altogether (World total minus the partner sum). Germany and
 * Austria book 100% to non-country partners; elsewhere the fraction was under
 * 1% on 2026-10-28, so 10% bounds the understatement of a published share.
 */
export const MAX_UNATTRIBUTED_SHARE = 0.10;

/**
 * A snapshot with fewer pre-crisis shares than this does not replace the last
 * good one. 114 importers had one on 2026-10-28; the floor catches a collapse
 * (a thin or unusable response) without tracking normal filing variation.
 */
export const MIN_LNG_PRE_CRISIS_COUNTRIES = 40;

/** A month's partner weights must sum to its World weight within this tolerance to be used. */
const WEIGHT_TOLERANCE = 0.02;
/** The monthly endpoint takes at most 12 periods per call. */
const MAX_PERIODS_PER_REQUEST = 12;

/** @param {string} month YYYY-MM */
const toPeriod = (month) => month.replace('-', '');
/** @param {string} period YYYYMM */
const toMonth = (period) => `${period.slice(0, 4)}-${period.slice(4, 6)}`;

/**
 * Inclusive list of YYYY-MM months.
 * @param {string} from
 * @param {string} to
 */
function monthRange(from, to) {
  const months = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  for (;;) {
    const label = `${year}-${String(month).padStart(2, '0')}`;
    if (label > to) break;
    months.push(label);
    month += 1;
    if (month === 13) { year += 1; month = 1; }
  }
  return months;
}

/** The last calendar year that ends before the crisis month, then the year before it. */
function annualYears(window = PRE_CRISIS_WINDOW) {
  const endYear = Number(window.endMonth.slice(0, 4));
  const lastFull = window.endMonth.slice(5, 7) === '12' ? endYear : endYear - 1;
  return [String(lastFull), String(lastFull - 1)];
}

/**
 * The three requests of one run. Each one omits reporterCode and partnerCode,
 * so a single call returns every reporter's partner rows.
 * @param {Date} [now]
 * @returns {Array<{id: 'annual' | 'preCrisis' | 'current', frequency: 'A' | 'M', periods: string[]}>}
 */
export function lngOriginRequests(now = new Date()) {
  /** @type {Array<{id: 'annual' | 'preCrisis' | 'current', frequency: 'A' | 'M', periods: string[]}>} */
  const requests = [
    { id: 'annual', frequency: 'A', periods: annualYears() },
    { id: 'preCrisis', frequency: 'M', periods: monthRange(PRE_CRISIS_WINDOW.startMonth, PRE_CRISIS_WINDOW.endMonth).map(toPeriod) },
  ];
  // The latest complete month is the one before `now`.
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const lastComplete = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
  const current = monthRange(CURRENT_FLOWS_WINDOW.earliestMonth, lastComplete).slice(-MAX_PERIODS_PER_REQUEST);
  if (current.length > 0) requests.push({ id: 'current', frequency: 'M', periods: current.map(toPeriod) });
  return requests;
}

/**
 * @typedef {{reporterCode: string, partnerCode: string, period: string, value: number, netWeightKg: number | null}} LngRow
 */

/**
 * Validated aggregate rows of one response. Throws ComtradeResponseError, so
 * the seeder keeps the previous snapshot instead of publishing a partial one.
 * @param {unknown} body
 * @param {number} [maxRecords]
 * @returns {LngRow[]}
 */
export function parseLngRows(body, maxRecords = Infinity) {
  const records = /** @type {any} */ (body)?.data;
  if (!Array.isArray(records)) throw new ComtradeResponseError('malformed', 'Malformed Comtrade data array');
  if (records.length >= maxRecords) throw new ComtradeResponseError('incomplete', 'Incomplete Comtrade response: record limit reached');
  /** @type {LngRow[]} */
  const rows = [];
  for (const r of records) {
    const reporterCode = String(r?.reporterCode ?? '');
    const partnerCode = String(r?.partnerCode ?? '');
    const period = String(r?.period ?? '');
    const value = Number(r?.primaryValue);
    if (!r || String(r.cmdCode ?? '') !== LNG_CMD_CODE || !/^\d{1,3}$/.test(reporterCode) || !/^\d{1,3}$/.test(partnerCode)
      || !/^\d{4}(?:\d{2})?$/.test(period) || r.primaryValue == null || !Number.isFinite(value) || value < 0) {
      throw new ComtradeResponseError('malformed', 'Malformed Comtrade LNG row');
    }
    // The request pins these aggregates; anything else is a breakdown row.
    if ((r.partner2Code != null && Number(r.partner2Code) !== 0) || (r.motCode != null && Number(r.motCode) !== 0)
      || (r.customsCode != null && r.customsCode !== 'C00')) continue;
    const weight = Number(r.netWgt);
    rows.push({ reporterCode, partnerCode, period, value, netWeightKg: Number.isFinite(weight) && weight > 0 ? weight : null });
  }
  return rows;
}

/**
 * @typedef {{worldValue: number, worldWeight: number | null, partnerValue: number, partnerWeight: number,
 *   partnerWeightMissing: boolean, hormuzValue: number, hormuzWeight: number, unattributedValue: number}} PeriodAggregate
 */

/**
 * Per reporter, per period: World totals and the partner sums the shares need.
 * A duplicate (reporter, period, partner) row keeps the larger value, as
 * groupByProduct does, instead of being counted twice.
 * @param {LngRow[]} rows
 * @param {(code: string) => string} partnerKind
 * @returns {Map<string, Map<string, PeriodAggregate>>}
 */
function aggregate(rows, partnerKind) {
  /** @type {Map<string, LngRow>} */
  const unique = new Map();
  for (const row of rows) {
    const key = `${row.reporterCode}|${row.period}|${row.partnerCode}`;
    const existing = unique.get(key);
    if (!existing || row.value > existing.value) unique.set(key, row);
  }
  /** @type {Map<string, Map<string, PeriodAggregate>>} */
  const byReporter = new Map();
  for (const row of unique.values()) {
    if (!byReporter.has(row.reporterCode)) byReporter.set(row.reporterCode, new Map());
    const periods = /** @type {Map<string, PeriodAggregate>} */ (byReporter.get(row.reporterCode));
    if (!periods.has(row.period)) {
      periods.set(row.period, { worldValue: 0, worldWeight: null, partnerValue: 0, partnerWeight: 0, partnerWeightMissing: false, hormuzValue: 0, hormuzWeight: 0, unattributedValue: 0 });
    }
    const agg = /** @type {PeriodAggregate} */ (periods.get(row.period));
    if (/^0+$/.test(row.partnerCode)) {
      agg.worldValue = row.value;
      agg.worldWeight = row.netWeightKg;
      continue;
    }
    agg.partnerValue += row.value;
    if (row.value > 0) {
      if (row.netWeightKg == null) agg.partnerWeightMissing = true;
      else agg.partnerWeight += row.netWeightKg;
    }
    if (HORMUZ.has(row.partnerCode)) {
      agg.hormuzValue += row.value;
      agg.hormuzWeight += row.netWeightKg ?? 0;
    }
    if (partnerKind(row.partnerCode) !== 'country') agg.unattributedValue += row.value;
  }
  return byReporter;
}

/** A period with a positive World total that its partner rows do not exceed. */
const usablePeriod = (/** @type {PeriodAggregate | undefined} */ agg) =>
  agg != null && agg.worldValue > 0 && agg.partnerValue <= agg.worldValue * 1.001;

const usableWeight = (/** @type {PeriodAggregate} */ agg) =>
  agg.worldWeight != null && agg.worldWeight > 0 && !agg.partnerWeightMissing
  && Math.abs(agg.partnerWeight / agg.worldWeight - 1) <= WEIGHT_TOLERANCE;

/**
 * Hormuz share over a set of periods. Weight (tonnage) when every period has a
 * consistent weight; otherwise value for the whole window, so one window never
 * mixes the two measures.
 * @param {PeriodAggregate[]} aggs
 */
function measureWindow(aggs) {
  const byWeight = aggs.every(usableWeight);
  const sum = (/** @type {(a: PeriodAggregate) => number} */ pick) => aggs.reduce((total, a) => total + pick(a), 0);
  const worldValue = sum((a) => a.worldValue);
  const share = byWeight
    ? sum((a) => a.hormuzWeight) / sum((a) => /** @type {number} */ (a.worldWeight))
    : sum((a) => a.hormuzValue) / worldValue;
  return {
    measure: byWeight ? 'weight' : 'value',
    share: Math.round(Math.min(share, 1) * 10_000) / 10_000,
    // Value missing from the partner rows is as unattributed as value booked
    // to "Areas, nes": dividing by the World total understates the share by it.
    unattributedShare: Math.round((sum((a) => a.unattributedValue + Math.max(0, a.worldValue - a.partnerValue)) / worldValue) * 1000) / 1000,
  };
}

/**
 * @typedef {{basis: 'comtrade_monthly' | 'comtrade_annual', fromMonth: string, toMonth: string, monthsCovered: number,
 *   share: number, measure: 'weight' | 'value', unattributedShare: number}} LngShareBaseline
 * @typedef {'no_rows' | 'partners_unattributed'} LngUnavailableReason
 */

/**
 * @param {Array<{basis: 'comtrade_monthly' | 'comtrade_annual', fromMonth: string, toMonth: string, aggs: PeriodAggregate[]}>} candidates
 * @returns {{baseline: LngShareBaseline | null, reason?: LngUnavailableReason}}
 */
function firstAttributed(candidates) {
  let withheld = false;
  for (const candidate of candidates) {
    const measured = measureWindow(candidate.aggs);
    if (measured.unattributedShare > MAX_UNATTRIBUTED_SHARE) { withheld = true; continue; }
    return {
      baseline: {
        basis: candidate.basis,
        fromMonth: candidate.fromMonth,
        toMonth: candidate.toMonth,
        monthsCovered: candidate.basis === 'comtrade_annual' ? 12 : candidate.aggs.length,
        share: measured.share,
        measure: /** @type {'weight' | 'value'} */ (measured.measure),
        unattributedShare: measured.unattributedShare,
      },
    };
  }
  return { baseline: null, reason: withheld ? 'partners_unattributed' : 'no_rows' };
}

/**
 * Both baselines for every reporter present in any of the three responses.
 * @param {{annual?: LngRow[], preCrisis?: LngRow[], current?: LngRow[]}} rows
 * @param {{reporterIso2: (code: string) => string, partnerKind: (code: string) => string}} options
 */
export function buildLngOriginShares(rows, { reporterIso2, partnerKind }) {
  const annual = aggregate(rows.annual ?? [], partnerKind);
  const preCrisis = aggregate(rows.preCrisis ?? [], partnerKind);
  const current = aggregate(rows.current ?? [], partnerKind);
  const preMonths = monthRange(PRE_CRISIS_WINDOW.startMonth, PRE_CRISIS_WINDOW.endMonth);
  const years = annualYears();

  const reporters = [...new Set([...annual.keys(), ...preCrisis.keys(), ...current.keys()])]
    .sort((a, b) => Number(a) - Number(b));
  /** @type {Record<string, {preCrisis: LngShareBaseline | null, preCrisisUnavailable?: LngUnavailableReason, current: LngShareBaseline | null, currentUnavailable?: LngUnavailableReason}>} */
  const countries = {};
  for (const reporter of reporters) {
    const iso2 = reporterIso2(reporter);
    // Numeric order makes a second code for one country (Italy 380/381) deterministic: the first wins.
    if (!/^[A-Z]{2}$/.test(iso2) || countries[iso2]) continue;

    const monthly = preCrisis.get(reporter);
    const monthAggs = preMonths.map((m) => monthly?.get(toPeriod(m)));
    /** @type {Array<{basis: 'comtrade_monthly' | 'comtrade_annual', fromMonth: string, toMonth: string, aggs: PeriodAggregate[]}>} */
    const preCandidates = [];
    if (monthAggs.every(usablePeriod)) {
      preCandidates.push({ basis: 'comtrade_monthly', fromMonth: preMonths[0], toMonth: preMonths[preMonths.length - 1], aggs: /** @type {PeriodAggregate[]} */ (monthAggs) });
    }
    for (const year of years) {
      const agg = annual.get(reporter)?.get(year);
      if (usablePeriod(agg)) preCandidates.push({ basis: 'comtrade_annual', fromMonth: `${year}-01`, toMonth: `${year}-12`, aggs: [/** @type {PeriodAggregate} */ (agg)] });
    }
    const pre = firstAttributed(preCandidates);

    const crisisMonths = [...(current.get(reporter)?.entries() ?? [])]
      .filter(([period, agg]) => period.length === 6 && toMonth(period) >= CURRENT_FLOWS_WINDOW.earliestMonth && usablePeriod(agg))
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-CURRENT_FLOWS_WINDOW.months);
    const now = crisisMonths.length > 0
      ? firstAttributed([{
        basis: 'comtrade_monthly',
        fromMonth: toMonth(crisisMonths[0][0]),
        toMonth: toMonth(crisisMonths[crisisMonths.length - 1][0]),
        aggs: crisisMonths.map(([, agg]) => agg),
      }])
      : { baseline: null, reason: /** @type {LngUnavailableReason} */ ('no_rows') };

    countries[iso2] = {
      preCrisis: pre.baseline,
      ...(pre.reason ? { preCrisisUnavailable: pre.reason } : {}),
      current: now.baseline,
      ...(now.reason ? { currentUnavailable: now.reason } : {}),
    };
  }
  return {
    cmdCode: LNG_CMD_CODE,
    hormuzPartnerCodes: [...HORMUZ_LNG_PARTNER_CODES],
    preCrisisWindow: { ...PRE_CRISIS_WINDOW, annualYears: years },
    currentFlowsWindow: { ...CURRENT_FLOWS_WINDOW },
    countries,
  };
}
