// MCP projection for get_capital_flows (economic:capital-flows:v1).
//
// The seeded payload is ~700 KB for ~230 countries, far above the tool's output
// budget, so the tool never returns it whole:
//   - with `country`: the full per-country views for up to 10 countries
//     (BOP series only when include_series is true);
//   - without: a compact ranking of the countries that have the `sort` metric
//     (the default outflow_z excludes annual-only series, which carry no
//     z-score), capped by `limit`, so an agent can ask "where is capital
//     leaving fastest";
//   - with `country` and `counterpart`: both directions of each pair as well.

import { buildCapitalFlowPair, sameSeedRun } from '../../../server/worldmonitor/economic/v1/capital-flows';

export const CAPITAL_FLOWS_LABEL = 'capital-flows';
export const CAPITAL_FLOWS_PAIRS_LABEL = 'capital-flows-pairs';
export const CAPITAL_FLOWS_MAX_COUNTRIES = 10;

/** JSON Schema for one direction of a pair (CapitalFlowPairLeg). */
export const CAPITAL_FLOW_PAIR_LEG_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['reported', 'not_itemized', 'not_published'], description: 'not_itemized: the reporting side publishes bilateral data but has no current figure for this partner (zero, small, confidential or a stopped series). not_published: the reporting side publishes no bilateral breakdown.' },
    stockUsdBn: { type: 'number' },
    flow4qUsdBn: { type: 'number', description: 'Bank legs: last 4 FX- and break-adjusted quarterly changes.' },
    prevYearUsdBn: { type: 'number', description: 'Portfolio legs: the same holding a year earlier.' },
    basis: { type: 'string', enum: ['investor', 'host'], description: 'FDI legs: whose report stockUsdBn is.' },
    instrument: { type: 'string', enum: ['loans_deposits', 'all_instruments'], description: 'Bank legs: loans_deposits normally; all_instruments (adds debt securities) where the reporting banking system publishes no loans-and-deposits breakdown.' },
    counterpartReportUsdBn: { type: 'number', description: 'FDI legs: the other side\'s figure for the same position.' },
    history: {
      type: 'array',
      description: 'Bank legs: adjusted quarterly flows, oldest first (up to 8 quarters).',
      items: { type: 'object', properties: { period: { type: 'string' }, usdBn: { type: 'number' } }, required: ['period', 'usdBn'] },
    },
  },
  required: ['status'],
} as const;

export const CAPITAL_FLOWS_SORTS = [
  'outflow_z',
  'inflow_z',
  'outflows_pct_gdp',
  'inflows_pct_gdp',
  'net_usd_bn',
  'bank_deposits_abroad_flow_4q',
  'foreign_portfolio_change_pct',
] as const;
export type CapitalFlowsSort = (typeof CAPITAL_FLOWS_SORTS)[number];

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export interface CapitalFlowsRankingRow {
  country: string;
  frequency: string | null;
  latestPeriod: string | null;
  inflowState: string | null;
  outflowState: string | null;
  inflowZ: number | null;
  outflowZ: number | null;
  inflowsUsdBn: number | null;
  outflowsUsdBn: number | null;
  netUsdBn: number | null;
  inflowsPctGdp: number | null;
  outflowsPctGdp: number | null;
  bankDepositsAbroadFlow4qUsdBn: number | null;
  foreignPortfolioChangePct: number | null;
}

export function rankingRow(iso2: string, entry: unknown): CapitalFlowsRankingRow {
  const c = obj(entry) ?? {};
  const bop = obj(c.bop);
  const state = obj(bop?.state);
  const totals = obj(bop?.trailing4q) ?? obj(bop?.latestYear);
  const bank = obj(c.bank);
  const portfolio = obj(c.portfolio);
  return {
    country: iso2,
    frequency: typeof bop?.frequency === 'string' ? bop.frequency : null,
    latestPeriod: typeof bop?.latestPeriod === 'string' ? bop.latestPeriod : null,
    inflowState: typeof state?.inflow === 'string' ? state.inflow : null,
    outflowState: typeof state?.outflow === 'string' ? state.outflow : null,
    inflowZ: num(state?.inflowZ),
    outflowZ: num(state?.outflowZ),
    inflowsUsdBn: num(totals?.inflowsUsdBn),
    outflowsUsdBn: num(totals?.outflowsUsdBn),
    netUsdBn: num(totals?.netUsdBn),
    inflowsPctGdp: num(totals?.inflowsPctGdp),
    outflowsPctGdp: num(totals?.outflowsPctGdp),
    bankDepositsAbroadFlow4qUsdBn: num(obj(bank?.nonBankDepositsAbroad)?.flow4qUsdBn),
    foreignPortfolioChangePct: num(portfolio?.changePct),
  };
}

