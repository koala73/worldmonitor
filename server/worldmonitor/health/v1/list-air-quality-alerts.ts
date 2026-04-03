import type {
  AirQualityAlert,
  HealthServiceHandler,
  ListAirQualityAlertsRequest,
  ListAirQualityAlertsResponse,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/health/v1/service_server';

import {
  normalizeAirQualityFetchedAt,
  normalizeAirQualityStations,
} from '../../../_shared/air-quality-stations';
import { HEALTH_AIR_QUALITY_KEY } from '../../../_shared/cache-keys';
import { getCachedJson } from '../../../_shared/redis';

export const listAirQualityAlerts: HealthServiceHandler['listAirQualityAlerts'] = async (
  _ctx: ServerContext,
  _req: ListAirQualityAlertsRequest,
): Promise<ListAirQualityAlertsResponse> => {
  const payload = (await getCachedJson(HEALTH_AIR_QUALITY_KEY, true)) as Record<string, unknown> | null;
  const sourceStations = payload?.stations ?? payload?.alerts;
  const alerts = normalizeAirQualityStations(sourceStations) as AirQualityAlert[];
  return {
    alerts,
    fetchedAt: normalizeAirQualityFetchedAt(payload),
  };
};
