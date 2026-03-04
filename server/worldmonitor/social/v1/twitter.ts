/**
 * RPC: listTweets
 *
 * Fetches tweets using the adapter pattern (TwitterAPI.io → SocialData → Official X API).
 * Returns empty array on any failure (graceful degradation).
 */

import { validateStringParam, TWITTER_HANDLE_PATTERN, sanitizeTextContent } from '../../../../src/utils/validation';
import { createTwitterAdapter } from './twitter-adapters';
import type {
  ListTweetsRequest,
  SocialFeedResponse,
  SocialPost,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/social/v1/service_server';

export async function listTweets(
  _ctxOrReq: ServerContext | ListTweetsRequest,
  req?: ListTweetsRequest,
): Promise<SocialFeedResponse> {
  const request = req ?? _ctxOrReq as ListTweetsRequest;

  const adapter = createTwitterAdapter();
  if (!adapter) {
    return { posts: [], count: 0, status: 'error', errorMessage: 'Twitter API credentials not configured' };
  }

  const limit = Math.min(request.limit || 25, 100);

  try {
    let rawTweets;
    if (request.username) {
      const username = validateStringParam(request.username, 'username', 15, TWITTER_HANDLE_PATTERN);
      rawTweets = await adapter.getUserTweets(username, limit);
    } else {
      const query = request.query || 'OSINT OR geopolitics OR military';
      rawTweets = await adapter.searchTweets(query, limit);
    }

    const posts: SocialPost[] = rawTweets.map(tweet => ({
      id: `twitter-${tweet.id}`,
      platform: 'twitter',
      author: `@${tweet.author}`,
      content: sanitizeTextContent(tweet.text, 500),
      url: tweet.url,
      timestamp: tweet.createdAt ? new Date(tweet.createdAt).getTime() : Date.now(),
      mediaUrl: '',
      engagement: tweet.likeCount + tweet.retweetCount,
      latitude: 0,
      longitude: 0,
      subreddit: '',
      hashtags: '',
    }));

    return { posts, count: posts.length, status: 'ok', errorMessage: '' };
  } catch (err) {
    return { posts: [], count: 0, status: 'error', errorMessage: `Twitter fetch failed: ${(err as Error).message}` };
  }
}
