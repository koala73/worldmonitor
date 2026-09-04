import { isDesktopRuntime, toApiUrl, toRuntimeUrl } from '@/services/runtime';
import { createTimeoutSignal } from '@/services/timeout-signal';
import { normalizeTelegramUsername } from '@/services/telegram-watchlist';

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
// How long a last-known-good payload may stand in for a failed refresh. Replaces
// the `stale-if-error=120` the edge provided before the route went `private`;
// widened to 10 min (10x the panel's 60s refresh) so a relay restart is covered,
// but bounded so stale intel eventually yields to an honest empty state.
const STALE_FALLBACK_TTL = 600_000;
const MISSING_TIMESTAMP_ISO = new Date(0).toISOString();
const RESOLVE_CACHE_TTL = 60 * 60 * 1000;
// Deliberately LONGER than the panel's 60s refresh. At 30s every refresh tick
// missed the cache and re-fetched every watchlist entry, so a full watchlist
// spent its entire per-minute request budget on steady-state polling. At 90s a
// tick is usually a no-op and a channel still refreshes every other cycle.
const CHANNEL_CACHE_TTL = 90_000;
const LOOKUP_CACHE_MAX_ENTRIES = 64;
// Both sit just above the edge's own per-mode relay timeouts (20s / 22s) so the
// handler's 504 envelope wins the race and the user gets a real message rather
// than an opaque abort.
const PREVIEW_REQUEST_TIMEOUT_MS = 23_000;
const CHANNEL_REQUEST_TIMEOUT_MS = 25_000;

const previewCache = new Map<string, { data: TelegramChannelPreview; expiresAt: number }>();
const previewInflight = new Map<string, Promise<TelegramChannelPreview>>();
const channelCache = new Map<string, { data: TelegramFeedResponse; expiresAt: number }>();
const channelInflight = new Map<string, Promise<TelegramFeedResponse>>();

function setLookupCache<T>(
  cache: Map<string, { data: T; expiresAt: number }>,
  key: string,
  data: T,
  ttl: number,
): void {
  const now = Date.now();
  for (const [cachedKey, cached] of cache) {
    if (cached.expiresAt + STALE_FALLBACK_TTL <= now) cache.delete(cachedKey);
  }
  while (cache.size >= LOOKUP_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey == null) break;
    cache.delete(oldestKey);
  }
  cache.set(key, { data, expiresAt: now + ttl });
}

function telegramFeedUrl(limit: number): string {
  const path = `/api/telegram-feed?limit=${limit}`;
  return isDesktopRuntime() ? toRuntimeUrl(path) : toApiUrl(path);
}

function telegramResolveUrl(username: string): string {
  const path = `/api/telegram-feed?mode=resolve&username=${encodeURIComponent(username)}`;
  return isDesktopRuntime() ? toRuntimeUrl(path) : toApiUrl(path);
}

function telegramChannelUrl(username: string, limit: number): string {
  const path = `/api/telegram-feed?mode=channel&username=${encodeURIComponent(username)}&limit=${limit}`;
  return isDesktopRuntime() ? toRuntimeUrl(path) : toApiUrl(path);
}

/** Carries the HTTP status so callers can distinguish "try again shortly" from "bad input". */
export class TelegramLookupError extends Error {
  readonly status: number;
  readonly retryAfterMs: number;

