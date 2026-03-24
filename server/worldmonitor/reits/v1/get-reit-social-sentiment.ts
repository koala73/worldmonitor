/**
 * RPC: GetReitSocialSentiment -- reads social sentiment data from Redis.
 * Excludes mortgage REITs (no physical properties = no social data).
 *
 * Data flow:
 *   seed-reit-social.mjs → Redis reits:social:v1 → this handler
 */

import type {
  ServerContext,
  GetReitSocialSentimentRequest,
  GetReitSocialSentimentResponse,
  ReitSocial,
} from '../../../../src/generated/server/worldmonitor/reits/v1/service_server';
import { REDIS_KEYS } from './_shared';
import { getCachedJson } from '../../../_shared/redis';

export async function getReitSocialSentiment(
  _ctx: ServerContext,
  req: GetReitSocialSentimentRequest,
): Promise<GetReitSocialSentimentResponse> {
  try {
    const data = await getCachedJson(REDIS_KEYS.social, true) as {
      sentiments: ReitSocial[];
      stale: boolean;
      lastUpdated: string;
      unavailableReason: string;
    } | null;

    if (!data) {
      return {
        sentiments: [],
        stale: true,
        lastUpdated: '',
        unavailableReason: 'Social data not yet available',
      };
    }

    let sentiments = data.sentiments || [];

    // Filter by specific REIT symbol
    if (req.reitSymbol) {
      sentiments = sentiments.filter((s: ReitSocial) => s.reitSymbol === req.reitSymbol);
    }

    return {
      sentiments,
      stale: data.stale || false,
      lastUpdated: data.lastUpdated || '',
      unavailableReason: data.unavailableReason || '',
    };
  } catch {
    return {
      sentiments: [],
      stale: true,
      lastUpdated: '',
      unavailableReason: 'Failed to load social data',
    };
  }
}
