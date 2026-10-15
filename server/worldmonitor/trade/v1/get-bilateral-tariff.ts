/**
 * RPC: getBilateralTariff -- applied tariff on one HS6 product between two
 * countries, from UNCTAD TRAINS via the World Bank WITS API.
 *
 * The pair x product x year space is too large to seed, so this reads WITS on
 * demand and caches each upstream answer. One SDMX `partner/all` query per
 * reporter/product/year returns the MFN row (partner 000) and every
 * preferential row the reporter filed, so every partner for that product
 * shares one cache entry.
 *
 * TRAINS stores a partner-specific row only where a preference exists, so a
 * missing row means "MFN applies" ONLY when the reporter filed preferential
 * schedules for that year. Several reporters publish recent years as MFN-only;
 * the per-reporter availability list (`partnerlist` per year) is what tells
 * the two cases apart. Group preferences (GSP lists, regional agreements) are
 * keyed by WITS group codes whose membership the API does not expose, so they
 * are returned for the caller to judge rather than resolved.
 *
 * Two filing quirks, both measured against WITS on 2026-10-10:
 *  - EU members answer with the common MFN schedule but no preferences, and
 *    publish no availability list; the EU's preferences are filed under 918.
 *    Members are therefore answered from 918.
 *  - The `reported` datatype averages ad valorem lines only and reports 0 for
 *    a product whose lines are all specific duties (US wine, HS 220421, reads
 *    0% MFN). When the MFN row has non-ad-valorem lines, the `aveestimated`
 *    datatype supplies ad valorem equivalents. It carries the MFN row only and
 *    is slow (~7 s), so it is fetched only when needed.
 *
 * TRAINS has no unilateral extra duties (Section 301/232/IEEPA, AD/CVD,
 * safeguards). The proto says so; nothing here can correct for it.
 */
import type {
  ServerContext,
  GetBilateralTariffRequest,
  GetBilateralTariffResponse,
  TariffRateDetail,
  GroupTariffPreference,
  AppliedTariffBasis,
  BilateralTariffUnavailableReason,
} from '../../../../src/generated/server/worldmonitor/trade/v1/service_server';
import { cachedFetchJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';
import { isCallerPremium } from '../../../_shared/premium-check';

export const WITS_SDMX_BASE = 'https://wits.worldbank.org/API/V1/SDMX/V21/datasource/TRN';
export const WITS_META_BASE = 'https://wits.worldbank.org/API/V1/wits/datasource/trn';
export const BILATERAL_TARIFF_SOURCE = 'UNCTAD TRAINS via World Bank WITS';

export const TRAINS_ROWS_KEY_PREFIX = 'trade:wits:trn:v1';
export const TRAINS_AVAILABILITY_KEY_PREFIX = 'trade:wits:trn-availability:v1';
export const TRAINS_GROUP_NAMES_KEY = 'trade:wits:trn-groups:v1';

// TRAINS is republished a few times a year per reporter.
const ROWS_TTL_SECONDS = 7 * 24 * 3600;
const AVAILABILITY_TTL_SECONDS = 7 * 24 * 3600;
const GROUP_NAMES_TTL_SECONDS = 30 * 24 * 3600;
// A WITS fault is cached briefly so a burst of callers does not hammer it.
const FAULT_TTL_SECONDS = 300;
// Edge functions must start responding within ~25 s. A cold request runs
// availability, then rows, then AVE and group names in parallel:
// 6 + 8 + 9 s worst case.
const META_FETCH_TIMEOUT_MS = 6_000;
const ROWS_FETCH_TIMEOUT_MS = 8_000;

const MFN_PARTNER = '000';
const EU_REPORTER = '918';
/** EU-27 member states (UN M49). TRAINS files their preferences under 918. */
export const EU_MEMBER_REPORTERS: ReadonlySet<string> = new Set([
  '040', '056', '100', '191', '196', '203', '208', '233', '246', '250', '276', '300', '348', '372',
  '380', '428', '440', '442', '470', '528', '616', '620', '642', '703', '705', '724', '752',
]);
// The `aveestimated` datatype is markedly slower than `reported` (~7 s).
const AVE_FETCH_TIMEOUT_MS = 9_000;

const BASIS = {
  none: 'APPLIED_TARIFF_BASIS_UNSPECIFIED',
  preferential: 'APPLIED_TARIFF_BASIS_PREFERENTIAL',
  mfn: 'APPLIED_TARIFF_BASIS_MFN',
  mfnPreferencesNotReported: 'APPLIED_TARIFF_BASIS_MFN_PREFERENCES_NOT_REPORTED',
} as const satisfies Record<string, AppliedTariffBasis>;

const REASON = {
  served: 'BILATERAL_TARIFF_UNAVAILABLE_REASON_UNSPECIFIED',
  invalidRequest: 'BILATERAL_TARIFF_UNAVAILABLE_REASON_INVALID_REQUEST',
  notCovered: 'BILATERAL_TARIFF_UNAVAILABLE_REASON_NOT_COVERED',
  upstreamUnavailable: 'BILATERAL_TARIFF_UNAVAILABLE_REASON_UPSTREAM_UNAVAILABLE',
} as const satisfies Record<string, BilateralTariffUnavailableReason>;

export { BASIS as APPLIED_TARIFF_BASIS, REASON as BILATERAL_TARIFF_REASON };

/** One `<Series>` of a TRAINS SDMX answer, flattened with its observation. */
export interface TrainsRow {
  partner: string;
  /** "MFN" for the partner-000 row, "PREF" for preferential rows. */
  tariffType: string;
  year: number;
  nomenclature: string;
  rate: number;
  minRate: number;
  maxRate: number;
  lines: number;
  nonAdValoremLines: number;
}

export interface TrainsRows {
  rows: TrainsRow[];
}

export interface TrainsAvailabilityYear {
  year: number;
  nomenclature: string;
  /** Partner codes with a schedule on file that year, "000" (MFN) included. */
  partners: string[];
}

export interface TrainsAvailability {
  years: TrainsAvailabilityYear[];
}

export interface TrainsGroupNames {
  names: Record<string, string>;
}

const CODE3 = /^[0-9]{3}$/;
const HS6 = /^[0-9]{6}$/;
/** WITS partner-group codes start with a letter (A41, N75, C09, ...). */
const GROUP_CODE = /^[A-Z][A-Z0-9]{2}$/;

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

function readAttributes(fragment: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of fragment.matchAll(/([A-Za-z_][\w.:-]*)="([^"]*)"/g)) {
    attrs[m[1]!] = decodeXml(m[2]!);
  }
  return attrs;
}

