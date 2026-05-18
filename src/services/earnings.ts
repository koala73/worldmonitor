import { MarketServiceClient, type EarningsEntry } from '@/generated/client/worldmonitor/market/v1/service_client';
import { getRpcBaseUrl } from '@/services/rpc-client';

export interface EarningsReport {
  symbol: string;
  company: string;
  date: string;
  hour: string;
  epsEstimate: number | null;
  revenueEstimate: number | null;
  epsActual: number | null;
  revenueActual: number | null;
  hasActuals: boolean;
  surpriseDirection: string;
}

export interface EarningsFetchResult {
  reports: EarningsReport[];
  skipReason?: string;
}

let marketClient: MarketServiceClient | null = null;

function getMarketClient(): MarketServiceClient {
  if (!marketClient) {
    marketClient = new MarketServiceClient(getRpcBaseUrl(), {
      fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
    });
  }
  return marketClient;
}

function toLocalIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function shiftIsoDate(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00`);
  date.setDate(date.getDate() + days);
  return toLocalIsoDate(date);
}

function normalizeNumber(value: number, allowZero = false): number | null {
  if (!Number.isFinite(value)) return null;
  if (!allowZero && value === 0) return null;
  return value;
}

function normalizeReport(entry: EarningsEntry): EarningsReport {
  return {
    symbol: entry.symbol ?? '',
    company: entry.company ?? entry.symbol ?? '',
    date: entry.date ?? '',
    hour: entry.hour ?? '',
    epsEstimate: normalizeNumber(entry.epsEstimate),
    revenueEstimate: normalizeNumber(entry.revenueEstimate),
    epsActual: entry.hasActuals ? normalizeNumber(entry.epsActual, true) : null,
    revenueActual: entry.hasActuals ? normalizeNumber(entry.revenueActual, true) : null,
    hasActuals: Boolean(entry.hasActuals),
    surpriseDirection: entry.surpriseDirection ?? '',
  };
}

function filterReports(entries: EarningsEntry[], timeframe: 'upcoming' | 'recent'): EarningsReport[] {
  const today = toLocalIsoDate(new Date());
  const upcomingCutoff = shiftIsoDate(today, 14);
  const recentFloor = shiftIsoDate(today, -7);

  const reports = entries
    .map(normalizeReport)
    .filter((report) => {
      if (!report.date) return false;
      if (timeframe === 'upcoming') {
        return report.date >= today && report.date <= upcomingCutoff && !report.hasActuals;
      }
      return report.date >= recentFloor && report.date <= today && (report.hasActuals || report.date < today);
    });

  reports.sort((left, right) => {
    const primary = timeframe === 'upcoming'
      ? left.date.localeCompare(right.date)
      : right.date.localeCompare(left.date);
    if (primary !== 0) return primary;
    return left.symbol.localeCompare(right.symbol);
  });

  return reports.slice(0, 12);
}

export async function fetchEarningsReports(timeframe: 'upcoming' | 'recent'): Promise<EarningsFetchResult> {
  const useMock = import.meta.env.DEV;

  try {
    const client = getMarketClient();
    const response = await client.listEarningsCalendar({ fromDate: '', toDate: '' });
    const reports = filterReports(response.earnings ?? [], timeframe);

    if (useMock && reports.length === 0) {
      const { getMockEarnings } = await import('./__mocks__/earnings');
      return getMockEarnings(timeframe);
    }

    return {
      reports,
      skipReason: response.unavailable ? 'Earnings feed unavailable.' : undefined,
    };
  } catch (err) {
    console.error(`[earnings] Failed to fetch ${timeframe} reports`, err);
    if (useMock) {
      const { getMockEarnings } = await import('./__mocks__/earnings');
      return getMockEarnings(timeframe);
    }
    return { reports: [], skipReason: err instanceof Error ? err.message : String(err) };
  }
}
