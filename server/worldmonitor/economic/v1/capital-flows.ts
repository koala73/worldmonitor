import type {
  CapitalFlowBank,
  CapitalFlowBop,
  CapitalFlowComponents,
  CapitalFlowCounterparty,
  CapitalFlowCountry,
  CapitalFlowEpisode,
  CapitalFlowPeriod,
  CapitalFlowPortfolio,
  CapitalFlowPosition,
  CapitalFlowTotals,
  GetCapitalFlowsResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

// Written by scripts/seed-capital-flows.mjs.
export const CAPITAL_FLOWS_KEY = 'economic:capital-flows:v1';

type Json = Record<string, unknown>;

const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function components(v: unknown): CapitalFlowComponents | undefined {
  const o = obj(v);
  if (!o) return undefined;
  return { fdi: num(o.fdi), portfolio: num(o.portfolio), other: num(o.other), total: num(o.total) };
}

function period(v: unknown): CapitalFlowPeriod | null {
  const o = obj(v);
  if (!o || !str(o.period)) return null;
  return { period: str(o.period), inflows: components(o.inflows), outflows: components(o.outflows), errorsOmissions: num(o.errorsOmissions) };
}

function episodes(v: unknown): CapitalFlowEpisode[] {
  return arr(v).flatMap((e) => {
    const o = obj(e);
    if (!o || !str(o.start)) return [];
    return [{ start: str(o.start), end: str(o.end), quarters: int(o.quarters), peakZ: num(o.peakZ) ?? 0, peakPeriod: str(o.peakPeriod) }];
  });
}

function totals(v: unknown): CapitalFlowTotals | undefined {
  const o = obj(v);
  if (!o) return undefined;
  return {
    inflowsUsdBn: num(o.inflowsUsdBn),
    outflowsUsdBn: num(o.outflowsUsdBn),
    netUsdBn: num(o.netUsdBn),
    inflowsPctGdp: num(o.inflowsPctGdp),
    outflowsPctGdp: num(o.outflowsPctGdp),
    inflowsYoyPct: num(o.inflowsYoyPct),
    outflowsYoyPct: num(o.outflowsYoyPct),
  };
}

function bop(v: unknown, includeSeries: boolean): CapitalFlowBop | undefined {
  const o = obj(v);
  if (!o) return undefined;
  const state = obj(o.state);
  const eps = obj(o.episodes);
  return {
    frequency: str(o.frequency),
    latestPeriod: str(o.latestPeriod),
    state: state ? { inflow: str(state.inflow), outflow: str(state.outflow), inflowZ: num(state.inflowZ), outflowZ: num(state.outflowZ) } : undefined,
    episodes: eps ? { surge: episodes(eps.surge), stop: episodes(eps.stop), flight: episodes(eps.flight), retrenchment: episodes(eps.retrenchment) } : undefined,
    totals: totals(o.trailing4q ?? o.latestYear),
    series: includeSeries ? arr(o.series).flatMap((p) => period(p) ?? []) : [],
  };
}

function position(v: unknown): CapitalFlowPosition | undefined {
  const o = obj(v);
  return o ? { stockUsdBn: num(o.stockUsdBn), flow4qUsdBn: num(o.flow4qUsdBn) } : undefined;
}

// Bank lists carry stockUsdBn; portfolio lists carry usdBn. Both map to stockUsdBn.
function counterparties(v: unknown): CapitalFlowCounterparty[] {
  return arr(v).flatMap((c) => {
    const o = obj(c);
    if (!o || !str(o.iso2)) return [];
    return [{ country: str(o.iso2), stockUsdBn: num(o.stockUsdBn ?? o.usdBn), flow4qUsdBn: num(o.flow4qUsdBn) }];
  });
}

function bank(v: unknown): CapitalFlowBank | undefined {
  const o = obj(v);
  if (!o) return undefined;
  return {
    latestPeriod: str(o.latestPeriod),
    nonBankDepositsAbroad: position(o.nonBankDepositsAbroad),
    householdDepositsAbroad: position(o.householdDepositsAbroad),
    nonBankBorrowingFromAbroad: position(o.nonBankBorrowingFromAbroad),
    topBankLocations: counterparties(o.topBankLocations),
    reportsToBis: o.reportsToBis === true,
    topDepositorOrigins: counterparties(o.topDepositorOrigins),
  };
}

function portfolio(v: unknown): CapitalFlowPortfolio | undefined {
  const o = obj(v);
  if (!o) return undefined;
  return {
    year: int(o.year),
    foreignHoldingsUsdBn: num(o.foreignHoldingsUsdBn),
    foreignHoldingsPrevYearUsdBn: num(o.foreignHoldingsPrevYearUsdBn),
    changePct: num(o.changePct),
    reporterCount: int(o.reporterCount),
    topHolders: counterparties(o.topHolders),
    holdingsAbroadUsdBn: num(o.holdingsAbroadUsdBn),
    topDestinations: counterparties(o.topDestinations),
  };
}

export function unavailableCapitalFlows(): GetCapitalFlowsResponse {
  return { countries: [], latest: undefined, seededAt: '', unavailable: true, sources: [], method: {} };
}

/** Map the seeded payload to the RPC response, optionally narrowed to one ISO2 country. */
export function buildCapitalFlowsResponse(raw: unknown, country: string, includeSeries: boolean): GetCapitalFlowsResponse {
  const root = obj(raw);
  const map = obj(root?.countries);
  if (!root || !map) return unavailableCapitalFlows();
  const wanted = country.trim().toUpperCase();
  const keys = Object.keys(map).sort();
  const countries: CapitalFlowCountry[] = [];
  for (const iso2 of wanted ? keys.filter((k) => k === wanted) : keys) {
    const c = obj(map[iso2]);
    if (!c) continue;
    countries.push({
      country: iso2,
      iso3: str(c.iso3),
      gdpUsdBn: num(c.gdpUsdBn),
      gdpYear: int(c.gdpYear),
      bop: bop(c.bop, includeSeries),
      bank: bank(c.bank),
      portfolio: portfolio(c.portfolio),
    });
  }
  const latest = obj(root.latest);
  const method: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(root.method) ?? {})) if (typeof v === 'string') method[k] = v;
  return {
    countries,
    latest: latest ? { bopQuarter: str(latest.bopQuarter), bopYear: str(latest.bopYear), bisQuarter: str(latest.bisQuarter), pipYear: int(latest.pipYear) } : undefined,
    seededAt: str(root.seededAt),
    unavailable: false,
    sources: arr(root.sources).filter((s): s is string => typeof s === 'string'),
    method,
  };
}
