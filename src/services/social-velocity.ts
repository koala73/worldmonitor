import { createLazyClient, getRpcBaseUrl } from '@/services/rpc-client';
import type { GetSocialVelocityResponse, SocialVelocityPost } from '@/generated/client/worldmonitor/intelligence/v1/service_client';
import { createHydrationHandoff } from '@/services/hydration-handoff';
import { IntelligenceServiceClient } from '@/services/generated-rpc-clients';

export type { GetSocialVelocityResponse, SocialVelocityPost };

const getClient = createLazyClient(() => new IntelligenceServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) }));

const emptyVelocity: GetSocialVelocityResponse = { posts: [], fetchedAt: 0 };

// No breaker or TTL cache owns this loader's results, so the accepted
// bootstrap value is preserved in a service-owned bounded handoff (#7048);
// before this, every recurring call after the consume-once read refetched
// the RPC.
const hydrationHandoff = createHydrationHandoff<GetSocialVelocityResponse>(
  'socialVelocity',
  (value) => {
    const payload = value as GetSocialVelocityResponse;
    return payload?.posts?.length ? payload : null;
  },
);

export async function fetchSocialVelocity(): Promise<GetSocialVelocityResponse> {
  return hydrationHandoff.getOrLoad(
    () => getClient().getSocialVelocity({}),
    emptyVelocity,
  );
}
