import type {
  IntelligenceServiceHandler,
  ServerContext,
  ListTelegramFeedRequest,
  ListTelegramFeedResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

interface TelegramRelayMessage {
  id: string | number;
  channelId: string | number;
  channelName: string;
  text: string;
  timestamp: string | number;
  mediaUrls?: string[];
  sourceUrl?: string;
  topic?: string;
}

interface TelegramRelayResponse {
  enabled?: boolean;
  messages: TelegramRelayMessage[];
  count?: number;
  error?: string;
}

/**
 * ListTelegramFeed fetches OSINT messages from the Telegram relay.
 */
export const listTelegramFeed: IntelligenceServiceHandler['listTelegramFeed'] = async (
  _ctx: ServerContext,
  req: ListTelegramFeedRequest,
): Promise<ListTelegramFeedResponse> => {
  const relayUrl = process.env.WS_RELAY_URL;
  if (!relayUrl) {
    return { enabled: false, messages: [], count: 0, error: 'WS_RELAY_URL not configured' };
  }

  const base = relayUrl.replace('wss://', 'https://').replace('ws://', 'http://').replace(/\/$/, '');
  const params = new URLSearchParams();
  if (req.limit) params.set('limit', String(req.limit));
  if (req.topic) params.set('topic', req.topic);
  if (req.channel) params.set('channel', req.channel);
  
  const url = `${base}/telegram/feed?${params.toString()}`;

  try {
    const relaySecret = process.env.RELAY_SHARED_SECRET || '';
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (relaySecret) {
      const relayHeader = (process.env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase();
      headers[relayHeader] = relaySecret;
      headers.Authorization = `Bearer ${relaySecret}`;
    }

    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (!resp.ok) {
      return { enabled: false, messages: [], count: 0, error: `Relay HTTP ${resp.status}` };
    }

    const data = await resp.json() as TelegramRelayResponse;
    return {
      enabled: data.enabled ?? true,
      messages: (data.messages || []).map((m) => ({
        id: String(m.id || ''),
        channelId: String(m.channelId || ''),
        channelName: String(m.channelName || ''),
        text: String(m.text || ''),
        timestampMs: (Number(m.timestamp) || 0).toString(),
        mediaUrls: Array.isArray(m.mediaUrls) ? m.mediaUrls.map(String) : [],
        sourceUrl: String(m.sourceUrl || ''),
        topic: String(m.topic || ''),
      })),
      count: data.count || 0,
      error: data.error || '',
    };
  } catch (err) {
    return { enabled: false, messages: [], count: 0, error: String(err) };
  }
};