  constructor(message: string, status: number, retryAfterMs = 0) {
    super(message);
    this.name = 'TelegramLookupError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfterMs(response: Response): number {
  const header = response.headers.get('retry-after');
  if (!header) return 0;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

async function readJson(response: Response): Promise<unknown> {
  if (response.ok) {
    return response.json() as Promise<unknown>;
  }

  let errorMessage = `${response.status}`;
  try {
    const errorJson = await response.json() as { error?: string };
    errorMessage = errorJson.error || errorMessage;
  } catch {
    errorMessage = `${response.status}`;
  }
  throw new TelegramLookupError(errorMessage, response.status, parseRetryAfterMs(response));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function parseTelegramChannelPreview(value: unknown): TelegramChannelPreview {
  const parsed = asRecord(value);
  if (!parsed) throw new Error('Invalid Telegram channel preview');
  const username = normalizeTelegramUsername(String(parsed.username || ''));
  if (!username) throw new Error('Invalid Telegram channel preview');
  const memberCount = parsed.memberCount == null ? null : Number(parsed.memberCount);
  return {
    username,
    title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : username,
    memberCount: memberCount != null && Number.isFinite(memberCount) && memberCount >= 0
      ? Math.floor(memberCount)
      : null,
    url: `https://t.me/${username}`,
  };
}

function parseTelegramItem(value: unknown): TelegramItem | null {
  const parsed = asRecord(value);
  if (!parsed) return null;
  const required = ['id', 'channel', 'channelTitle', 'url', 'ts', 'text', 'topic'] as const;
  for (const key of required) {
    if (typeof parsed[key] !== 'string') return null;
  }
  if (!Array.isArray(parsed.tags) || !parsed.tags.every((tag): tag is string => typeof tag === 'string')) {
    return null;
  }
  return {
    id: parsed.id as string,
    source: 'telegram',
    channel: parsed.channel as string,
    channelTitle: parsed.channelTitle as string,
    url: parsed.url as string,
    ts: parsed.ts as string,
    text: parsed.text as string,
    topic: parsed.topic as string,
    tags: parsed.tags,
    earlySignal: parsed.earlySignal !== false,
    ...(Array.isArray(parsed.mediaUrls) ? { mediaUrls: parsed.mediaUrls.filter(value => typeof value === 'string') } : {}),
    ...(parsed.watchlist === true ? { watchlist: true } : {}),
  };
}

function parseTelegramFeedResponse(value: unknown): TelegramFeedResponse {
  const parsed = asRecord(value);
  if (!parsed || !Array.isArray(parsed.items)) throw new Error('Invalid Telegram feed response');
  // Drop unparseable items rather than rejecting the whole payload. Throwing
  // here turned one malformed post into a blanked panel: the caller falls back
  // to a <=10min stale copy and then to the disabled empty state, discarding
  // intel that was on screen a moment earlier.
  const items = parsed.items
    .map(parseTelegramItem)
    .filter((item): item is TelegramItem => item !== null);
  return {
    source: typeof parsed.source === 'string' ? parsed.source : 'telegram',
    earlySignal: parsed.earlySignal !== false,
    // `!== false`, not `=== true`: an omitted `enabled` is shape drift, and
    // reading it as "relay disabled" renders a permanent not-active state over
    // a feed that is actually fine.
    enabled: parsed.enabled !== false,
    count: items.length,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    items,
  };
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
    json = parseTelegramFeedResponse(await res.json());
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

export async function fetchTelegramChannelPreview(username: string): Promise<TelegramChannelPreview> {
  // Normalize here rather than trusting callers: an un-normalized value became
  // both the cache key and the wire value, so `@foo` and `t.me/foo` would hold
  // separate entries and issue requests the edge then rejects.
  const cacheKey = normalizeTelegramUsername(username);
  if (!cacheKey) throw new TelegramLookupError('Invalid Telegram username', 400);
  const cached = previewCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const inflight = previewInflight.get(cacheKey);
  if (inflight) return inflight;

  const request = (async () => {
    const preview = parseTelegramChannelPreview(await readJson(await fetch(telegramResolveUrl(cacheKey), {
      signal: createTimeoutSignal(PREVIEW_REQUEST_TIMEOUT_MS),
    })));
    setLookupCache(previewCache, cacheKey, preview, RESOLVE_CACHE_TTL);
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
  const normalizedUsername = normalizeTelegramUsername(username);
  if (!normalizedUsername) throw new TelegramLookupError('Invalid Telegram username', 400);
  const cacheKey = `${normalizedUsername}:${safeLimit}`;
  const cached = channelCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  const stale = cached && cached.expiresAt + STALE_FALLBACK_TTL > Date.now()
    ? cached.data
    : null;

  const inflight = channelInflight.get(cacheKey);
  if (inflight) return inflight;

  const request = (async () => {
    try {
      const response = parseTelegramFeedResponse(await readJson(await fetch(telegramChannelUrl(normalizedUsername, safeLimit), {
        signal: createTimeoutSignal(CHANNEL_REQUEST_TIMEOUT_MS),
      })));
      const normalized: TelegramFeedResponse = {
        ...response,
        items: applyWatchlistMetadata(response.items || []),
        count: Array.isArray(response.items) ? response.items.length : 0,
      };
      setLookupCache(channelCache, cacheKey, normalized, CHANNEL_CACHE_TTL);
      return normalized;
    } catch (error) {
      if (stale) return stale;
      throw error;
    }
  })();

  channelInflight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    channelInflight.delete(cacheKey);
  }
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
