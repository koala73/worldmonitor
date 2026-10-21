import type {
  IntelligenceServiceHandler,
  ServerContext,
  GetSocialVelocityRequest,
  GetSocialVelocityResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { readRequiredSeed } from '../../../_shared/required-seed';
import { normalizeSocialVelocity } from '../../../../api/_social-velocity.js';

const REDIS_KEY = 'intelligence:social:reddit:v1';
export const getSocialVelocity: IntelligenceServiceHandler['getSocialVelocity'] = async (
  _ctx: ServerContext,
  _req: GetSocialVelocityRequest,
): Promise<GetSocialVelocityResponse> => {
  const data = await readRequiredSeed(REDIS_KEY, value => {
    const payload = value as { posts?: unknown } | null;
    return payload && Array.isArray(payload.posts) ? payload : undefined;
  });
  return normalizeSocialVelocity(data);
};
