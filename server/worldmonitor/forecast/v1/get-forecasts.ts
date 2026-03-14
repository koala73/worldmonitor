import type {
  Forecast,
  ForecastServiceHandler,
  ServerContext,
  GetForecastsRequest,
  GetForecastsResponse,
} from '../../../../src/generated/server/worldmonitor/forecast/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const REDIS_KEY = 'forecast:predictions:v1';

export const getForecasts: ForecastServiceHandler['getForecasts'] = async (
  _ctx: ServerContext,
  req: GetForecastsRequest,
): Promise<GetForecastsResponse> => {
  try {
    const data = await getCachedJson(REDIS_KEY) as { predictions: Forecast[]; generatedAt: number } | null;
    if (!data?.predictions) return { forecasts: [], generatedAt: 0 };

    let forecasts = data.predictions;
    if (req.domain) forecasts = forecasts.filter(f => f.domain === req.domain);
    if (req.region) forecasts = forecasts.filter(f => f.region.toLowerCase().includes(req.region.toLowerCase()));

    return { forecasts, generatedAt: data.generatedAt || 0 };
  } catch {
    return { forecasts: [], generatedAt: 0 };
  }
};