function toNumber(value: string | undefined): number {
  const n = Number.parseFloat(value ?? '');
  return Number.isFinite(n) ? n : Number.NaN;
}

function toCount(value: string | undefined): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Parse a TRAINS SDMX 2.1 structure-specific answer. Rows without a usable
 * year or rate are dropped, as are rows with no partner code.
 */
export function parseTrainsSeries(xml: string): TrainsRow[] {
  const rows: TrainsRow[] = [];
  for (const series of xml.matchAll(/<Series\b([^>]*)>([\s\S]*?)<\/Series>/g)) {
    const seriesAttrs = readAttributes(series[1]!);
    const partner = seriesAttrs.PARTNER ?? '';
    if (!partner) continue;
    for (const obs of series[2]!.matchAll(/<Obs\b([^>]*?)\/?>/g)) {
      const o = readAttributes(obs[1]!);
      const year = Number.parseInt(o.TIME_PERIOD ?? '', 10);
      const rate = toNumber(o.OBS_VALUE);
      if (!Number.isFinite(year) || Number.isNaN(rate)) continue;
      const minRate = toNumber(o.MIN_RATE);
      const maxRate = toNumber(o.MAX_RATE);
      rows.push({
        partner,
        tariffType: (o.TARIFFTYPE ?? '').toUpperCase(),
        year,
        nomenclature: o.NOMENCODE ?? '',
        rate,
        minRate: Number.isNaN(minRate) ? rate : minRate,
        maxRate: Number.isNaN(maxRate) ? rate : maxRate,
        lines: toCount(o.TOTALNOOFLINES),
        nonAdValoremLines: toCount(o.NBR_NA_LINES),
      });
    }
  }
  return rows;
}

/** Parse the WITS per-reporter data-availability list. */
export function parseTrainsAvailability(xml: string): TrainsAvailabilityYear[] {
  const years: TrainsAvailabilityYear[] = [];
  for (const block of xml.matchAll(/<wits:reporter\b[^>]*>([\s\S]*?)<\/wits:reporter>/g)) {
    const body = block[1]!;
    const year = Number.parseInt(/<wits:year>\s*(\d{4})\s*<\/wits:year>/.exec(body)?.[1] ?? '', 10);
    if (!Number.isFinite(year)) continue;
    const nomenclature = /reporternernomenclaturecode="([^"]*)"/.exec(body)?.[1] ?? '';
    const partners = (/<wits:partnerlist>([^<]*)<\/wits:partnerlist>/.exec(body)?.[1] ?? '')
      .split(';')
      .map((code) => code.trim())
      .filter(Boolean);
    years.push({ year, nomenclature, partners });
  }
  return years.sort((a, b) => a.year - b.year);
}