const SORT_FIELD: Record<CapitalFlowsSort, keyof CapitalFlowsRankingRow> = {
  outflow_z: 'outflowZ',
  inflow_z: 'inflowZ',
  outflows_pct_gdp: 'outflowsPctGdp',
  inflows_pct_gdp: 'inflowsPctGdp',
  net_usd_bn: 'netUsdBn',
  bank_deposits_abroad_flow_4q: 'bankDepositsAbroadFlow4qUsdBn',
  foreign_portfolio_change_pct: 'foreignPortfolioChangePct',
};

export interface CapitalFlowsProjectionArgs {
  countries: string[]; // lower-case ISO2, already resolved
  counterpart?: string; // lower-case ISO2, already resolved
  includeSeries: boolean;
  sort: CapitalFlowsSort;
  ascending: boolean;
  limit: number; // 0 = no cap
}

const PAIR_LEGS = ['aDepositsInB', 'bDepositsInA', 'aBorrowingFromB', 'bBorrowingFromA', 'aHoldingsOfB', 'bHoldingsOfA', 'aFdiInB', 'bFdiInA'] as const;

// Drop the proto defaults (empty basis, empty history) that carry no meaning.
function compactPair(pair: ReturnType<typeof buildCapitalFlowPair>): Json | null {
  if (!pair) return null;
  const out: Json = { ...pair };
  for (const key of PAIR_LEGS) {
    const leg = pair[key];
    if (!leg) continue;
    const compact: Json = { ...leg };
    if (!leg.basis) delete compact.basis;
    if (!leg.instrument) delete compact.instrument;
    if (!leg.history?.length) delete compact.history;
    out[key] = compact;
  }
  return out;
}

/**
 * Replace data['capital-flows'] with the country detail, the pair view or the
 * ranking, and drop the raw pair matrices. Mutates and returns `data`.
 */
export function projectCapitalFlows(data: Json, args: CapitalFlowsProjectionArgs): Json {
  const pairsRaw = data[CAPITAL_FLOWS_PAIRS_LABEL];
  delete data[CAPITAL_FLOWS_PAIRS_LABEL];
  const payload = obj(data[CAPITAL_FLOWS_LABEL]);
  if (!payload) return data;
  const map = obj(payload.countries) ?? {};
  const out: Json = {
    latest: payload.latest ?? null,
    coverage: payload.coverage ?? null,
    units: payload.units ?? 'USD billions',
    method: payload.method ?? null,
    seededAt: payload.seededAt ?? null,
  };

  if (args.countries.length > 0) {
    const partner = args.counterpart?.toUpperCase();
    const view = (iso2: string): Json | null => {
      const entry = obj(map[iso2]);
      if (!entry) return null;
      const bop = obj(entry.bop);
      return { ...entry, bop: bop ? { ...bop, series: args.includeSeries ? bop.series ?? [] : undefined } : null };
    };
    const requested = args.countries.slice(0, CAPITAL_FLOWS_MAX_COUNTRIES).map((code) => code.toUpperCase());
    const countries: Json = {};
    // With a counterpart, its own view comes back too so both sides read in one call.
    for (const iso2 of partner ? [...requested, partner] : requested) countries[iso2] = view(iso2);
    out.countries = countries;
    if (partner) {
      // null when the pair matrices are missing; otherwise each leg carries its own status.
      // Matrices from a different seed run than the views (one write failed)
      // are not mixed in: those pairs come back null.
      const fresh = sameSeedRun(payload, pairsRaw);
      out.pairs = requested
        .filter((iso2) => iso2 !== partner)
        .map((iso2) => (fresh ? compactPair(buildCapitalFlowPair(pairsRaw, iso2, partner)) : null));
    }
  } else {
    const field = SORT_FIELD[args.sort];
    const rows = Object.keys(map).sort().map((iso2) => rankingRow(iso2, map[iso2]));
    const ranked = rows
      .filter((r) => r[field] != null)
      .sort((a, b) => {
        const av = a[field] as number;
        const bv = b[field] as number;
        return args.ascending ? av - bv : bv - av;
      });
    out.sort = args.sort;
    out.order = args.ascending ? 'ascending' : 'descending';
    out.rankedCount = ranked.length;
    out.ranking = args.limit > 0 ? ranked.slice(0, args.limit) : ranked;
  }
  data[CAPITAL_FLOWS_LABEL] = out;
  return data;
}
