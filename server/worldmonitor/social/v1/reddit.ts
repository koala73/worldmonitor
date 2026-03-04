/**
 * RPC: listRedditPosts
 *
 * Fetches posts from Reddit subreddits using OAuth2 client credentials flow.
 * Returns empty array on any failure (graceful degradation).
 */

import { validateStringParam, SUBREDDIT_PATTERN, sanitizeTextContent } from '../../../../src/utils/validation';
import type {
  ListRedditPostsRequest,
  SocialFeedResponse,
  SocialPost,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/social/v1/service_server';

const REDDIT_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const REDDIT_API = 'https://oauth.reddit.com';
const DEFAULT_SUBREDDITS = ['OSINT', 'geopolitics', 'CombatFootage', 'worldnews'];

let cachedToken: { token: string; expiresAt: number } | null = null;

/** Exported for testing: resets the cached OAuth2 token. */
export function _resetTokenCache(): void {
  cachedToken = null;
}

async function getOAuthToken(): Promise<string | null> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;

  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const res = await fetch(REDDIT_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) return null;
  const data = await res.json() as { access_token: string; expires_in: number };
  if (!data.access_token) return null;
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return cachedToken.token;
}

export async function listRedditPosts(
  _ctxOrReq: ServerContext | ListRedditPostsRequest,
  req?: ListRedditPostsRequest,
): Promise<SocialFeedResponse> {
  // Support both (ctx, req) and direct (req) calling patterns
  const request = req ?? _ctxOrReq as ListRedditPostsRequest;

  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return { posts: [], count: 0, status: 'error', errorMessage: 'Reddit OAuth2 credentials not configured' };
  }

  const token = await getOAuthToken();
  if (!token) {
    return { posts: [], count: 0, status: 'error', errorMessage: 'Failed to obtain Reddit OAuth2 token' };
  }

  const subs = request.subreddits && request.subreddits.length > 0
    ? request.subreddits.map(s => validateStringParam(s, 'subreddit', 21, SUBREDDIT_PATTERN))
    : DEFAULT_SUBREDDITS;
  const limit = Math.min(request.limit || 25, 100);
  const sort = request.sort || 'hot';

  const results = await Promise.allSettled(
    subs.map(async (sub) => {
      const url = `${REDDIT_API}/r/${sub}/${sort}?limit=${limit}&raw_json=1`;
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'OmniSentinel/1.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return [];
      const data = await res.json() as any;
      return (data.data?.children ?? []).map((child: any): SocialPost => ({
        id: `reddit-${child.data.id}`,
        platform: 'reddit',
        author: `u/${child.data.author}`,
        content: sanitizeTextContent(`[r/${sub}] ${child.data.title}`, 500),
        url: `https://reddit.com${child.data.permalink}`,
        timestamp: (child.data.created_utc ?? 0) * 1000,
        mediaUrl: '',
        engagement: child.data.score ?? 0,
        latitude: 0,
        longitude: 0,
        subreddit: sub,
        hashtags: sub,
      }));
    }),
  );

  const posts = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => (r as PromiseFulfilledResult<SocialPost[]>).value)
    .sort((a, b) => b.engagement - a.engagement);

  return { posts, count: posts.length, status: 'ok', errorMessage: '' };
}
