import { createLazyClient, getRpcBaseUrl } from '@/services/rpc-client';
import type { GetSocialVelocityResponse, SocialVelocityPost } from '@/generated/client/worldmonitor/intelligence/v1/service_client';
import { getHydratedData } from '@/services/bootstrap';
import { IntelligenceServiceClient } from '@/services/generated-rpc-clients';

export type { GetSocialVelocityResponse, SocialVelocityPost };

const getClient = createLazyClient(() => new IntelligenceServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) }));

const emptyVelocity: GetSocialVelocityResponse = { posts: [], fetchedAt: 0 };

export async function fetchSocialVelocity(): Promise<GetSocialVelocityResponse> {
  const hydrated = getHydratedData('socialVelocity') as GetSocialVelocityResponse | undefined;
  if (hydrated?.posts?.length) return hydrated;

  try {
    return await getClient().getSocialVelocity({});
  } catch {
    return emptyVelocity;
  }
}
