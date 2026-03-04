/**
 * Social service handler -- thin composition file.
 *
 * Each RPC is implemented in its own file:
 * - reddit.ts    (Reddit OAuth2 client credentials)
 * - twitter.ts   (Twitter adapter pattern)
 * - bluesky.ts   (Bluesky AT Protocol public API)
 * - youtube.ts   (YouTube Data API v3)
 * - tiktok.ts    (TikTok Apify scraper)
 * - vk.ts        (VK API v5.199)
 */

import type { SocialServiceHandler } from '../../../../src/generated/server/worldmonitor/social/v1/service_server';
import { listRedditPosts } from './reddit';
import { listTweets } from './twitter';
import { listBlueskyPosts } from './bluesky';
import { listYouTubeVideos } from './youtube';
import { listTikTokPosts } from './tiktok';
import { listVKPosts } from './vk';

export const socialHandler: SocialServiceHandler = {
  listRedditPosts,
  listTweets,
  listBlueskyPosts,
  listYouTubeVideos,
  listTikTokPosts,
  listVKPosts,
};
