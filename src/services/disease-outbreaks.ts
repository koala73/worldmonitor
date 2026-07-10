import { getRpcBaseUrl } from '@/services/rpc-client';
import type { ListDiseaseOutbreaksResponse, DiseaseOutbreakItem } from '@/generated/client/worldmonitor/health/v1/service_client';
import { getHydratedData } from '@/services/bootstrap';
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

export async function fetchDiseaseOutbreaks(): Promise<ListDiseaseOutbreaksResponse> {
  const hydrated = getHydratedData('diseaseOutbreaks') as ListDiseaseOutbreaksResponse | undefined;
  if (hydrated?.outbreaks?.length) return hydrated;

  try {
    return await client.listDiseaseOutbreaks({});
  } catch {
    return emptyOutbreaks;
  }
}
