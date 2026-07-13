import type { ListGlobalTendersRequest, ListGlobalTendersResponse } from '@/generated/client/worldmonitor/economic/v1/service_client';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { premiumFetch } from '@/services/premium-fetch';
import { EconomicServiceClient } from '@/services/generated-rpc-clients';
import { createCircuitBreaker } from '@/utils';

const client = new EconomicServiceClient(getRpcBaseUrl(), { fetch: premiumFetch });
const tenderBreaker = createCircuitBreaker<ListGlobalTendersResponse>({ name: 'Global Tenders', cacheTtlMs: 10 * 60 * 1000, persistCache: true });

const EMPTY_TENDERS: ListGlobalTendersResponse = {
  tenders: [], nextCursor: '', fetchedAt: '', dataAvailable: false, availability: 'unavailable', sourceStatuses: [], total: 0, appliedFilters: [], countryCoverage: 'unknown',
};

export type GlobalTenderFilters = Partial<Pick<ListGlobalTendersRequest,
  'country' | 'countries' | 'region' | 'source' | 'status' | 'deadlineFrom' | 'deadlineTo' | 'minValue' | 'maxValue' | 'currency' | 'category' | 'query' | 'pageSize' | 'cursor' | 'sort'>>;

export async function fetchGlobalTenders(filters: GlobalTenderFilters = {}): Promise<ListGlobalTendersResponse> {
  const request: ListGlobalTendersRequest = {
    country: '', countries: [], region: '', source: '', status: '', deadlineFrom: '', deadlineTo: '', minValue: 0, maxValue: 0,
    currency: '', category: '', query: '', pageSize: 25, cursor: '', sort: 'closing_soon', ...filters,
  };
  return tenderBreaker.execute(
    () => client.listGlobalTenders(request, { signal: AbortSignal.timeout(20_000) }),
    EMPTY_TENDERS,
    { shouldCache: (response) => response.dataAvailable || response.availability === 'empty' },
  );
}
