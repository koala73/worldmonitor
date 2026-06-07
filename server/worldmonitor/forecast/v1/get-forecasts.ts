import type {
  Forecast,
  ForecastServiceHandler,
  ServerContext,
  GetForecastsRequest,
  GetForecastsResponse,
} from '../../../../src/generated/server/worldmonitor/forecast/v1/service_server';
import { getRawJson } from '../../../_shared/redis';

const REDIS_KEY = 'forecast:predictions:v2';

export const getForecasts: ForecastServiceHandler['getForecasts'] = async (
  _ctx: ServerContext,
  req: GetForecastsRequest,
): Promise<GetForecastsResponse> => {
  try {
    const data = await getRawJson(REDIS_KEY) as { predictions: Forecast[]; generatedAt: number } | null;
    if (!data?.predictions) {
      return { forecasts: [], generatedAt: 0, degraded: false, stale: false, error: '' };
    }

    let forecasts = data.predictions;
    if (req.domain) forecasts = forecasts.filter(f => f.domain === req.domain);
    if (req.region) forecasts = forecasts.filter(f => f.region.toLowerCase().includes(req.region.toLowerCase()));

    return { forecasts, generatedAt: data.generatedAt || 0, degraded: false, stale: false, error: '' };
  } catch (err) {
    console.error('[forecast] getRawJson failed:', err instanceof Error ? err.message : String(err));
    return {
      forecasts: [],
      generatedAt: 0,
      degraded: true,
      stale: false,
      error: 'forecast_backend_unavailable',
    };
  }
};
