import {
  type ChinaActivityNowcastResponse,
} from '../../shared/china-activity-nowcast';
import { EconomicServiceClient } from '@/services/generated-rpc-clients';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { createCircuitBreaker } from '@/utils';
import {
  CHINA_ACTIVITY_NOWCAST_BREAKER_CACHE_POLICY,
  fetchChinaActivityNowcast,
} from '@/services/economic/china-activity-nowcast';

export {
  CHINA_ACTIVITY_NOWCAST_BREAKER_CACHE_POLICY,
  fetchChinaActivityNowcast,
  parseChinaActivityNowcastResponse,
} from '@/services/economic/china-activity-nowcast';

const client = new EconomicServiceClient(getRpcBaseUrl(), {
  fetch: (...args) => globalThis.fetch(...args),
});
const breaker = createCircuitBreaker<ChinaActivityNowcastResponse>({
  name: 'China Activity Nowcast',
  ...CHINA_ACTIVITY_NOWCAST_BREAKER_CACHE_POLICY,
});

export function getChinaActivityNowcastData(): Promise<ChinaActivityNowcastResponse> {
  return fetchChinaActivityNowcast({
    now: () => new Date(),
    getResponse: () => client.getChinaActivityNowcast({}),
    execute: (operation, fallback) => breaker.execute(operation, fallback),
  });
}
