import { loadFromStorage, saveToStorage } from '@/utils';

const STORAGE_KEY = 'wm-mcp-panels';
const PANEL_SPANS_KEY = 'worldmonitor-panel-spans';
const PANEL_COL_SPANS_KEY = 'worldmonitor-panel-col-spans';
const MAX_PANELS = 10;

export interface McpPreset {
  name: string;
  icon: string;
  description: string;
  serverUrl: string;
  authNote?: string;
  defaultTool?: string;
  defaultArgs?: Record<string, unknown>;
  defaultTitle?: string;
}

export const MCP_PRESETS: McpPreset[] = [
  {
    name: 'Exa Search',
    icon: '🔍',
    description: 'Real-time web search with clean, LLM-ready content from top results',
    serverUrl: 'https://mcp.exa.ai/mcp',
    authNote: 'Requires Authorization: Bearer <EXA_API_KEY> (free tier at exa.ai)',
    defaultTool: 'web_search_exa',
    defaultArgs: { query: 'latest geopolitical developments Middle East', numResults: 5 },
    defaultTitle: 'Web Intelligence',
  },
  {
    name: 'Tavily Search',
    icon: '🕵️',
    description: 'AI-optimized web search with source citations and real-time answers',
    serverUrl: 'https://mcp.tavily.com/mcp/',
    authNote: 'Requires Authorization: Bearer <TAVILY_API_KEY> (free tier at tavily.com)',
    defaultTool: 'tavily_search',
    defaultArgs: { query: 'breaking news today', search_depth: 'advanced', max_results: 5 },
    defaultTitle: 'Tavily Search',
  },
  {
    name: 'Perigon News',
    icon: '📰',
    description: 'Real-time global news search with journalist, company, and topic filters',
    serverUrl: 'https://mcp.perigon.io/v1/mcp',
    authNote: 'Requires Authorization: Bearer <PERIGON_API_KEY> (from perigon.io)',
    defaultTool: 'search_articles',
    defaultArgs: { q: 'conflict OR crisis', sortBy: 'date', size: 10 },
    defaultTitle: 'News Feed',
  },
  {
    name: 'Robtex',
    icon: '🛡️',
    description: 'Free DNS intelligence, IP reputation, BGP routing, and network threat data',
    serverUrl: 'https://mcp.robtex.com/mcp',
    defaultTool: 'ip_reputation',
    defaultArgs: { ip: '8.8.8.8' },
    defaultTitle: 'Network Intel',
  },
  {
    name: 'Pyth Price Feeds',
    icon: '📡',
    description: 'Free real-time price feeds for crypto, equities, and FX from Pyth Network',
    serverUrl: 'https://mcp.pyth.network/mcp',
    defaultTool: 'get_latest_price',
    defaultArgs: { symbol: 'Crypto.BTC/USD' },
    defaultTitle: 'Pyth Prices',
  },
  {
    name: 'LunarCrush',
    icon: '🌙',
    description: 'Crypto and stock social sentiment — mentions, engagement, and influencer signals',
    serverUrl: 'https://lunarcrush.ai/mcp',
    authNote: 'Requires Authorization: Bearer <LUNARCRUSH_API_KEY> (from lunarcrush.com)',
    defaultTool: 'Cryptocurrencies',
    defaultArgs: { sector: '', sort: 'social_dominance', limit: 20 },
    defaultTitle: 'Crypto Sentiment',
  },
  {
    name: 'Weather Forensics',
    icon: '🌦️',
    description: 'Free historical and current weather data — hourly, daily, and severe events',
    serverUrl: 'https://weatherforensics.dev/mcp/free',
    defaultTool: 'noaa_ncei_daily_weather_for_location_date',
    defaultArgs: { latitude: 33.8938, longitude: 35.5018, date: '2026-03-19' },
    defaultTitle: 'Weather',
  },
  {
    name: 'Alpha Vantage',
    icon: '📉',
    description: 'Stocks, forex, crypto, and commodities — real-time and historical market data',
    serverUrl: 'https://mcp.alphavantage.co/mcp',
    authNote: 'Requires Authorization: Bearer <ALPHA_VANTAGE_API_KEY> (free at alphavantage.co)',
    defaultTool: 'get_quote',
    defaultArgs: { symbol: 'SPY' },
    defaultTitle: 'Market Data',
  },
  {
    name: 'GitHub',
    icon: '🐙',
    description: 'Your repos, issues, PRs, pull requests, and code reviews',
    serverUrl: 'https://api.githubcopilot.com/mcp/',
    authNote: 'Requires Authorization: Bearer <GITHUB_TOKEN>',
    defaultTool: 'list_issues',
    defaultArgs: { owner: 'your-org', repo: 'your-repo', state: 'open', per_page: 20 },
    defaultTitle: 'GitHub Issues',
  },
  {
    name: 'Slack',
    icon: '💬',
    description: 'Your team channels, messages, and workspace activity',
    serverUrl: 'https://mcp.slack.com/mcp',
    authNote: 'Requires Authorization: Bearer <SLACK_BOT_TOKEN> (xoxb-...)',
    defaultTool: 'slack_get_channel_history',
    defaultArgs: { channel_name: 'general', limit: 20 },
    defaultTitle: 'Slack Feed',
  },
  {
    name: 'Cloudflare Radar',
    icon: '🌐',
    description: 'Live internet traffic, outages, BGP anomalies, and attack trends',
    serverUrl: 'https://radar.mcp.cloudflare.com/sse',
    authNote: 'Requires Authorization: Bearer <CF_API_TOKEN> (from Cloudflare dashboard)',
    defaultTool: 'get_summary_attacks',
    defaultArgs: { limit: 10 },
    defaultTitle: 'Internet Radar',
  },
  {
    name: 'Google Maps',
    icon: '🗺️',
    description: 'Location search, place details, directions, and geocoding',
    serverUrl: 'https://mapstools.googleapis.com/mcp',
    authNote: 'Requires X-Goog-Api-Key: <GOOGLE_MAPS_API_KEY>',
    defaultTool: 'maps_search_places',
    defaultArgs: { query: 'airports near Beirut', radius: 100000 },
    defaultTitle: 'Maps',
  },
  {
    name: 'PostgreSQL',
    icon: '🗄️',
    description: 'Query any PostgreSQL database you own or have access to',
    serverUrl: 'https://your-pg-mcp-server.example.com/mcp',
    authNote: 'Self-hosted — replace URL with your own PostgreSQL MCP server',
    defaultTool: 'query',
    defaultArgs: { sql: 'SELECT * FROM events ORDER BY created_at DESC LIMIT 20' },
    defaultTitle: 'My Database',
  },
  {
    name: 'Browser Fetch',
    icon: '📄',
    description: 'Fetch and read any public URL as plain text or markdown via Cloudflare Browser Rendering',
    serverUrl: 'https://browser.mcp.cloudflare.com/mcp',
    authNote: 'Requires Authorization: Bearer <CF_API_TOKEN> (from Cloudflare dashboard)',
    defaultTool: 'fetch',
    defaultArgs: { url: 'https://example.com', maxLength: 5000 },
    defaultTitle: 'Web Fetch',
  },
  {
    name: 'Linear',
    icon: '📋',
    description: 'Your issues, projects, cycles, and team roadmap',
    serverUrl: 'https://mcp.linear.app/mcp',
    authNote: 'Requires Authorization: Bearer <LINEAR_API_KEY>',
    defaultTool: 'list_issues',
    defaultArgs: { filter: { state: { type: { eq: 'started' } } }, first: 20 },
    defaultTitle: 'Linear Issues',
  },
  {
    name: 'Sentry',
    icon: '🐛',
    description: 'Live error rates, recent exceptions, and release health',
    serverUrl: 'https://mcp.sentry.dev/mcp',
    authNote: 'Requires Authorization: Bearer <SENTRY_AUTH_TOKEN>',
    defaultTool: 'get_issues',
    defaultArgs: { organization_slug: 'your-org', project_slug: 'your-project', limit: 20 },
    defaultTitle: 'Sentry Errors',
  },
  {
    name: 'Datadog',
    icon: '📈',
    description: 'Metrics, monitors, dashboards, and infrastructure alerts',
    serverUrl: 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp',
    authNote: 'Requires DD-API-KEY: <KEY> and DD-APPLICATION-KEY: <KEY> headers (from Datadog → Organization Settings → API Keys)',
    defaultTool: 'get_active_monitors',
    defaultArgs: { tags: [], count: 20 },
    defaultTitle: 'Datadog Monitors',
  },
  {
    name: 'Stripe',
    icon: '💳',
    description: 'Revenue, charges, subscriptions, and payment activity',
    serverUrl: 'https://mcp.stripe.com/',
    authNote: 'Requires Authorization: Bearer <STRIPE_SECRET_KEY>',
    defaultTool: 'retrieve_balance',
    defaultArgs: {},
    defaultTitle: 'Stripe Balance',
  },
  {
    name: 'Notion',
    icon: '📝',
    description: 'Search and query your Notion databases, pages, and notes',
    serverUrl: 'https://mcp.notion.com/mcp',
    authNote: 'Requires Authorization: Bearer <NOTION_INTEGRATION_TOKEN>',
    defaultTool: 'search',
    defaultArgs: { query: '', filter: { value: 'database', property: 'object' }, page_size: 20 },
    defaultTitle: 'Notion',
  },
  {
    name: 'Airtable',
    icon: '🏗️',
    description: 'Query records from any Airtable base you own',
    serverUrl: 'https://mcp.airtable.com/mcp',
    authNote: 'Requires Authorization: Bearer <AIRTABLE_PERSONAL_ACCESS_TOKEN>',
    defaultTool: 'list_records',
    defaultArgs: { baseId: 'appXXXXXXXXXXXXXX', tableId: 'tblXXXXXXXXXXXXXX', maxRecords: 20 },
    defaultTitle: 'Airtable Records',
  },
];

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpPanelSpec {
  id: string;
  title: string;
  serverUrl: string;
  customHeaders: Record<string, string>;
  toolName: string;
  toolArgs: Record<string, unknown>;
  refreshIntervalMs: number;
  createdAt: number;
  updatedAt: number;
}

