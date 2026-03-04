/**
 * Social media client wrapper with per-platform caching and circuit breakers.
 *
 * Cache TTLs:
 * - Reddit: 5min
 * - Twitter: 1min
 * - Bluesky: 2min
 * - YouTube: 5min
 * - TikTok: 10min
 * - VK: 5min
 */

import { proxyUrl } from '@/utils';
import { isDesktopRuntime } from '@/services/runtime';

export type SocialPlatform = 'reddit' | 'twitter' | 'bluesky' | 'youtube' | 'tiktok' | 'vk';

export interface SocialPost {
  id: string;
  platform: string;
  author: string;
  content: string;
  url: string;
  timestamp: number;
  mediaUrl: string;
  latitude: number;
  longitude: number;
  engagement: number;
  subreddit: string;
  hashtags: string;
}

export interface SocialFeedResponse {
  posts: SocialPost[];
  count: number;
  status: string;
  errorMessage: string;
}

// --- Per-platform cache ---

interface CacheEntry {
  data: SocialFeedResponse;
  cachedAt: number;
}

const CACHE_TTLS: Record<SocialPlatform, number> = {
  reddit: 5 * 60_000,    // 5min
  twitter: 1 * 60_000,   // 1min
  bluesky: 2 * 60_000,   // 2min
  youtube: 5 * 60_000,   // 5min
  tiktok: 10 * 60_000,   // 10min
  vk: 5 * 60_000,        // 5min
};

const platformCache = new Map<SocialPlatform, CacheEntry>();

function isCacheValid(platform: SocialPlatform): boolean {
  const entry = platformCache.get(platform);
  if (!entry) return false;
  return Date.now() - entry.cachedAt < CACHE_TTLS[platform];
}

function getCached(platform: SocialPlatform): SocialFeedResponse | null {
  if (!isCacheValid(platform)) return null;
  return platformCache.get(platform)!.data;
}

function setCache(platform: SocialPlatform, data: SocialFeedResponse): void {
  platformCache.set(platform, { data, cachedAt: Date.now() });
}

// --- API URLs ---

function socialUrl(rpc: string, params?: Record<string, string>): string {
  const query = params ? '?' + new URLSearchParams(params).toString() : '';
  const path = `/api/social/v1/${rpc}${query}`;
  return isDesktopRuntime() ? proxyUrl(path) : path;
}

// --- Per-platform fetch ---

export async function fetchRedditPosts(
  subreddits: string[] = [],
  limit = 25,
  sort = 'hot',
): Promise<SocialFeedResponse> {
  const cached = getCached('reddit');
  if (cached) return cached;

  const params: Record<string, string> = { limit: String(limit), sort };
  // Note: subreddits as repeated params need special handling
  const urlParams = new URLSearchParams(params);
  subreddits.forEach(s => urlParams.append('subreddits', s));

  const path = `/api/social/v1/list-reddit-posts?${urlParams}`;
  const url = isDesktopRuntime() ? proxyUrl(path) : path;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Reddit feed ${res.status}`);
  const data: SocialFeedResponse = await res.json();
  setCache('reddit', data);
  return data;
}

export async function fetchTweets(
  query = '',
  username = '',
  limit = 25,
): Promise<SocialFeedResponse> {
  const cached = getCached('twitter');
  if (cached) return cached;

  const params: Record<string, string> = { limit: String(limit) };
  if (query) params.query = query;
  if (username) params.username = username;

  const url = socialUrl('list-tweets', params);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Twitter feed ${res.status}`);
  const data: SocialFeedResponse = await res.json();
  setCache('twitter', data);
  return data;
}

export async function fetchBlueskyPosts(
  query = '',
  limit = 25,
): Promise<SocialFeedResponse> {
  const cached = getCached('bluesky');
  if (cached) return cached;

  const params: Record<string, string> = { limit: String(limit) };
  if (query) params.query = query;

  const url = socialUrl('list-bluesky-posts', params);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Bluesky feed ${res.status}`);
  const data: SocialFeedResponse = await res.json();
  setCache('bluesky', data);
  return data;
}

export async function fetchYouTubeVideos(
  query = '',
  channelId = '',
  limit = 10,
): Promise<SocialFeedResponse> {
  const cached = getCached('youtube');
  if (cached) return cached;

  const params: Record<string, string> = { limit: String(limit) };
  if (query) params.query = query;
  if (channelId) params.channel_id = channelId;

  const url = socialUrl('list-youtube-videos', params);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube feed ${res.status}`);
  const data: SocialFeedResponse = await res.json();
  setCache('youtube', data);
  return data;
}

