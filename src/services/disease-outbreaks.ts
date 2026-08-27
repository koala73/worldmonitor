import { getRpcBaseUrl } from '@/services/rpc-client';
import type { ListDiseaseOutbreaksResponse, DiseaseOutbreakItem } from '@/generated/client/worldmonitor/health/v1/service_client';
import { createHydrationHandoff } from '@/services/hydration-handoff';
import { HealthServiceClient } from '@/services/generated-rpc-clients';

export type { ListDiseaseOutbreaksResponse, DiseaseOutbreakItem };

const client = new HealthServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });

// Fallback methodology version matches the server-side transitional fallback
// in server/worldmonitor/health/v1/list-disease-outbreaks.ts so empty/offline
// states present a consistent contract to UI consumers.
const emptyOutbreaks: ListDiseaseOutbreaksResponse = {
  outbreaks: [],
  fetchedAt: 0,
  alertLevelMethodologyVersion: 'v1',
};

// No breaker or TTL cache owns this loader's results, so the accepted
// bootstrap value is preserved in a service-owned bounded handoff (#7048).
const hydrationHandoff = createHydrationHandoff<ListDiseaseOutbreaksResponse>(
  'diseaseOutbreaks',
  (value) => {
    const payload = value as ListDiseaseOutbreaksResponse;
    return payload?.outbreaks?.length ? payload : null;
  },
);

export async function fetchDiseaseOutbreaks(): Promise<ListDiseaseOutbreaksResponse> {
  return hydrationHandoff.getOrLoad(
    () => client.listDiseaseOutbreaks({}),
    emptyOutbreaks,
  );
}
