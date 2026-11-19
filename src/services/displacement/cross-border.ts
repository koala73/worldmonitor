// UNHCR Operational Data Portal cross-border movements (#9023), mapped for the
// displacement panel and map layer. Kept free of browser-only imports so tests
// can load it directly. The payload shape is written by
// scripts/seed-cross-border-arrivals.mjs.

export type CrossBorderFlowKind = 'outflow' | 'return' | 'arrival' | 'death' | 'encounter';

interface Coordinates { latitude: number; longitude: number }

interface RawCountry {
  country: string;
  iso2?: string;
  individuals: number;
  date?: string;
  location?: Coordinates;
  change?: { since: string; delta: number };
  months?: { month: string; individuals: number }[];
  accelerating?: boolean;
}

interface RawFlow {
  kind: CrossBorderFlowKind;
  label: string;
  origin?: string;
  originLocation?: Coordinates;
  measure: 'stock' | 'monthly';
  total: number;
  asOf?: string;
  months?: { month: string; individuals: number }[];
  accelerating?: boolean;
  countries: RawCountry[];
}

interface RawSituation {
  id: string;
  name: string;
  origin?: string;
  sourceUrl?: string;
  asOf?: string;
  accelerating?: boolean;
  flows: RawFlow[];
  trend?: { measure: 'stock' | 'monthly'; points: [string, number][]; latestDelta: number | null; latestDays?: number | null; accelerating?: boolean };
}

export interface CrossBorderSituation {
  source?: string;
  last7Days?: number;
  last30Days?: number;
  changePct?: number;
  measure?: string;
  kind?: string;
  stale?: boolean;
  id: string;
  name: string;
  sourceUrl: string;
  asOf: string;
  accelerating: boolean;
  /** People who left the crisis country and are hosted abroad, across all receiving countries. */
  outflow: number;
  /** Outflow, or arrivals so far this year for situations reported monthly. */
  total: number;
  /** Arrivals in the latest complete month, for situations reported monthly. */
  lastMonth: { month: string; individuals: number } | null;
  /** Latest change in the situation total: delta over `days` (stock) or the latest complete month (monthly). */
  latestChange: { delta: number; days: number | null } | null;
  /** The largest receiving countries, for the panel row. */
  topCountries: string[];
  /** ISO2 codes of the crisis country and every receiving country, for the followed-countries filter. */
  countryCodes: string[];
  lat?: number;
  lon?: number;
}

/** One receiving country in one flow, for the map. */
export interface CrossBorderPoint {
  source?: string;
  sourceUrl?: string;
  changePct?: number;
  last30Days?: number;
  measure?: string;
  period?: string;
  situation: string;
  label: string;
  kind: CrossBorderFlowKind;
  country: string;
  individuals: number;
  date: string;
  change: number | null;
  changeSince: string;
  lastMonth: number | null;
  accelerating: boolean;
  lat: number;
  lon: number;
}

export interface CrossBorderData {
  deaths?: CrossBorderPoint[];
  sources?: import('@/generated/client/worldmonitor/displacement/v1/service_client').CrossBorderSourceStatus[];
  situations: CrossBorderSituation[];
  points: CrossBorderPoint[];
}

export const EMPTY_CROSS_BORDER: CrossBorderData = { situations: [], points: [] };

function isPayload(value: unknown): value is { situations: RawSituation[] } {
  return !!value && typeof value === 'object' && Array.isArray((value as { situations?: unknown }).situations);
}

const lastCompleteMonth = (months?: { month: string; individuals: number }[]) => months?.[1] ?? null;

