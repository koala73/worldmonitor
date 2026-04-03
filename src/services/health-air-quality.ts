import { getHydratedData } from '@/services/bootstrap';
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
  const hydrated = getHydratedData('healthAirQuality') as ListAirQualityAlertsResponse | undefined;
  if (hydrated?.alerts?.length) return hydrated;

  try {
    return await client.listAirQualityAlerts({});
  } catch {
    return emptyAirQualityAlerts;
  }
}
