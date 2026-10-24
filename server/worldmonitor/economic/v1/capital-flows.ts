import type {
  CapitalFlowBank,
  CapitalFlowBop,
  CapitalFlowComponents,
  CapitalFlowCounterparty,
  CapitalFlowCountry,
  CapitalFlowEpisode,
  CapitalFlowFdi,
  CapitalFlowPair,
  CapitalFlowPairLeg,
  CapitalFlowPeriod,
  CapitalFlowPortfolio,
  CapitalFlowPosition,
  CapitalFlowTotals,
  GetCapitalFlowsResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

// Written by scripts/seed-capital-flows.mjs.
export const CAPITAL_FLOWS_KEY = 'economic:capital-flows:v1';
// Full bilateral matrices, same producer.
export const CAPITAL_FLOWS_PAIRS_KEY = 'economic:capital-flows:pairs:v1';

type Json = Record<string, unknown>;

const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const epochMs = (v: unknown): number => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : 0; };

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
    publishesBilateral: o.publishesBilateral === true,
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

function fdi(v: unknown): CapitalFlowFdi | undefined {
  const o = obj(v);
  if (!o) return undefined;
  return {
    year: int(o.year),
    inwardUsdBn: num(o.inwardUsdBn),
    topInvestors: counterparties(o.topInvestors),
    outwardUsdBn: num(o.outwardUsdBn),
    topDestinations: counterparties(o.topDestinations),
  };
}

export function unavailableCapitalFlows(): GetCapitalFlowsResponse {
  return { countries: [], latest: undefined, seededAt: 0, unavailable: true, sources: [], method: {}, pair: undefined };
}

type Cell = (number | null)[];

/**
 * Both directions between country a and counterpart b from the pair matrices.
 * A leg is not_published when the reporting side (the bank location, or the
 * portfolio holder) does not publish a bilateral breakdown, not_itemized when
 * it publishes but has no current figure for this partner (not itemized, or
 * a series that stopped before the latest period), and reported otherwise.
 * Returns undefined when the pairs payload is missing or malformed.
 */
export function buildCapitalFlowPair(raw: unknown, a: string, b: string): CapitalFlowPair | undefined {
  const root = obj(raw);
  const bank = obj(root?.bank);
  const portfolio = obj(root?.portfolio);
  const fdiPairs = obj(root?.fdi);
  if (!root || (!bank && !portfolio && !fdiPairs)) return undefined;
  const A = a.trim().toUpperCase();
  const B = b.trim().toUpperCase();
  const bankReporters = new Set(arr(bank?.reporters).filter((x): x is string => typeof x === 'string'));
  const holders = new Set(arr(portfolio?.holders).filter((x): x is string => typeof x === 'string'));
  const byReporter = obj(bank?.byReporter) ?? {};
  const byHolder = obj(portfolio?.byHolder) ?? {};
  const fdiReporters = new Set(arr(fdiPairs?.reporters).filter((x): x is string => typeof x === 'string'));
  const byFdiReporter = obj(fdiPairs?.byReporter) ?? {};
  const quarters = arr(bank?.quarters).map(str);
  const allInstrument = new Set(arr(bank?.allInstrumentReporters).filter((x): x is string => typeof x === 'string'));

  // Deposits/lending sit on the books of `rep`'s banks against `cp`'s non-banks.
  const bankLeg = (rep: string, cp: string, idx: 0 | 2): CapitalFlowPairLeg => {
    if (!bankReporters.has(rep)) return { status: 'not_published', basis: '', history: [], instrument: '' };
    const instrument = allInstrument.has(rep) ? 'all_instruments' : 'loans_deposits';
    const cell = arr(obj(byReporter[rep])?.[cp]) as Cell;
    const flows = arr(cell[idx === 0 ? 4 : 5]);
    // History is kept even when the leg has no current position: a series
    // that stopped still shows the quarters it did report.
    const history = quarters.flatMap((period, i) => {
      const usdBn = num(flows[i]);
      return period && usdBn !== undefined ? [{ period, usdBn }] : [];
    });
    const stock = num(cell[idx]);
    if (stock === undefined) return { status: 'not_itemized', basis: '', history, instrument };
    return { status: 'reported', stockUsdBn: stock, flow4qUsdBn: num(cell[idx + 1]), basis: '', history, instrument };
  };
  const holdingLeg = (holder: string, issuer: string): CapitalFlowPairLeg => {
    if (!holders.has(holder)) return { status: 'not_published', basis: '', history: [], instrument: '' };
    const cell = arr(obj(byHolder[holder])?.[issuer]) as Cell;
    const stock = num(cell[0]);
    if (stock === undefined) return { status: 'not_itemized', basis: '', history: [], instrument: '' };
    return { status: 'reported', stockUsdBn: stock, prevYearUsdBn: num(cell[1]), basis: '', history: [], instrument: '' };
  };
  // investor's direct investment in host. The investor reports it as outward
  // (cell[1]), the host as inward (cell[0]); prefer the investor's figure and
  // keep the host's beside it, since the two often disagree.
  const fdiLeg = (investor: string, host: string): CapitalFlowPairLeg => {
    const investorFigure = fdiReporters.has(investor) ? num(arr(obj(byFdiReporter[investor])?.[host])[1]) : undefined;
    const hostFigure = fdiReporters.has(host) ? num(arr(obj(byFdiReporter[host])?.[investor])[0]) : undefined;
    if (investorFigure === undefined && hostFigure === undefined) {
      const status = fdiReporters.has(investor) || fdiReporters.has(host) ? 'not_itemized' : 'not_published';
      return { status, basis: '', history: [], instrument: '' };
    }
    return investorFigure !== undefined
      ? { status: 'reported', stockUsdBn: investorFigure, basis: 'investor', counterpartReportUsdBn: hostFigure, history: [], instrument: '' }
      : { status: 'reported', stockUsdBn: hostFigure, basis: 'host', counterpartReportUsdBn: undefined, history: [], instrument: '' };
  };

  return {
    country: A,
    counterpart: B,
    bankPeriod: str(bank?.period),
    portfolioYear: int(portfolio?.year),
    aDepositsInB: bankLeg(B, A, 0),
    bDepositsInA: bankLeg(A, B, 0),
    aBorrowingFromB: bankLeg(B, A, 2),
    bBorrowingFromA: bankLeg(A, B, 2),
    aHoldingsOfB: holdingLeg(A, B),
    bHoldingsOfA: holdingLeg(B, A),
    aFdiInB: fdiLeg(A, B),
    bFdiInA: fdiLeg(B, A),
    fdiYear: int(fdiPairs?.year),
  };
}

