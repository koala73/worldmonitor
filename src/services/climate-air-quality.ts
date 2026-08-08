import { getRpcBaseUrl } from '@/services/rpc-client';
import type { AirQualityStation, ListAirQualityDataResponse } from '@/generated/client/worldmonitor/climate/v1/service_client';
import { ClimateServiceClient } from '@/services/generated-rpc-clients';

export type { AirQualityStation, ListAirQualityDataResponse };

const client = new ClimateServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });
const emptyClimateAirQuality: ListAirQualityDataResponse = { stations: [], fetchedAt: 0 };

export async function fetchClimateAirQuality(): Promise<ListAirQualityDataResponse> {
  try {
    return await client.listAirQualityData({});
  } catch {
    return emptyClimateAirQuality;
  }
}