/** Parse WITS partner-group names out of the TRAINS country list. */
export function parseTrainsGroupNames(xml: string): Record<string, string> {
  const names: Record<string, string> = {};
  for (const block of xml.matchAll(/<wits:country\b([^>]*)>([\s\S]*?)<\/wits:country>/g)) {
    const attrs = readAttributes(block[1]!);
    if (attrs.isgroup !== 'Yes' || !attrs.countrycode) continue;
    const name = /<wits:name>([^<]*)<\/wits:name>/.exec(block[2]!)?.[1];
    if (name) names[attrs.countrycode] = decodeXml(name.trim());
  }
  return names;
}

export type TrainsDatatype = 'reported' | 'aveestimated';

export function filingReporter(reporter: string): string {
  return EU_MEMBER_REPORTERS.has(reporter) ? EU_REPORTER : reporter;
}

export function trainsRowsKey(reporter: string, hsCode: string, year: number, datatype: TrainsDatatype = 'reported'): string {
  const suffix = datatype === 'reported' ? '' : `:${datatype}`;
  return `${TRAINS_ROWS_KEY_PREFIX}:${reporter}:${hsCode}:${year}${suffix}`;
}

export function trainsAvailabilityKey(reporter: string): string {
  return `${TRAINS_AVAILABILITY_KEY_PREFIX}:${reporter}`;
}

export function trainsRowsUrl(reporter: string, hsCode: string, year: number, datatype: TrainsDatatype = 'reported'): string {
  const partner = datatype === 'reported' ? 'all' : MFN_PARTNER;
  return `${WITS_SDMX_BASE}/reporter/${reporter}/partner/${partner}/product/${hsCode}/year/${year}/datatype/${datatype}`;
}

