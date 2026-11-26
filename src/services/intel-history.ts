import { createLazyClient, getRpcBaseUrl } from '@/services/rpc-client';
import { IntelligenceServiceClient } from '@/services/generated-rpc-clients';
import { premiumFetch } from '@/services/premium-fetch';
import type {
  GetIntelTimelineResponse,
  GetSimilarEventsResponse,
  IntelHistoryRecord,
} from '@/generated/client/worldmonitor/intelligence/v1/service_client';

export type {
  IntelHistoryRecord,
  GetIntelTimelineResponse,
  GetSimilarEventsResponse,
};

export type IntelHistoryDomain = '' | 'conflict' | 'military' | 'energy';

const client = createLazyClient(() => new IntelligenceServiceClient(getRpcBaseUrl(), {
  fetch: premiumFetch,
}));

export function fetchIntelTimeline(
  params: {
    country: string;
    domain?: IntelHistoryDomain;
    limit?: number;
    cursor?: string;
  },
  signal?: AbortSignal,
): Promise<GetIntelTimelineResponse> {
  return client().getIntelTimeline(
    {
      country: params.country.trim().toUpperCase(),
      domain: params.domain ?? '',
      from: 0,
      to: 0,
      limit: params.limit ?? 20,
      cursor: params.cursor ?? '',
    },
    signal ? { signal } : undefined,
  );
}

export function fetchSimilarEvents(
  params: {
    situation: string;
    country?: string;
    domain?: IntelHistoryDomain;
    limit?: number;
  },
  signal?: AbortSignal,
): Promise<GetSimilarEventsResponse> {
  return client().getSimilarEvents(
    {
      situation: params.situation.trim(),
      country: (params.country ?? '').trim().toUpperCase(),
      domain: params.domain ?? '',
      limit: params.limit ?? 6,
    },
    signal ? { signal } : undefined,
  );
}