/** Both keys are written by one seeder run; a mismatch means one write failed. */
export function sameSeedRun(canonical: unknown, pairs: unknown): boolean {
  const a = str(obj(canonical)?.seededAt);
  const b = str(obj(pairs)?.seededAt);
  return a !== '' && a === b;
}

/** Map the seeded payload to the RPC response, optionally narrowed to one ISO2 country. */
export function buildCapitalFlowsResponse(
  raw: unknown,
  country: string,
  includeSeries: boolean,
  pairQuery?: { counterpart: string; pairsRaw: unknown },
): GetCapitalFlowsResponse {
  const root = obj(raw);
  const map = obj(root?.countries);
  if (!root || !map) return unavailableCapitalFlows();
  const wanted = country.trim().toUpperCase();
  const partner = pairQuery?.counterpart.trim().toUpperCase() ?? '';
  // With a pair query, return both countries' own views alongside the pair.
  const selected = new Set([wanted, wanted && partner ? partner : ''].filter(Boolean));
  const keys = Object.keys(map).sort();
  const countries: CapitalFlowCountry[] = [];
  for (const iso2 of wanted ? keys.filter((k) => selected.has(k)) : keys) {
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
      fdi: fdi(c.fdi),
    });
  }
  const latest = obj(root.latest);
  const method: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(root.method) ?? {})) if (typeof v === 'string') method[k] = v;
  return {
    countries,
    latest: latest ? { bopQuarter: str(latest.bopQuarter), bopYear: str(latest.bopYear), bisQuarter: str(latest.bisQuarter), pipYear: int(latest.pipYear), fdiYear: int(latest.fdiYear) } : undefined,
    seededAt: epochMs(root.seededAt),
    unavailable: false,
    sources: arr(root.sources).filter((s): s is string => typeof s === 'string'),
    method,
    // No self-pair: the matrices never hold a country against itself. No pair
    // either when the matrices come from a different seed run than the views.
    pair: wanted && partner && wanted !== partner && pairQuery && sameSeedRun(root, pairQuery.pairsRaw)
      ? buildCapitalFlowPair(pairQuery.pairsRaw, wanted, partner)
      : undefined,
  };
}
