import type {
  IntelligenceServiceHandler,
  ServerContext,
  ListXFeedRequest,
  ListXFeedResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { getRelayBaseUrl, getRelayHeaders } from './_relay';

interface XRelayPost {
  id?: string | number;
  postId?: string | number;
  accountId?: string | number;
  account?: string;
  accountTitle?: string;
  accountName?: string;
  handle?: string;
  topic?: string;
  ts?: string | number;
  timestamp?: string | number;
  timestampMs?: string | number;
  url?: unknown;
  permalink?: unknown;
  hasMedia?: boolean;
  lang?: string;
  contentState?: string;
  text?: unknown;
}

interface XRelayResponse {
  enabled?: boolean;
  posts?: XRelayPost[];
  items?: XRelayPost[];
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

function derivedFacts(post: XRelayPost, permalink: string): string[] {
  const accountName = toText(post.accountTitle || post.accountName || post.account || post.handle).trim() || 'X';
  const topic = toText(post.topic).trim() || 'update';
  const facts = [`${accountName} posted a ${topic} update`];
  if (post.hasMedia) facts.push('includes media');
  if (post.lang) facts.push(`lang=${toText(post.lang)}`);
  if (permalink) facts.push(permalink);
  return facts;
}

/**
 * ListXFeed fetches curated public news-account posts from the X relay.
 * MCP/embed partners receive permalink + derived facts only — never tweet bodies.
 */
export const listXFeed: IntelligenceServiceHandler['listXFeed'] = async (
  _ctx: ServerContext,
  req: ListXFeedRequest,
): Promise<ListXFeedResponse> => {
  const relayBaseUrl = getRelayBaseUrl();
  if (!relayBaseUrl) {
    return { enabled: false, posts: [], count: 0, error: 'WS_RELAY_URL not configured' };
  }

  const params = new URLSearchParams();
  const limit = Math.max(1, Math.min(200, req.limit || 50));
  params.set('limit', String(limit));
  if (req.topic) params.set('topic', req.topic);
  if (req.account) params.set('account', req.account);
  params.set('includeDeleted', '1');

  const url = `${relayBaseUrl}/x/feed?${params.toString()}`;
  try {
    const response = await fetch(url, {
      headers: getRelayHeaders(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return { enabled: false, posts: [], count: 0, error: `Relay HTTP ${response.status}` };
    }

    const data = (await response.json()) as XRelayResponse;
    const relayPosts = Array.isArray(data.posts) ? data.posts : (data.items || []);
    const posts = relayPosts.map((post) => {
      const permalink = toHttpUrl(post.permalink || post.url);
      const handle = toText(post.handle || post.account);
      return {
        id: toText(post.id),
        accountId: toText(post.accountId),
        accountName: toText(post.accountName || post.accountTitle || post.account || handle),
        handle,
        topic: toText(post.topic),
        timestampMs: toTimestampMs(post.timestampMs ?? post.timestamp ?? post.ts),
        permalink,
        facts: derivedFacts(post, permalink),
        hasMedia: Boolean(post.hasMedia),
        lang: toText(post.lang),
        contentState: toText(post.contentState) || 'active',
      };
    });

    return {
      enabled: data.enabled ?? true,
      posts,
      count: posts.length,
      error: data.error || '',
    };
  } catch (error) {
    return { enabled: false, posts: [], count: 0, error: String(error) };
  }
};
