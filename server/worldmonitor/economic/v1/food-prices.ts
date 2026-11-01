import sourceDefinitions from '../../../../shared/food-price-sources.json';
import type { FoodMarketPrice, FoodPriceSource, FoodSecurityContext } from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

export const FOOD_PRICE_SOURCES = sourceDefinitions;
export const foodPriceKey = (id: string): string => `economic:food-prices:${id}:v1`;

type SourceDefinition = typeof sourceDefinitions[number];
type Observation = Pick<FoodMarketPrice, 'item' | 'market' | 'marketType' | 'origin' | 'unit' | 'currency' | 'date' | 'price'>;
type Context = Omit<FoodSecurityContext, 'fetchedAt' | 'status'> & { fetchedAt?: string; fetchFailed?: boolean };
interface Snapshot { fetchedAt?: string; reportUrl?: string; observations?: Observation[]; contexts?: Context[] }
const DAY = 86400000;
const seriesKey = (row: Observation): string => JSON.stringify([row.market, row.marketType, row.item, row.unit, row.currency, row.origin ?? '']);

function validDate(value: unknown, now: number): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && ms <= now && new Date(ms).toISOString().slice(0, 10) === value;
}

function publisherUrl(value: unknown, source: SourceDefinition): string {
  if (typeof value !== 'string') return source.url;
  try {
    const url = new URL(value);
    const hosts: string[] = [new URL(source.url).hostname, ...('hosts' in source && Array.isArray(source.hosts) ? source.hosts : [])];
    if (url.protocol === 'https:' && hosts.includes(url.hostname) && !url.username && !url.password) return url.href;
  } catch { /* Use the registered publisher when a cached link is malformed. */ }
  return source.url;
}

function fetchIsStale(value: string, maxAgeDays: number, now: number): boolean {
  const time = Date.parse(value);
  return !Number.isFinite(time) || time > now + 300000 || now - time > maxAgeDays * DAY;
}

export function buildFoodPriceSource(source: SourceDefinition, value: unknown, now = Date.now()): FoodPriceSource {
  const snapshot = value && typeof value === 'object' ? value as Snapshot : {};
  const fetchedAt = typeof snapshot.fetchedAt === 'string' ? snapshot.fetchedAt : '';
  const rows = (Array.isArray(snapshot.observations) ? snapshot.observations : []).filter(row => row
    && [row.item, row.market, row.marketType, row.unit, row.currency].every(value => typeof value === 'string' && value.length > 0)
    && (row.origin == null || typeof row.origin === 'string')
    && Number.isFinite(row.price) && row.price > 0 && validDate(row.date, now));
  const latestDate = rows.map(row => row.date).sort().slice(-1)[0] ?? '';
  const history = new Map(rows.map(row => [`${seriesKey(row)}|${row.date}`, row]));
  const latest = new Map(rows.filter(row => row.date === latestDate).map(row => [seriesKey(row), row]));
  const prices: FoodMarketPrice[] = [...latest.values()].map(row => {
    const date = new Date(Date.parse(row.date) - 7 * DAY).toISOString().slice(0, 10);
    const previous = source.contextOnly ? undefined : history.get(`${seriesKey(row)}|${date}`);
    return {
      ...row, origin: row.origin ?? '', wowAvailable: Boolean(previous),
      wowPct: previous ? Math.round((row.price / previous.price - 1) * 10000) / 100 : 0,
      previousDate: previous?.date ?? '', previousPrice: previous?.price ?? 0,
    };
  }).sort((a, b) => a.market.localeCompare(b.market) || a.item.localeCompare(b.item) || a.origin.localeCompare(b.origin));
  const contexts: FoodSecurityContext[] = (Array.isArray(snapshot.contexts) ? snapshot.contexts : []).filter(context => context
    && typeof context.country === 'string' && typeof context.countryCode === 'string' && typeof context.title === 'string')
    .map(context => {
      const referenceDate = validDate(context.referenceDate, now) ? context.referenceDate : '';
      const contextFetch = typeof context.fetchedAt === 'string' ? context.fetchedAt : fetchedAt;
      const stale = context.fetchFailed || fetchIsStale(contextFetch, source.maxFetchAgeDays, now)
        || now - Date.parse(referenceDate) > source.maxContentAgeDays * DAY;
      return {
        countryCode: context.countryCode, country: context.country, referenceDate,
        title: context.title, url: publisherUrl(context.url, source), fetchedAt: contextFetch,
        status: !referenceDate ? 'unavailable' : stale ? 'stale' : 'current',
      };
    });
  const latestReportDate = [latestDate, ...contexts.map(context => context.referenceDate)].filter(Boolean).sort().slice(-1)[0] ?? '';
  const stale = fetchIsStale(fetchedAt, source.maxFetchAgeDays, now)
    || now - Date.parse(latestReportDate) > source.maxContentAgeDays * DAY;
  const hasData = prices.length > 0 || contexts.some(context => context.referenceDate);
  const partial = contexts.some(context => context.status !== 'current');
  return {
    id: source.id, name: source.name, country: source.country, countryCode: source.countryCode,
    url: publisherUrl(snapshot.reportUrl, source), cadence: source.cadence, contextOnly: source.contextOnly,
    fetchedAt, latestReportDate, status: !hasData ? 'unavailable' : stale ? 'stale' : partial ? 'partial' : 'current', prices, contexts,
    attribution: 'attribution' in source && typeof source.attribution === 'string' ? source.attribution : '',
  };
}
