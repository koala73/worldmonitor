import type { GetNo2ActivityRequest } from '@/generated/client/worldmonitor/economic/v1/service_client';
import { EconomicServiceClient } from '@/services/generated-rpc-clients';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { createCircuitBreaker } from '@/utils';
import { fetchNo2Activity, type No2ActivitySnapshot } from '@/services/economic/no2-activity';

export {
  countryNo2Activity,
  no2ActivityState,
  projectNo2ActivitySnapshot,
  type No2ActivityExclusion,
  type No2ActivityRegionView,
  type No2ActivitySnapshot,
  type No2ActivityState,
} from '@/services/economic/no2-activity';

const client = new EconomicServiceClient(getRpcBaseUrl(), {
  fetch: (...args) => globalThis.fetch(...args),
});
// The route owns freshness; a browser last-good value would hide a fault.
const breaker = createCircuitBreaker<No2ActivitySnapshot | null>({ name: 'NO2 Activity', cacheTtlMs: 0, maxCacheEntries: 0 });

/** Null means the read failed; the caller keeps whatever it last painted. */
export function getNo2ActivityData(request: Partial<GetNo2ActivityRequest> = {}): Promise<No2ActivitySnapshot | null> {
  return breaker.execute(() => fetchNo2Activity(request, client), null);
}
