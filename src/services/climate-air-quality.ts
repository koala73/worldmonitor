import { getHydratedData } from '@/services/bootstrap';
import { getRpcBaseUrl } from '@/services/rpc-client';
import {
  ClimateServiceClient,
  type AirQualityStation,
  type ListAirQualityDataResponse,
} from '@/generated/client/worldmonitor/climate/v1/service_client';

export type { AirQualityStation, ListAirQualityDataResponse };

const client = new ClimateServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });
const emptyClimateAirQuality: ListAirQualityDataResponse = { stations: [], fetchedAt: 0 };

export async function fetchClimateAirQuality(): Promise<ListAirQualityDataResponse> {
  const hydrated = getHydratedData('climateAirQuality') as ListAirQualityDataResponse | undefined;
  if (hydrated?.stations?.length) return hydrated;

  try {
    return await client.listAirQualityData({});
  } catch {
    return emptyClimateAirQuality;
  }
}
