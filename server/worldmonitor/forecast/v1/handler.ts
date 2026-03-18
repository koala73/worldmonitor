import type { ForecastServiceHandler } from '../../../../src/generated/server/worldmonitor/forecast/v1/service_server';
import { getForecasts } from './get-forecasts';

export const forecastHandler: ForecastServiceHandler = { getForecasts };
