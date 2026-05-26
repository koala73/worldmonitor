import type {
  ServerContext,
  GetEconomicCalendarRequest,
  GetEconomicCalendarResponse,
  EconomicEvent,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'economic:econ-calendar:v1';

function buildFallbackResult(): GetEconomicCalendarResponse {
  return {
    events: [],
    fromDate: '',
    toDate: '',
    total: 0,
    unavailable: true,
  };
}

export async function getEconomicCalendar(
  _ctx: ServerContext,
  _req: GetEconomicCalendarRequest,
): Promise<GetEconomicCalendarResponse> {
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as GetEconomicCalendarResponse | null;
    if (result && !result.unavailable && Array.isArray(result.events) && result.events.length > 0) {
      return {
        events: result.events as EconomicEvent[],
        fromDate: result.fromDate ?? '',
        toDate: result.toDate ?? '',
        total: result.total ?? result.events.length,
        unavailable: false,
      };
    }
    return buildFallbackResult();
  } catch {
    return buildFallbackResult();
  }
}
