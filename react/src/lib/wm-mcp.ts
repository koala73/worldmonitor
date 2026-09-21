/**
 * World Monitor MCP helpers for the React rewrite.
 * Live data tools need VITE_WORLDMONITOR_API_KEY; get_sources is anonymous.
 */

const MCP_URL = import.meta.env.VITE_WM_MCP_URL ?? '/wm-mcp';
const USER_AGENT = 'npc-worldmonitor-react/0.1 (+AGPL-3.0 fork rewrite)';

export type FeedItem = {
  id: string;
  title: string;
  summary?: string;
  source?: string;
  url?: string;
  kind: string;
};

async function mcp(method: string, params: Record<string, unknown>, apiKey?: string) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'User-Agent': USER_AGENT,
  };
  if (apiKey) headers['X-WorldMonitor-Key'] = apiKey;

  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  let raw = text;
  if (text.includes('data:')) {
    const line = text.split('\n').find((l) => l.trim().startsWith('data:'));
    if (line) raw = line.replace(/^data:\s*/, '');
  }
  return JSON.parse(raw) as { result?: unknown; error?: { message?: string } };
}

function flatten(payload: unknown, kind: string): FeedItem[] {
  const root = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const data = (root.result ?? root.data ?? root) as unknown;
  const bag = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const rows: unknown[] = [];
  for (const v of Object.values(bag)) {
    if (Array.isArray(v)) rows.push(...v);
  }
  if (Array.isArray(data)) rows.push(...data);

  const out: FeedItem[] = [];
  rows.forEach((row, i) => {
    if (!row || typeof row !== 'object') return;
    const r = row as Record<string, unknown>;
    const title =
      (typeof r.title === 'string' && r.title) ||
      (typeof r.name === 'string' && r.name) ||
      (typeof r.headline === 'string' && r.headline);
    if (!title) return;
    out.push({
      id: String(r.id ?? r.url ?? `${kind}-${i}`),
      title,
      summary: typeof r.summary === 'string' ? r.summary : undefined,
      source: typeof r.source === 'string' ? r.source : undefined,
      url: typeof r.url === 'string' ? r.url : undefined,
      kind,
    });
  });
  return out;
}

export async function loadFeeds(): Promise<{
  items: FeedItem[];
  configured: boolean;
  error: string | null;
}> {
  const apiKey = import.meta.env.VITE_WORLDMONITOR_API_KEY as string | undefined;
  try {
    const sources = await mcp('tools/call', { name: 'get_sources', arguments: { limit: 20 } });
    const sourceItems = sources.error ? [] : flatten(sources, 'source');

    if (!apiKey) {
      return {
        items: sourceItems,
        configured: false,
        error: sources.error?.message ?? null,
      };
    }

    const news = await mcp(
      'tools/call',
      { name: 'get_news_intelligence', arguments: { limit: 12 } },
      apiKey,
    );
    const items = [...flatten(news, 'news'), ...sourceItems].slice(0, 40);
    return {
      items,
      configured: true,
      error: news.error?.message ?? null,
    };
  } catch (e) {
    return {
      items: [],
      configured: Boolean(apiKey),
      error: e instanceof Error ? e.message : 'MCP unreachable',
    };
  }
}
