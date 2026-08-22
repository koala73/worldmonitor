import type {
  ServerContext,
  GetEconomicCalendarRequest,
  GetEconomicCalendarResponse,
  EconomicEvent,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';
import { filterCalendarRange, resolveCalendarRange } from '../../../_shared/calendar-range';
import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'economic:econ-calendar:v1';

function buildFallbackResult(req?: GetEconomicCalendarRequest): GetEconomicCalendarResponse {
  return {
    events: [],
    fromDate: req?.fromDate ?? '',
    toDate: req?.toDate ?? '',
    total: 0,
    unavailable: true,
  };
}

export function buildEconomicCalendarResponse(
  result: GetEconomicCalendarResponse,
  req: GetEconomicCalendarRequest,
): GetEconomicCalendarResponse {
  const range = resolveCalendarRange(req.fromDate, req.toDate, result.fromDate, result.toDate);
  const events = filterCalendarRange(result.events ?? [], range, (event) => event.date);
  return {
    events: events as EconomicEvent[],
    ...range,
    total: events.length,
    unavailable: false,
  };
}

export async function getEconomicCalendar(
  _ctx: ServerContext,
  req: GetEconomicCalendarRequest,
): Promise<GetEconomicCalendarResponse> {
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as GetEconomicCalendarResponse | null;
    if (result && !result.unavailable && Array.isArray(result.events)) {
      return buildEconomicCalendarResponse(result, req);
    }
    return buildFallbackResult(req);
  } catch {
    return buildFallbackResult(req);
  }
}