export function loadMcpPanels(): McpPanelSpec[] {
  return loadFromStorage<McpPanelSpec[]>(STORAGE_KEY, []);
}

export function saveMcpPanel(spec: McpPanelSpec): void {
  const existing = loadMcpPanels().filter(p => p.id !== spec.id);
  const updated = [...existing, spec].slice(-MAX_PANELS);
  saveToStorage(STORAGE_KEY, updated);
}

export function deleteMcpPanel(id: string): void {
  const updated = loadMcpPanels().filter(p => p.id !== id);
  saveToStorage(STORAGE_KEY, updated);
  cleanSpanEntry(PANEL_SPANS_KEY, id);
  cleanSpanEntry(PANEL_COL_SPANS_KEY, id);
}

export function getMcpPanel(id: string): McpPanelSpec | null {
  return loadMcpPanels().find(p => p.id === id) ?? null;
}

function cleanSpanEntry(storageKey: string, panelId: string): void {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return;
    const spans = JSON.parse(raw) as Record<string, number>;
    if (!(panelId in spans)) return;
    delete spans[panelId];
    if (Object.keys(spans).length === 0) {
      localStorage.removeItem(storageKey);
    } else {
      localStorage.setItem(storageKey, JSON.stringify(spans));
    }
  } catch { /* ignore */ }
}