export function toCrossBorderData(payload: unknown): CrossBorderData {
  if (!isPayload(payload)) return EMPTY_CROSS_BORDER;
  const situations: CrossBorderSituation[] = [];
  const points: CrossBorderPoint[] = [];

  for (const s of payload.situations) {
    const flows = Array.isArray(s.flows) ? s.flows : [];
    const outflows = flows.filter((f) => f.kind === 'outflow');
    const monthly = flows.find((f) => f.kind === 'arrival' && f.measure === 'monthly');
    const countryTotals = new Map<string, number>();
    for (const f of flows.filter((f) => f.kind === 'outflow' || f.kind === 'arrival')) {
      for (const c of f.countries) countryTotals.set(c.country, Math.max(countryTotals.get(c.country) ?? 0, c.individuals));
    }
    const top = [...countryTotals.entries()].sort((a, b) => b[1] - a[1]);
    const largest = flows.flatMap((f) => f.countries).filter((c) => c.location).sort((a, b) => b.individuals - a.individuals)[0];
    const trend = s.trend;
    const outflow = outflows.reduce((sum, f) => sum + (Number(f.total) || 0), 0);
    situations.push({
      id: s.id,
      name: s.name,
      sourceUrl: s.sourceUrl ?? '',
      asOf: s.asOf ?? '',
      accelerating: Boolean(s.accelerating),
      outflow,
      total: outflow > 0 ? outflow : (Number(monthly?.total) || 0),
      lastMonth: lastCompleteMonth(monthly?.months),
      latestChange: trend && trend.latestDelta !== null && Number.isFinite(trend.latestDelta)
        ? { delta: trend.latestDelta, days: trend.measure === 'stock' ? (trend.latestDays ?? null) : null }
        : null,
      topCountries: top.slice(0, 3).map(([name]) => name),
      countryCodes: [...new Set([s.origin, ...flows.map((f) => f.origin), ...flows.flatMap((f) => f.countries.map((c) => c.iso2))]
        .filter((code): code is string => typeof code === 'string' && code.length === 2))],
      lat: largest?.location?.latitude,
      lon: largest?.location?.longitude,
    });

    for (const f of flows) {
      if (f.kind === 'death') continue;
      for (const c of f.countries) {
        if (!c.location || !(c.individuals > 0)) continue;
        points.push({
          situation: s.name,
          label: f.label,
          kind: f.kind,
          country: c.country,
          individuals: c.individuals,
          date: c.date ?? '',
          change: c.change ? c.change.delta : null,
          changeSince: c.change?.since ?? '',
          lastMonth: lastCompleteMonth(c.months)?.individuals ?? null,
          accelerating: Boolean(c.accelerating),
          lat: c.location.latitude,
          lon: c.location.longitude,
        });
      }
    }
  }

  // Situations overlap (Sudanese refugees in Chad are in the Sudan and Sahel
  // situations), so the map keeps one point per country and kind: the largest.
  const byCountryKind = new Map<string, CrossBorderPoint>();
  for (const p of points) {
    const key = `${p.country}|${p.kind}`;
    const prev = byCountryKind.get(key);
    if (!prev || p.individuals > prev.individuals) byCountryKind.set(key, p);
  }
  return {
    situations,
    points: [...byCountryKind.values()].sort((a, b) => b.individuals - a.individuals),
  };
}

export function toMovementData(payload: import('@/generated/client/worldmonitor/displacement/v1/service_client').GetCrossBorderMovementsResponse, now = Date.now()): CrossBorderData {
  const situations: CrossBorderSituation[] = [];
  const points: CrossBorderPoint[] = [];
  const deaths: CrossBorderPoint[] = [];
  const sources = payload.sources.map(source => ({
    ...source,
    status: source.status !== 'unavailable' && (now - source.fetchedAt > 48 * 3600000
      || now - source.contentAt > source.maxContentAgeMin * 60000) ? 'stale' : source.status,
  }));
  const bySource = new Map(sources.map(source => [source.name, source]));
  for (const movement of payload.movements) {
    const { location } = movement;
    const source = bySource.get(movement.source);
    const reportAt = Date.parse(movement.asOf);
    const stale = movement.stale || !source || ['stale', 'unavailable'].includes(source.status)
      || !Number.isFinite(reportAt) || now - reportAt > source.maxContentAgeMin * 60000;
    const surge = movement.surge && !stale;
    const item: CrossBorderSituation = {
      id: movement.id, name: movement.name, sourceUrl: movement.sourceUrl, source: movement.source,
      asOf: movement.asOf, accelerating: surge, outflow: movement.kind === 'outflow' ? movement.count : 0,
      total: movement.count, lastMonth: movement.measure === 'monthly' ? { month: movement.period, individuals: movement.count } : null,
      latestChange: movement.stockChange !== undefined ? { delta: movement.stockChange, days: movement.stockChangeSince ? Math.round((Date.parse(movement.asOf) - Date.parse(movement.stockChangeSince)) / 86400000) : null } : null, topCountries: [], countryCodes: [movement.countryCode, movement.originCode].filter(Boolean),
      lat: location?.latitude, lon: location?.longitude, last7Days: movement.last7Days, last30Days: movement.last30Days,
      changePct: movement.changePct, measure: movement.measure, kind: movement.kind, stale,
    };
    situations.push(item);
    if (!location || stale || movement.count === 0 && !(movement.last30Days! > 0)) continue;
    const point: CrossBorderPoint = {
      situation: movement.route, label: movement.name, country: movement.countryCode, kind: movement.kind as CrossBorderFlowKind,
      individuals: movement.last30Days ?? movement.count, date: movement.asOf, change: movement.stockChange ?? null, changeSince: movement.stockChangeSince,
      lastMonth: movement.measure === 'monthly' ? movement.count : null, accelerating: surge,
      lat: location.latitude, lon: location.longitude, source: movement.source, sourceUrl: movement.sourceUrl,
      changePct: movement.changePct, last30Days: movement.last30Days, measure: movement.measure, period: movement.period,
    };
    if (movement.kind === 'death') deaths.push(point);
    else points.push(point);
  }
  const stockPoints = new Map<string, CrossBorderPoint>();
  const routePoints = points.filter(point => {
    if (point.measure !== 'stock') return true;
    const key = `${point.country}:${point.kind}`;
    const previous = stockPoints.get(key);
    if (!previous || point.individuals > previous.individuals) stockPoints.set(key, point);
    return false;
  });
  return { situations, points: [...routePoints, ...stockPoints.values()], deaths, sources };
}
