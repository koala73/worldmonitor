// MCP projection for get_capital_flows (economic:capital-flows:v1).
//
// The seeded payload is ~700 KB for ~230 countries, far above the tool's output
// budget, so the tool never returns it whole:
//   - with `country`: the full per-country views for up to 10 countries
//     (BOP series only when include_series is true);
//   - without: a compact ranking of every country, sorted by `sort` and capped
//     by `limit`, so an agent can ask "where is capital leaving fastest".

export const CAPITAL_FLOWS_LABEL = 'capital-flows';
export const CAPITAL_FLOWS_MAX_COUNTRIES = 10;

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
  includeSeries: boolean;
  sort: CapitalFlowsSort;
  ascending: boolean;
  limit: number; // 0 = no cap
}

/** Replace data['capital-flows'] with the country detail or the ranking. Mutates and returns `data`. */
export function projectCapitalFlows(data: Json, args: CapitalFlowsProjectionArgs): Json {
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
    const countries: Json = {};
    for (const code of args.countries.slice(0, CAPITAL_FLOWS_MAX_COUNTRIES)) {
      const iso2 = code.toUpperCase();
      const entry = obj(map[iso2]);
      if (!entry) { countries[iso2] = null; continue; }
      const bop = obj(entry.bop);
      countries[iso2] = {
        ...entry,
        bop: bop ? { ...bop, series: args.includeSeries ? bop.series ?? [] : undefined } : null,
      };
    }
    out.countries = countries;
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
