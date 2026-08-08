import { getRpcBaseUrl } from '@/services/rpc-client';
import type { AirQualityAlert, ListAirQualityAlertsResponse } from '@/generated/client/worldmonitor/health/v1/service_client';
import { HealthServiceClient } from '@/services/generated-rpc-clients';

export type { AirQualityAlert, ListAirQualityAlertsResponse };

const client = new HealthServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });
const emptyAirQualityAlerts: ListAirQualityAlertsResponse = { alerts: [], fetchedAt: 0 };

export async function fetchHealthAirQuality(): Promise<ListAirQualityAlertsResponse> {
  try {
    return await client.listAirQualityAlerts({});
  } catch {
    return emptyAirQualityAlerts;
  }
}
