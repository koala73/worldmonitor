import { getRpcBaseUrl } from '@/services/rpc-client';
import {
  HealthServiceClient,
  type AirQualityAlert,
  type ListAirQualityAlertsResponse,
} from '@/generated/client/worldmonitor/health/v1/service_client';

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
