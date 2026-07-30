import type {
  IntelligenceServiceHandler,
  ServerContext,
  ListTelegramFeedRequest,
  ListTelegramFeedResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { getRelayBaseUrl, getRelayHeaders } from './_relay';

interface TelegramRelayMessage {
  id?: string | number;
  channelId?: string | number;
  channel?: string;
  channelName?: string;
  channelTitle?: string;
  text?: string;
  timestamp?: string | number;
  timestampMs?: string | number;
  ts?: string | number;
  mediaUrls?: unknown[];
  sourceUrl?: unknown;
  url?: unknown;
  topic?: string;
}

interface TelegramRelayResponse {
  enabled?: boolean;
  messages?: TelegramRelayMessage[];
  items?: TelegramRelayMessage[];
  count?: number;
  error?: string;
}

function toTimestampMs(value: string | number | undefined): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return value >= 1e12 ? value : value * 1000;
  }
  if (!value) return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric >= 1e12 ? numeric : numeric * 1000;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function toText(value: unknown): string {
  return value == null ? '' : String(value);
}

function toHttpUrl(value: unknown): string {
  const raw = toText(value).trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

/**
 * ListTelegramFeed fetches OSINT messages from the Telegram relay.
 */
export const listTelegramFeed: IntelligenceServiceHandler['listTelegramFeed'] = async (
  _ctx: ServerContext,
  req: ListTelegramFeedRequest,
): Promise<ListTelegramFeedResponse> => {
  const relayBaseUrl = getRelayBaseUrl();
  if (!relayBaseUrl) {
    return { enabled: false, messages: [], count: 0, error: 'WS_RELAY_URL not configured' };
  }

  const params = new URLSearchParams();
  const limit = Math.max(1, Math.min(200, req.limit || 50));
  params.set('limit', String(limit));
  if (req.topic) params.set('topic', req.topic);
  if (req.channel) params.set('channel', req.channel);

  const url = `${relayBaseUrl}/telegram/feed?${params.toString()}`;
  try {
    const response = await fetch(url, {
      headers: getRelayHeaders(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return { enabled: false, messages: [], count: 0, error: `Relay HTTP ${response.status}` };
    }

    const data = (await response.json()) as TelegramRelayResponse;
    const relayMessages = Array.isArray(data.messages) ? data.messages : (data.items || []);
    const messages = relayMessages.map((message) => ({
      id: toText(message.id),
      channelId: toText(message.channelId),
      channelName: toText(message.channelName || message.channelTitle || message.channel),
      text: toText(message.text),
      timestampMs: toTimestampMs(message.timestampMs ?? message.timestamp ?? message.ts),
      mediaUrls: Array.isArray(message.mediaUrls) ? message.mediaUrls.map(toHttpUrl).filter(Boolean) : [],
      sourceUrl: toHttpUrl(message.sourceUrl || message.url),
      topic: toText(message.topic),
    }));

    return {
      enabled: data.enabled ?? true,
      messages,
      count: messages.length,
      error: data.error || '',
    };
  } catch (error) {
    return { enabled: false, messages: [], count: 0, error: String(error) };
  }
};
