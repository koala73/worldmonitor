/**
 * RPC: listVKPosts
 *
 * Fetches wall posts from VK public groups via VK API v5.199.
 * Uses VK_SERVICE_TOKEN (server-side service token).
 * Returns empty array on any failure (graceful degradation).
 */

import { sanitizeTextContent } from '../../../../src/utils/validation';
import type {
  ListVKPostsRequest,
  SocialFeedResponse,
  SocialPost,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/social/v1/service_server';

const VK_API = 'https://api.vk.com/method/wall.get';
const VK_API_VERSION = '5.199';

// Default military/geopolitics-related VK public groups
const DEFAULT_OWNER_IDS = [
  '-57424472',   // RIA Novosti
  '-15755094',   // RT Russian
  '-76982440',   // Военное обозрение
];

export async function listVKPosts(
  _ctxOrReq: ServerContext | ListVKPostsRequest,
  req?: ListVKPostsRequest,
): Promise<SocialFeedResponse> {
  const request = req ?? _ctxOrReq as ListVKPostsRequest;

  const serviceToken = process.env.VK_SERVICE_TOKEN;
  if (!serviceToken) {
    return { posts: [], count: 0, status: 'error', errorMessage: 'VK service token not configured' };
  }

  const ownerIds = request.ownerIds && request.ownerIds.length > 0
    ? request.ownerIds
    : DEFAULT_OWNER_IDS;
  const limit = Math.min(request.limit || 25, 100);

  const results = await Promise.allSettled(
    ownerIds.map(async (ownerId) => {
      const params = new URLSearchParams({
        owner_id: ownerId,
        count: String(limit),
        v: VK_API_VERSION,
        access_token: serviceToken,
      });

      const res = await fetch(`${VK_API}?${params}`, {
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) return [];

      const data = await res.json() as any;
      if (data.error) return []; // VK API returns errors in JSON body

      return (data.response?.items ?? []).map((item: any): SocialPost => ({
        id: `vk-${ownerId}_${item.id}`,
        platform: 'vk',
        author: `vk:${ownerId}`,
        content: sanitizeTextContent(item.text ?? '', 500),
        url: `https://vk.com/wall${ownerId}_${item.id}`,
        timestamp: (item.date ?? 0) * 1000,
        mediaUrl: '',
        engagement: (item.likes?.count ?? 0) + (item.reposts?.count ?? 0),
        latitude: 0,
        longitude: 0,
        subreddit: '',
        hashtags: '',
      }));
    }),
  );

  const posts = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => (r as PromiseFulfilledResult<SocialPost[]>).value)
    .sort((a, b) => b.timestamp - a.timestamp);

  return { posts, count: posts.length, status: 'ok', errorMessage: '' };
}
