import type {
  ServerContext,
  ListEarningsCalendarRequest,
  ListEarningsCalendarResponse,
  EarningsEntry,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'market:earnings-calendar:v1';

export async function listEarningsCalendar(
  _ctx: ServerContext,
  _req: ListEarningsCalendarRequest,
): Promise<ListEarningsCalendarResponse> {
  try {
    const cached = await getCachedJson(SEED_CACHE_KEY, true) as { earnings?: EarningsEntry[]; unavailable?: boolean } | null;
    if (!cached?.earnings?.length) {
      return { earnings: [], fromDate: '', toDate: '', total: 0, unavailable: true };
    }

    const entries: EarningsEntry[] = cached.earnings.map(e => ({
      symbol: e.symbol ?? '',
      company: e.company ?? '',
      date: e.date ?? '',
      hour: e.hour ?? '',
      epsEstimate: e.epsEstimate ?? 0,
      revenueEstimate: e.revenueEstimate ?? 0,
      epsActual: e.epsActual ?? 0,
      revenueActual: e.revenueActual ?? 0,
      hasActuals: e.hasActuals ?? false,
      surpriseDirection: e.surpriseDirection ?? '',
    }));

    const dates = entries.map(e => e.date).filter(Boolean).sort();
    const fromDate = dates[0] ?? '';
    const toDate = dates[dates.length - 1] ?? '';

    return { earnings: entries, fromDate, toDate, total: entries.length, unavailable: false };
  } catch {
    return { earnings: [], fromDate: '', toDate: '', total: 0, unavailable: true };
  }
}