async function witsGet(url: string, timeoutMs: number): Promise<Response> {
  return fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/xml,text/xml;q=0.9,*/*;q=0.1' },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * WITS answers "no data" two ways: SDMX returns 404 `NoRecordsFound`, the
 * metadata API returns 200 with a `<wits:error>` body. Both are coverage
 * answers, not faults.
 */
function isWitsNoData(status: number, body: string): boolean {
  if (status === 404 && /NoRecordsFound/i.test(body)) return true;
  return status === 200 && /<wits:error\b/.test(body);
}

async function fetchTrainsRows(
  reporter: string,
  hsCode: string,
  year: number,
  datatype: TrainsDatatype,
): Promise<TrainsRows | null> {
  try {
    const timeoutMs = datatype === 'reported' ? ROWS_FETCH_TIMEOUT_MS : AVE_FETCH_TIMEOUT_MS;
    const res = await witsGet(trainsRowsUrl(reporter, hsCode, year, datatype), timeoutMs);
    const body = await res.text();
    if (isWitsNoData(res.status, body)) return { rows: [] };
    if (!res.ok) {
      console.warn(`[wits] ${datatype} HTTP ${res.status} reporter=${reporter} hs=${hsCode} year=${year}`);
      return null;
    }
    return { rows: parseTrainsSeries(body) };
  } catch (error) {
    console.warn(`[wits] rows fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function fetchTrainsAvailability(reporter: string): Promise<TrainsAvailability | null> {
  try {
    const res = await witsGet(`${WITS_META_BASE}/dataavailability/country/${reporter}/year/all`, META_FETCH_TIMEOUT_MS);
    const body = await res.text();
    if (isWitsNoData(res.status, body)) return { years: [] };
    if (!res.ok) {
      console.warn(`[wits] availability HTTP ${res.status} reporter=${reporter}`);
      return null;
    }
    return { years: parseTrainsAvailability(body) };
  } catch (error) {
    console.warn(`[wits] availability fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function fetchTrainsGroupNames(): Promise<TrainsGroupNames | null> {
  try {
    const res = await witsGet(`${WITS_META_BASE}/country/all`, META_FETCH_TIMEOUT_MS);
    if (!res.ok) {
      console.warn(`[wits] country list HTTP ${res.status}`);
      return null;
    }
    return { names: parseTrainsGroupNames(await res.text()) };
  } catch (error) {
    console.warn(`[wits] country list fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** A cache or fetch fault reads as "unknown", never as an empty answer. */
async function readThrough<T extends object>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T | null>,
  timeoutMs?: number,
): Promise<T | null> {
  try {
    return await cachedFetchJson<T>(
      key,
      ttlSeconds,
      fetcher,
      FAULT_TTL_SECONDS,
      timeoutMs === undefined ? undefined : { timeoutMs },
    );
  } catch (error) {
    console.warn(`[wits] ${key} read failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function toDetail(row: TrainsRow): TariffRateDetail {
  return {
    rate: row.rate,
    minRate: row.minRate,
    maxRate: row.maxRate,
    tariffLines: row.lines,
    nonAdValoremLines: row.nonAdValoremLines,
  };
}

export interface ResolvedBilateralTariff {
  basis: AppliedTariffBasis;
  nomenclature: string;
  applied?: TariffRateDetail;
  mfn?: TariffRateDetail;
  mfnAve?: TariffRateDetail;
  preferential?: TariffRateDetail;
  groupRows: TrainsRow[];
}

/** The partner-000 MFN row of a TRAINS answer. */
export function findMfnRow(rows: readonly TrainsRow[]): TrainsRow | undefined {
  return rows.find((row) => row.partner === MFN_PARTNER);
}

/**
 * Pick the applied rate for `partner` out of one `partner/all` answer.
 *
 * `preferencesReported` is null when availability could not be read; then the
 * rows alone decide, and an answer with no preferential rows at all is
 * reported as MFN_PREFERENCES_NOT_REPORTED, the conservative reading.
 *
 * `mfnAveRow` is the `aveestimated` MFN row, passed only when the reported
 * MFN row has non-ad-valorem lines. It then stands in for MFN wherever MFN is
 * compared or applied, because the reported average ignores those lines.
 */
export function resolveBilateralTariff(
  rows: readonly TrainsRow[],
  partner: string,
  preferencesReported: boolean | null,
  mfnAveRow?: TrainsRow,
): ResolvedBilateralTariff | null {
  const mfnRow = findMfnRow(rows);
  const prefRow = partner === MFN_PARTNER
    ? undefined
    : rows.find((row) => row.partner === partner && row.tariffType !== 'MFN');
  if (!mfnRow && !prefRow) return null;

  const groupRows = partner === MFN_PARTNER
    ? []
    : rows.filter((row) => GROUP_CODE.test(row.partner) && row.tariffType !== 'MFN');
  const mfn = mfnRow ? toDetail(mfnRow) : undefined;
  const mfnAve = mfnRow && mfnAveRow ? toDetail(mfnAveRow) : undefined;
  const mfnEffective = mfnAveRow ?? mfnRow;
  const preferential = prefRow ? toDetail(prefRow) : undefined;
  const nomenclature = (mfnRow ?? prefRow)!.nomenclature;
  const base = { nomenclature, mfn, preferential, groupRows, ...(mfnAve ? { mfnAve } : {}) };

  // A preference above MFN is not a preference; the MFN rate is what applies.
  if (prefRow && (!mfnEffective || prefRow.rate <= mfnEffective.rate)) {
    return { ...base, basis: BASIS.preferential, applied: preferential };
  }

  const anyPreferenceRows = rows.some((row) => row.partner !== MFN_PARTNER && row.tariffType !== 'MFN');
  const reported = partner === MFN_PARTNER || anyPreferenceRows || preferencesReported === true;
  return {
    ...base,
    basis: reported ? BASIS.mfn : BASIS.mfnPreferencesNotReported,
    applied: mfnAve ?? mfn,
  };
}

function emptyResponse(
  req: Pick<GetBilateralTariffResponse, 'reportingCountry' | 'partnerCountry' | 'hsCode' | 'filingReporter'>,
  reason: BilateralTariffUnavailableReason,
  upstreamUnavailable: boolean,
  sourceUrl = '',
): GetBilateralTariffResponse {
  return {
    reportingCountry: req.reportingCountry,
    partnerCountry: req.partnerCountry,
    hsCode: req.hsCode,
    filingReporter: req.filingReporter,
    year: 0,
    nomenclature: '',
    basis: BASIS.none,
    groupPreferences: [],
    source: BILATERAL_TARIFF_SOURCE,
    sourceUrl,
    upstreamUnavailable,
    unavailableReason: reason,
  };
}

export async function getBilateralTariff(
  ctx: ServerContext,
  req: GetBilateralTariffRequest,
): Promise<GetBilateralTariffResponse> {
  const reporter = (req.reportingCountry ?? '').trim();
  const partner = (req.partnerCountry ?? '').trim();
  const hsCode = (req.hsCode ?? '').trim();
  const filing = CODE3.test(reporter) ? filingReporter(reporter) : '';
  const echo = { reportingCountry: reporter, partnerCountry: partner, hsCode, filingReporter: filing };

  const isPro = await isCallerPremium(ctx.request);
  if (!isPro) {
    // Entitlement gate, not a coverage or upstream fault: same shape as the
    // other Pro trade routes, reason left unspecified.
    return emptyResponse(echo, REASON.served, true);
  }

  const requestedYear = req.year;
  if (
    !CODE3.test(reporter) || !CODE3.test(partner) || !HS6.test(hsCode)
    || typeof requestedYear !== 'number' || !Number.isInteger(requestedYear)
    || requestedYear < 0 || requestedYear > 2100
  ) {
    return emptyResponse(echo, REASON.invalidRequest, false);
  }

  const readAvailability = () => readThrough(
    trainsAvailabilityKey(filing),
    AVAILABILITY_TTL_SECONDS,
    () => fetchTrainsAvailability(filing),
  );
  const readRows = (rowsYear: number) => readThrough(
    trainsRowsKey(filing, hsCode, rowsYear),
    ROWS_TTL_SECONDS,
    () => fetchTrainsRows(filing, hsCode, rowsYear, 'reported'),
  );

  // An explicit year needs availability only to read the basis, so both reads
  // run together; year 0 must read availability first to pick the year.
  let year = requestedYear;
  let availability: TrainsAvailability | null;
  let trains: TrainsRows | null;
  if (year === 0) {
    availability = await readAvailability();
    if (!availability) return emptyResponse(echo, REASON.upstreamUnavailable, true);
    const latest = availability.years[availability.years.length - 1];
    if (!latest) return emptyResponse(echo, REASON.notCovered, false);
    year = latest.year;
    trains = await readRows(year);
  } else {
    [availability, trains] = await Promise.all([readAvailability(), readRows(year)]);
  }

  const sourceUrl = trainsRowsUrl(filing, hsCode, year);
  if (!trains) return emptyResponse(echo, REASON.upstreamUnavailable, true, sourceUrl);

  // Both reads below are best effort and independent, so they run together.
  // Without the AVE row the reported MFN row still stands, and its
  // non_ad_valorem_lines count tells the caller the average is partial.
  // Without group names the group codes are still returned.
  const needsAve = (findMfnRow(trains.rows)?.nonAdValoremLines ?? 0) > 0;
  const needsGroupNames = partner !== MFN_PARTNER
    && trains.rows.some((row) => GROUP_CODE.test(row.partner) && row.tariffType !== 'MFN');
  const [ave, groupNames] = await Promise.all([
    needsAve
      ? readThrough(
        trainsRowsKey(filing, hsCode, year, 'aveestimated'),
        ROWS_TTL_SECONDS,
        () => fetchTrainsRows(filing, hsCode, year, 'aveestimated'),
        AVE_FETCH_TIMEOUT_MS + 1_000,
      )
      : Promise.resolve(null),
    needsGroupNames
      ? readThrough(TRAINS_GROUP_NAMES_KEY, GROUP_NAMES_TTL_SECONDS, fetchTrainsGroupNames)
      : Promise.resolve(null),
  ]);
  const mfnAveRow = ave ? findMfnRow(ave.rows) : undefined;

  const availabilityYear = availability?.years.find((entry) => entry.year === year);
  const preferencesReported = availability
    ? (availabilityYear?.partners.some((code) => code !== MFN_PARTNER) ?? false)
    : null;
  const resolved = resolveBilateralTariff(trains.rows, partner, preferencesReported, mfnAveRow);
  if (!resolved) return emptyResponse(echo, REASON.notCovered, false, sourceUrl);

  const groupPreferences: GroupTariffPreference[] = resolved.groupRows.map((row) => ({
    groupCode: row.partner,
    groupName: groupNames?.names[row.partner] ?? '',
    rate: toDetail(row),
  }));

  return {
    ...echo,
    year,
    nomenclature: resolved.nomenclature || availabilityYear?.nomenclature || '',
    basis: resolved.basis,
    ...(resolved.applied ? { appliedRate: resolved.applied } : {}),
    ...(resolved.mfn ? { mfnRate: resolved.mfn } : {}),
    ...(resolved.mfnAve ? { mfnAveRate: resolved.mfnAve } : {}),
    ...(resolved.preferential ? { preferentialRate: resolved.preferential } : {}),
    groupPreferences,
    source: BILATERAL_TARIFF_SOURCE,
    sourceUrl,
    upstreamUnavailable: false,
    unavailableReason: REASON.served,
  };
}
