/**
 * RPC: listYouTubeVideos
 *
 * Fetches videos from YouTube Data API v3.
 * Free tier: 10,000 units/day (search = 100 units -> ~100 searches/day).
 * Returns empty array on any failure (graceful degradation).
 */

import { sanitizeTextContent } from '../../../../src/utils/validation';
import type {
  ListYouTubeVideosRequest,
  SocialFeedResponse,
  SocialPost,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/social/v1/service_server';

const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3/search';

export async function listYouTubeVideos(
  _ctxOrReq: ServerContext | ListYouTubeVideosRequest,
  req?: ListYouTubeVideosRequest,
): Promise<SocialFeedResponse> {
  const request = req ?? _ctxOrReq as ListYouTubeVideosRequest;

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return { posts: [], count: 0, status: 'error', errorMessage: 'YouTube API key not configured' };
  }

  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    key: apiKey,
    q: request.query || 'OSINT OR geopolitics OR military',
    maxResults: String(Math.min(request.limit || 10, 50)),
    order: 'date',
    relevanceLanguage: 'en',
  });
  if (request.channelId) params.set('channelId', request.channelId);

  try {
    const res = await fetch(`${YOUTUBE_API}?${params}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      return { posts: [], count: 0, status: 'error', errorMessage: `YouTube API error: ${res.status}` };
    }

    const data = await res.json() as any;
    const posts: SocialPost[] = (data.items ?? []).map((item: any): SocialPost => ({
      id: `youtube-${item.id.videoId}`,
      platform: 'youtube',
      author: item.snippet.channelTitle ?? '',
      content: sanitizeTextContent(item.snippet.title ?? '', 500),
      url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
      timestamp: new Date(item.snippet.publishedAt).getTime(),
      mediaUrl: item.snippet.thumbnails?.medium?.url ?? '',
      engagement: 0, // Search API does not return view counts
      latitude: 0,
      longitude: 0,
      subreddit: '',
      hashtags: '',
    }));

    return { posts, count: posts.length, status: 'ok', errorMessage: '' };
  } catch (err) {
    return { posts: [], count: 0, status: 'error', errorMessage: `YouTube fetch failed: ${(err as Error).message}` };
  }
}
