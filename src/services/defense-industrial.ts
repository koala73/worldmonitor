import type {
  GetDefenseIndustrialBaseResponse,
  MilitaryServiceClient,
} from '@/generated/client/worldmonitor/military/v1/service_client';

export async function getCountryDefenseIndustrialBase(
  countryCode: string,
  client: Pick<MilitaryServiceClient, 'getDefenseIndustrialBase'>,
): Promise<GetDefenseIndustrialBaseResponse> {
  return client.getDefenseIndustrialBase({ countryCode: countryCode.trim().toUpperCase() });
}
