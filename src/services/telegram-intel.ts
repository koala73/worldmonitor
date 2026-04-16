import { isDesktopRuntime, toApiUrl, toRuntimeUrl } from '@/services/runtime';

export interface TelegramItem {
  id: string;
  source: 'telegram';
  channel: string;
  channelTitle: string;
  url: string;
  ts: string;
  text: string;
  topic: string;
  tags: string[];
  earlySignal: boolean;
  mediaUrls?: string[];
  watchlist?: boolean;
}

export interface TelegramFeedResponse {
  source: string;
  earlySignal: boolean;
  enabled: boolean;
  count: number;
  updatedAt: string | null;
  items: TelegramItem[];
}

export interface TelegramChannelPreview {
  username: string;
  title: string;
  memberCount: number | null;
  url: string;
}

export const TELEGRAM_TOPICS = [
  { id: 'all', labelKey: 'components.telegramIntel.filterAll' },
  { id: 'breaking', labelKey: 'components.telegramIntel.filterBreaking' },
  { id: 'conflict', labelKey: 'components.telegramIntel.filterConflict' },
  { id: 'geopolitics', labelKey: 'components.telegramIntel.filterGeopolitics' },
  { id: 'middleeast', labelKey: 'components.telegramIntel.filterMiddleeast' },
  { id: 'osint', labelKey: 'components.telegramIntel.filterOsint' },
  { id: 'cyber', labelKey: 'components.telegramIntel.filterCyber' },
] as const;

let cachedResponse: TelegramFeedResponse | null = null;
let cachedAt = 0;
const CACHE_TTL = 30_000;
const RESOLVE_CACHE_TTL = 24 * 60 * 60 * 1000;
const CHANNEL_CACHE_TTL = 60_000;

const previewCache = new Map<string, { data: TelegramChannelPreview; expiresAt: number }>();
const previewInflight = new Map<string, Promise<TelegramChannelPreview>>();
const channelCache = new Map<string, { data: TelegramFeedResponse; expiresAt: number }>();
const channelInflight = new Map<string, Promise<TelegramFeedResponse>>();

function telegramFeedUrl(limit: number): string {
  const path = `/api/telegram-feed?limit=${limit}`;
  return isDesktopRuntime() ? toRuntimeUrl(path) : toApiUrl(path);
}

function telegramResolveUrl(username: string): string {
  const path = `/api/telegram-resolve?username=${encodeURIComponent(username)}`;
  return isDesktopRuntime() ? toRuntimeUrl(path) : toApiUrl(path);
}

function telegramChannelUrl(username: string, limit: number): string {
  const path = `/api/telegram-channel?username=${encodeURIComponent(username)}&limit=${limit}`;
  return isDesktopRuntime() ? toRuntimeUrl(path) : toApiUrl(path);
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.ok) {
    return response.json() as Promise<T>;
  }

  let errorMessage = `${response.status}`;
  try {
    const errorJson = await response.json() as { error?: string; details?: string };
    errorMessage = errorJson.details || errorJson.error || errorMessage;
  } catch {
    errorMessage = `${response.status}`;
  }
  throw new Error(errorMessage);
}

function applyWatchlistMetadata(items: TelegramItem[]): TelegramItem[] {
  return items.map(item => ({
    ...item,
    topic: item.topic || 'osint',
    watchlist: true,
  }));
}

export async function fetchTelegramFeed(limit = 50): Promise<TelegramFeedResponse> {
  if (cachedResponse && Date.now() - cachedAt < CACHE_TTL) return cachedResponse;

  const res = await fetch(telegramFeedUrl(limit));
  if (!res.ok) throw new Error(`Telegram feed ${res.status}`);

  const json: TelegramFeedResponse = await res.json();
  cachedResponse = json;
  cachedAt = Date.now();
  return json;
}

export async function fetchTelegramChannelPreview(username: string): Promise<TelegramChannelPreview> {
  const cacheKey = username.toLowerCase();
  const cached = previewCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const inflight = previewInflight.get(cacheKey);
  if (inflight) return inflight;

  const request = (async () => {
    const preview = await readJson<TelegramChannelPreview>(await fetch(telegramResolveUrl(cacheKey)));
    previewCache.set(cacheKey, { data: preview, expiresAt: Date.now() + RESOLVE_CACHE_TTL });
    return preview;
  })();

  previewInflight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    previewInflight.delete(cacheKey);
  }
}

export async function fetchTelegramChannelFeed(username: string, limit = 20): Promise<TelegramFeedResponse> {
  const safeLimit = Math.max(1, Math.min(50, limit));
  const cacheKey = `${username.toLowerCase()}:${safeLimit}`;
  const cached = channelCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const inflight = channelInflight.get(cacheKey);
  if (inflight) return inflight;

  const request = (async () => {
    const response = await readJson<TelegramFeedResponse>(await fetch(telegramChannelUrl(username, safeLimit)));
    const normalized: TelegramFeedResponse = {
      ...response,
      items: applyWatchlistMetadata(response.items || []),
      count: Array.isArray(response.items) ? response.items.length : 0,
    };
    channelCache.set(cacheKey, { data: normalized, expiresAt: Date.now() + CHANNEL_CACHE_TTL });
    return normalized;
  })();

  channelInflight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    channelInflight.delete(cacheKey);
  }
}

export function formatTelegramTime(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
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
