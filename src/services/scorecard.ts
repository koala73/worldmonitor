import type {
  GetBlocScorecardResponse,
  GetFiveFactorScorecardResponse,
  ListFiveFactorScorecardsResponse,
} from '@/generated/client/worldmonitor/scorecard/v1/service_client';
import { ScorecardServiceClient } from '@/services/generated-rpc-clients';
import { premiumFetch } from '@/services/premium-fetch';
import { getRpcBaseUrl } from '@/services/rpc-client';

export type FiveFactorScorecardResponse = GetFiveFactorScorecardResponse;
export type FiveFactorScorecardListResponse = ListFiveFactorScorecardsResponse;
export type FiveFactorBlocResponse = GetBlocScorecardResponse;

let client: InstanceType<typeof ScorecardServiceClient> | null = null;

function getClient(): InstanceType<typeof ScorecardServiceClient> {
  client ||= new ScorecardServiceClient(getRpcBaseUrl(), { fetch: premiumFetch });
  return client;
}

export async function getFiveFactorScorecard(countryCode: string, signal?: AbortSignal): Promise<GetFiveFactorScorecardResponse> {
  return getClient().getFiveFactorScorecard(
    { countryCode: countryCode.trim().toUpperCase() },
    signal ? { signal } : undefined,
  );
}

export async function listFiveFactorScorecards(signal?: AbortSignal): Promise<ListFiveFactorScorecardsResponse> {
  return getClient().listFiveFactorScorecards({}, signal ? { signal } : undefined);
}

export async function getFiveFactorBlocScorecard(
  selection: { preset: string; members?: never } | { preset?: never; members: string[] },
  signal?: AbortSignal,
): Promise<GetBlocScorecardResponse> {
  return getClient().getBlocScorecard(
    {
      preset: selection.preset || '',
      members: selection.members || [],
    },
    signal ? { signal } : undefined,
  );
}
