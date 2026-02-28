import { proxyUrl } from '@/utils';
import { isDesktopRuntime } from '@/services/runtime';

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
}

export interface TelegramFeedResponse {
  source: string;
  earlySignal: boolean;
  enabled: boolean;
  count: number;
  updatedAt: string | null;
  items: TelegramItem[];
}

export const TELEGRAM_TOPICS = [
  { id: 'all', labelKey: 'components.telegramIntel.filterAll' },
  { id: 'breaking', labelKey: 'components.telegramIntel.filterBreaking' },
  { id: 'conflict', labelKey: 'components.telegramIntel.filterConflict' },
  { id: 'alerts', labelKey: 'components.telegramIntel.filterAlerts' },
  { id: 'osint', labelKey: 'components.telegramIntel.filterOsint' },
  { id: 'politics', labelKey: 'components.telegramIntel.filterPolitics' },
  { id: 'middleeast', labelKey: 'components.telegramIntel.filterMiddleeast' },
] as const;

let cachedResponse: TelegramFeedResponse | null = null;
let cachedAt = 0;
const CACHE_TTL = 30_000;

function telegramFeedUrl(limit: number): string {
  const path = `/api/telegram-feed?limit=${limit}`;
  return isDesktopRuntime() ? proxyUrl(path) : path;
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
