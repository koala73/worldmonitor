/**
 * RPC: listTikTokPosts
 *
 * Fetches TikTok posts via Apify TikTok Scraper actor.
 * Designed to run on Railway worker (Apify can be slow).
 * Returns empty array on any failure (graceful degradation).
 */

import { sanitizeTextContent } from '../../../../src/utils/validation';
import type {
  ListTikTokPostsRequest,
  SocialFeedResponse,
  SocialPost,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/social/v1/service_server';

const APIFY_API = 'https://api.apify.com/v2';
const TIKTOK_ACTOR_ID = 'clockworks~free-tiktok-scraper';

export async function listTikTokPosts(
  _ctxOrReq: ServerContext | ListTikTokPostsRequest,
  req?: ListTikTokPostsRequest,
): Promise<SocialFeedResponse> {
  const request = req ?? _ctxOrReq as ListTikTokPostsRequest;

  const apifyToken = process.env.TIKTOK_APIFY_TOKEN;
  if (!apifyToken) {
    return { posts: [], count: 0, status: 'error', errorMessage: 'TikTok Apify token not configured' };
  }

  const query = request.query || 'OSINT geopolitics military';
  const limit = Math.min(request.limit || 20, 50);

  try {
    // Start actor run
    const runRes = await fetch(
      `${APIFY_API}/acts/${TIKTOK_ACTOR_ID}/runs?token=${apifyToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          searchQueries: [query],
          resultsPerPage: limit,
          shouldDownloadVideos: false,
        }),
        signal: AbortSignal.timeout(15000),
      },
    );

    if (!runRes.ok) {
      return { posts: [], count: 0, status: 'error', errorMessage: `Apify run failed: ${runRes.status}` };
    }

    const runData = await runRes.json() as any;
    const datasetId = runData.data?.defaultDatasetId;
    if (!datasetId) {
      return { posts: [], count: 0, status: 'error', errorMessage: 'Apify run did not return a dataset ID' };
    }

    // Fetch dataset items
    const itemsRes = await fetch(
      `${APIFY_API}/datasets/${datasetId}/items?token=${apifyToken}&limit=${limit}`,
      { signal: AbortSignal.timeout(30000) },
    );

    if (!itemsRes.ok) {
      return { posts: [], count: 0, status: 'error', errorMessage: `Apify dataset fetch failed: ${itemsRes.status}` };
    }

    const items = await itemsRes.json() as any[];

    const posts: SocialPost[] = (items ?? []).map((item: any): SocialPost => {
      const hashtags = (item.hashtags ?? []).map((h: any) => h.name ?? h).join(',');
      return {
        id: `tiktok-${item.id}`,
        platform: 'tiktok',
        author: `@${item.authorMeta?.name ?? ''}`,
        content: sanitizeTextContent(item.text ?? '', 500),
        url: item.webVideoUrl ?? `https://www.tiktok.com/@${item.authorMeta?.name}/video/${item.id}`,
        timestamp: item.createTimeISO ? new Date(item.createTimeISO).getTime() : Date.now(),
        mediaUrl: item.videoMeta?.coverUrl ?? '',
        engagement: (item.diggCount ?? 0) + (item.shareCount ?? 0),
        latitude: 0,
        longitude: 0,
        subreddit: '',
        hashtags,
      };
    });

    return { posts, count: posts.length, status: 'ok', errorMessage: '' };
  } catch (err) {
    return { posts: [], count: 0, status: 'error', errorMessage: `TikTok fetch failed: ${(err as Error).message}` };
  }
}
