import { getHydratedData } from '@/services/bootstrap';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { createCircuitBreaker } from '@/utils';
import {
  IntelligenceServiceClient,
  type ListCrossSourceSignalsResponse,
} from '@/generated/client/worldmonitor/intelligence/v1/service_client';

const client = new IntelligenceServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });
const breaker = createCircuitBreaker<ListCrossSourceSignalsResponse>({ name: 'Cross-Source Signals', cacheTtlMs: 15 * 60 * 1000, persistCache: true });

export type { ListCrossSourceSignalsResponse };

const EMPTY: ListCrossSourceSignalsResponse = { signals: [], evaluatedAt: 0, compositeCount: 0 };

export async function fetchCrossSourceSignals(): Promise<ListCrossSourceSignalsResponse> {
  const hydrated = getHydratedData('crossSourceSignals') as ListCrossSourceSignalsResponse | undefined;
  if (hydrated?.signals?.length) return hydrated;
  return breaker.execute(async () => {
    return await client.listCrossSourceSignals({}, { signal: AbortSignal.timeout(15_000) });
  }, EMPTY);
}