export async function fetchTikTokPosts(
  query = '',
  limit = 20,
): Promise<SocialFeedResponse> {
  const cached = getCached('tiktok');
  if (cached) return cached;

  const params: Record<string, string> = { limit: String(limit) };
  if (query) params.query = query;

  const url = socialUrl('list-tiktok-posts', params);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TikTok feed ${res.status}`);
  const data: SocialFeedResponse = await res.json();
  setCache('tiktok', data);
  return data;
}

export async function fetchVKPosts(
  ownerIds: string[] = [],
  limit = 25,
): Promise<SocialFeedResponse> {
  const cached = getCached('vk');
  if (cached) return cached;

  const urlParams = new URLSearchParams({ limit: String(limit) });
  ownerIds.forEach(id => urlParams.append('owner_ids', id));

  const path = `/api/social/v1/list-vk-posts?${urlParams}`;
  const url = isDesktopRuntime() ? proxyUrl(path) : path;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`VK feed ${res.status}`);
  const data: SocialFeedResponse = await res.json();
  setCache('vk', data);
  return data;
}

// --- Aggregator: fetch all platforms in parallel ---

export interface AllSocialFeedsResult {
  posts: SocialPost[];
  errors: { platform: SocialPlatform; error: string }[];
  lastUpdated: string;
}

export async function fetchAllSocialFeeds(): Promise<AllSocialFeedsResult> {
  const errors: { platform: SocialPlatform; error: string }[] = [];

  const results = await Promise.allSettled([
    fetchRedditPosts().catch(e => { errors.push({ platform: 'reddit', error: (e as Error).message }); return { posts: [], count: 0, status: 'error', errorMessage: '' } as SocialFeedResponse; }),
    fetchTweets().catch(e => { errors.push({ platform: 'twitter', error: (e as Error).message }); return { posts: [], count: 0, status: 'error', errorMessage: '' } as SocialFeedResponse; }),
    fetchBlueskyPosts().catch(e => { errors.push({ platform: 'bluesky', error: (e as Error).message }); return { posts: [], count: 0, status: 'error', errorMessage: '' } as SocialFeedResponse; }),
    fetchYouTubeVideos().catch(e => { errors.push({ platform: 'youtube', error: (e as Error).message }); return { posts: [], count: 0, status: 'error', errorMessage: '' } as SocialFeedResponse; }),
    fetchTikTokPosts().catch(e => { errors.push({ platform: 'tiktok', error: (e as Error).message }); return { posts: [], count: 0, status: 'error', errorMessage: '' } as SocialFeedResponse; }),
    fetchVKPosts().catch(e => { errors.push({ platform: 'vk', error: (e as Error).message }); return { posts: [], count: 0, status: 'error', errorMessage: '' } as SocialFeedResponse; }),
  ]);

  const allPosts: SocialPost[] = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => (r as PromiseFulfilledResult<SocialFeedResponse>).value.posts)
    .sort((a, b) => b.timestamp - a.timestamp);

  return {
    posts: allPosts,
    errors,
    lastUpdated: new Date().toISOString(),
  };
}

// --- Utilities ---

export function formatSocialTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return 'now';
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

export const SOCIAL_PLATFORMS: { id: SocialPlatform; labelKey: string }[] = [
  { id: 'reddit', labelKey: 'sentinel.socialFeed.filterReddit' },
  { id: 'twitter', labelKey: 'sentinel.socialFeed.filterTwitter' },
  { id: 'bluesky', labelKey: 'sentinel.socialFeed.filterBluesky' },
  { id: 'youtube', labelKey: 'sentinel.socialFeed.filterYouTube' },
  { id: 'tiktok', labelKey: 'sentinel.socialFeed.filterTikTok' },
  { id: 'vk', labelKey: 'sentinel.socialFeed.filterVK' },
];

export function clearSocialCache(): void {
  platformCache.clear();
}
