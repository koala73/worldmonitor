import { getRpcBaseUrl } from '@/services/rpc-client';
import {
  IntelligenceServiceClient,
  type GetSocialVelocityResponse,
  type SocialVelocityPost,
} from '@/generated/client/worldmonitor/intelligence/v1/service_client';
import { getHydratedData } from '@/services/bootstrap';

export type { GetSocialVelocityResponse, SocialVelocityPost };

const client = new IntelligenceServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });

const emptyVelocity: GetSocialVelocityResponse = { posts: [], fetchedAt: 0 };

export async function fetchSocialVelocity(): Promise<GetSocialVelocityResponse> {
  const hydrated = getHydratedData('socialVelocity') as GetSocialVelocityResponse | undefined;
  if (hydrated?.posts?.length) return hydrated;

  try {
    return await client.getSocialVelocity({});
  } catch {
    return emptyVelocity;
  }
}
