/**
 * RPC: listBlueskyPosts
 *
 * Fetches posts from Bluesky via the public AT Protocol API (no auth required).
 * Limit capped to 25 (AT Protocol maximum).
 * Returns empty array on any failure (graceful degradation).
 */

import { sanitizeTextContent } from '../../../../src/utils/validation';
import type {
  ListBlueskyPostsRequest,
  SocialFeedResponse,
  SocialPost,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/social/v1/service_server';

const BLUESKY_API = 'https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts';

export async function listBlueskyPosts(
  _ctxOrReq: ServerContext | ListBlueskyPostsRequest,
  req?: ListBlueskyPostsRequest,
): Promise<SocialFeedResponse> {
  const request = req ?? _ctxOrReq as ListBlueskyPostsRequest;

  const query = request.query || 'OSINT OR geopolitics OR military';
  const limit = Math.min(request.limit || 25, 25); // AT Protocol max is 25

  try {
    const params = new URLSearchParams({
      q: query,
      limit: String(limit),
      sort: 'latest',
    });

    const res = await fetch(`${BLUESKY_API}?${params}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      return { posts: [], count: 0, status: 'error', errorMessage: `Bluesky API error: ${res.status}` };
    }

    const data = await res.json() as any;
    const posts: SocialPost[] = (data.posts ?? []).map((post: any): SocialPost => {
      const handle = post.author?.handle ?? '';
      const rkey = post.uri?.split('/').pop() ?? '';

      return {
        id: `bluesky-${rkey || post.cid}`,
        platform: 'bluesky',
        author: `@${handle}`,
        content: sanitizeTextContent(post.record?.text ?? '', 500),
        url: `https://bsky.app/profile/${handle}/post/${rkey}`,
        timestamp: post.record?.createdAt ? new Date(post.record.createdAt).getTime() : Date.now(),
        mediaUrl: '',
        engagement: (post.likeCount ?? 0) + (post.repostCount ?? 0),
        latitude: 0,
        longitude: 0,
        subreddit: '',
        hashtags: '',
      };
    });

    return { posts, count: posts.length, status: 'ok', errorMessage: '' };
  } catch (err) {
    return { posts: [], count: 0, status: 'error', errorMessage: `Bluesky fetch failed: ${(err as Error).message}` };
  }
}
