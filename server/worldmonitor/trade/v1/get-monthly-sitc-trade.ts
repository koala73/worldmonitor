/**
 * RPC: getMonthlySitcTrade -- serves a country's monthly trade by SITC section
 * from a Railway seed. Malaysia comes from DOSM via scripts/seed-trade-sitc-my.mjs;
 * the handler never calls the publisher.
 */
import type {
  ServerContext,
  GetMonthlySitcTradeRequest,
  GetMonthlySitcTradeResponse,
  SitcTradeMonth,
  SitcTradeSeries,
  TradeFlowUnavailableReason,
} from '../../../../src/generated/server/worldmonitor/trade/v1/service_server';
import { readCachedJson } from '../../../_shared/redis';

/** Must match scripts/seed-trade-sitc-my.mjs; pinned by tests. */
export const SITC_TRADE_SEED_KEYS: Readonly<Record<string, string>> = { MY: 'trade:monthly-sitc:my:v1' };
export const DEFAULT_SITC_COUNTRY = 'MY';
export const DEFAULT_SITC_MONTHS = 60;
/** Must equal the `months` maximum in get_monthly_sitc_trade.proto. */
export const MAX_SITC_MONTHS = 480;
export const SITC_SECTION_ORDER = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'overall'] as const;

const REASON = {
  served: 'TRADE_FLOW_UNAVAILABLE_REASON_UNSPECIFIED',
  invalidRequest: 'TRADE_FLOW_UNAVAILABLE_REASON_INVALID_REQUEST',
  notCovered: 'TRADE_FLOW_UNAVAILABLE_REASON_NOT_COVERED',
  seedMissing: 'TRADE_FLOW_UNAVAILABLE_REASON_SEED_MISSING',
  cacheUnavailable: 'TRADE_FLOW_UNAVAILABLE_REASON_CACHE_UNAVAILABLE',
} as const satisfies Record<string, TradeFlowUnavailableReason>;

interface SeededSitcTrade {
  country?: string;
  currency?: string;
  source?: string;
  sourceUrl?: string;
  indexBase?: string;
  latestMonth?: string;
  latestIndexMonth?: string;
  fetchedAt?: number;
  sections?: { section?: string; label?: string; months?: unknown[] }[];
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const INDEX_FIELDS = ['exportsUnitValueIndex', 'exportsVolumeIndex', 'importsUnitValueIndex', 'importsVolumeIndex'] as const;

export interface NormalizedSitcRequest { country: string; sections: string[]; months: number }

/** Resolve defaults, or null for a malformed request the route validator would have rejected. */
export function normalizeSitcRequest(req: GetMonthlySitcTradeRequest): NormalizedSitcRequest | null {
  const country = (req.country ?? '').trim();
  if (country !== '' && !/^[A-Z]{2}$/.test(country)) return null;
  const requested = Array.isArray(req.sections) ? req.sections.map((section) => String(section).trim()) : [];
  if (requested.length > SITC_SECTION_ORDER.length || requested.some((section) => !(SITC_SECTION_ORDER as readonly string[]).includes(section))) return null;
  const months = req.months;
  if (typeof months !== 'number' || !Number.isInteger(months) || months < 0 || months > MAX_SITC_MONTHS) return null;
  const wanted = new Set(requested);
  return {
    country: country || DEFAULT_SITC_COUNTRY,
    sections: SITC_SECTION_ORDER.filter((section) => wanted.size === 0 || wanted.has(section)),
    months: months || DEFAULT_SITC_MONTHS,
  };
}

function cleanMonth(value: unknown): SitcTradeMonth | null {
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row.month !== 'string' || !MONTH.test(row.month)) return null;
  const exports = row.exports;
  const imports = row.imports;
  // Require real numbers: Number(null), Number('') and Number(false) would all read as 0.
  if (typeof exports !== 'number' || typeof imports !== 'number') return null;
  if (!Number.isFinite(exports) || exports < 0 || !Number.isFinite(imports) || imports < 0) return null;
  const month: SitcTradeMonth = { month: row.month, exports, imports };
  for (const field of INDEX_FIELDS) {
    const index = row[field];
    if (typeof index === 'number' && Number.isFinite(index) && index > 0) month[field] = index;
  }
  return month;
}

/** Slice each requested section to its newest `months` well-formed entries, oldest first. */
export function buildSitcSeries(seeded: SeededSitcTrade, sections: readonly string[], months: number): SitcTradeSeries[] {
  const bySection = new Map((seeded.sections ?? []).map((entry) => [entry?.section, entry]));
  return sections.flatMap((section) => {
    const entry = bySection.get(section);
    if (!entry || !Array.isArray(entry.months)) return [];
    const clean = entry.months.map(cleanMonth).filter((month): month is SitcTradeMonth => month !== null)
      .sort((a, b) => a.month.localeCompare(b.month));
    if (clean.length === 0) return [];
    return [{ section, label: typeof entry.label === 'string' ? entry.label : '', months: clean.slice(-months) }];
  });
}

function unavailable(country: string, reason: TradeFlowUnavailableReason, upstreamUnavailable: boolean): GetMonthlySitcTradeResponse {
  return {
    country, currency: '', source: '', sourceUrl: '', indexBase: '', latestMonth: '', latestIndexMonth: '',
    fetchedAt: 0, series: [], upstreamUnavailable, unavailableReason: reason,
  };
}

export async function getMonthlySitcTrade(
  _ctx: ServerContext,
  req: GetMonthlySitcTradeRequest,
): Promise<GetMonthlySitcTradeResponse> {
  const normalized = normalizeSitcRequest(req);
  if (!normalized) return unavailable('', REASON.invalidRequest, false);
  const { country, sections, months } = normalized;
  const key = SITC_TRADE_SEED_KEYS[country];
  if (!key) return unavailable(country, REASON.notCovered, false);

  const read = await readCachedJson(key, true);
  if (read.status === 'error') {
    if (read.error instanceof Error && (read.error.name === 'TimeoutError' || read.error.name === 'AbortError')) {
      console.error(`[REDIS-TIMEOUT] readCachedJson key=${key}`);
    }
    console.warn(`[sitc-trade] ${key} read failed: ${read.error instanceof Error ? read.error.message : String(read.error)}`);
    return unavailable(country, REASON.cacheUnavailable, true);
  }
  const seeded = read.status === 'hit' ? (read.value as SeededSitcTrade | null) : null;
  const series = seeded ? buildSitcSeries(seeded, sections, months) : [];
  if (!seeded || series.length === 0) return unavailable(country, REASON.seedMissing, true);

  return {
    country,
    currency: typeof seeded.currency === 'string' ? seeded.currency : '',
    source: typeof seeded.source === 'string' ? seeded.source : '',
    sourceUrl: typeof seeded.sourceUrl === 'string' ? seeded.sourceUrl : '',
    indexBase: typeof seeded.indexBase === 'string' ? seeded.indexBase : '',
    latestMonth: typeof seeded.latestMonth === 'string' ? seeded.latestMonth : '',
    latestIndexMonth: typeof seeded.latestIndexMonth === 'string' ? seeded.latestIndexMonth : '',
    fetchedAt: typeof seeded.fetchedAt === 'number' && Number.isFinite(seeded.fetchedAt) && seeded.fetchedAt > 0 ? seeded.fetchedAt : 0,
    series,
    upstreamUnavailable: false,
    unavailableReason: REASON.served,
  };
}
