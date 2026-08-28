import { proxyUrl } from '@/utils';
import { isDesktopRuntime, toApiUrl } from '@/services/runtime';

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
  { id: 'geopolitics', labelKey: 'components.telegramIntel.filterGeopolitics' },
  { id: 'middleeast', labelKey: 'components.telegramIntel.filterMiddleeast' },
  { id: 'osint', labelKey: 'components.telegramIntel.filterOsint' },
  { id: 'cyber', labelKey: 'components.telegramIntel.filterCyber' },
] as const;

let cachedResponse: TelegramFeedResponse | null = null;
let cachedAt = 0;
const CACHE_TTL = 30_000;
// How long a last-known-good payload may stand in for a failed refresh. Replaces
// the `stale-if-error=120` the edge provided before the route went `private`;
// widened to 10 min (10x the panel's 60s refresh) so a relay restart is covered,
// but bounded so stale intel eventually yields to an honest empty state.
const STALE_FALLBACK_TTL = 600_000;
const MISSING_TIMESTAMP_ISO = new Date(0).toISOString();

function telegramFeedUrl(limit: number): string {
  const path = `/api/telegram-feed?limit=${limit}`;
  return isDesktopRuntime() ? proxyUrl(path) : toApiUrl(path);
}

export async function fetchTelegramFeed(limit = 50): Promise<TelegramFeedResponse> {
  if (cachedResponse && Date.now() - cachedAt < CACHE_TTL) return cachedResponse;

  // Gating the route cost us the edge's `stale-if-error=120`: a shared entry used
  // to keep the panel populated through a relay 5xx, and `private` bars that. The
  // caller (loadTelegramIntel) turns any throw into a disabled empty-state that
  // DISCARDS the items already on screen, so without this a single relay blip
  // blanks the panel for every viewer at once. Serve the last good payload
  // instead and let the next refresh recover.
  //
  // Bounded on purpose. `stale-if-error` had a 120s ceiling; serving the last
  // payload forever would present hours-old conflict intel as current, which is
  // worse than an honest empty state. STALE_FALLBACK_TTL is the replacement
  // ceiling -- past it we throw and the panel degrades as before.
  //
  // Never touches `cachedAt`: the stale copy is only ever a fallback, so it
  // cannot satisfy the fresh-cache check above or suppress the next real fetch.
  const staleFallback = (): TelegramFeedResponse | null =>
    cachedResponse && Date.now() - cachedAt < STALE_FALLBACK_TTL ? cachedResponse : null;

  let res: Response;
  try {
    res = await fetch(telegramFeedUrl(limit));
  } catch (error) {
    const stale = staleFallback();
    if (stale) return stale;
    throw error;
  }
  if (!res.ok) {
    const stale = staleFallback();
    if (stale) return stale;
    throw new Error(`Telegram feed ${res.status}`);
  }

  let json: TelegramFeedResponse;
  try {
    json = await res.json();
  } catch (error) {
    // A truncated or non-JSON 200 is the same class of upstream blip as a 5xx;
    // handling it differently would strand the panel on exactly the shape the
    // relay's own normalization fallthrough exists to tolerate.
    const stale = staleFallback();
    if (stale) return stale;
    throw error;
  }
  cachedResponse = json;
  cachedAt = Date.now();
  return json;
}

export function formatTelegramTime(ts: string): string {
  const time = new Date(ts).getTime();
  if (!Number.isFinite(time) || ts === MISSING_TIMESTAMP_ISO) return 'unknown';

  const diff = Date.now() - time;
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
