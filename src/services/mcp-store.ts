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
    serverUrl: 'https://slack.mcp.cloudflare.com/mcp',
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
    defaultTool: 'get_summary_attacks',
    defaultArgs: { limit: 10 },
    defaultTitle: 'Internet Radar',
  },
  {
    name: 'Google Maps',
    icon: '🗺️',
    description: 'Location search, place details, directions, and geocoding',
    serverUrl: 'https://maps.mcp.cloudflare.com/mcp',
    authNote: 'Requires Authorization: Bearer <GOOGLE_MAPS_API_KEY>',
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
    name: 'Web Fetch',
    icon: '📄',
    description: 'Fetch and read content from any public URL as plain text',
    serverUrl: 'https://mcp-fetch.cloudflare.com/mcp',
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
    serverUrl: 'https://mcp.datadoghq.com/mcp',
    authNote: 'Requires DD-API-KEY and DD-APPLICATION-KEY headers',
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
    name: 'Overpass (OSM)',
    icon: '🛰️',
    description: 'Free geospatial queries on OpenStreetMap — no API key needed',
    serverUrl: 'https://server.smithery.ai/@dokterbob/mcp-overpass-server/mcp',
    defaultTool: 'overpass_query',
    defaultArgs: { query: '[out:json];node["amenity"="hospital"](33.7,35.4,34.0,35.7);out body 10;' },
    defaultTitle: 'OSM Query',
  },
  {
    name: 'Perplexity',
    icon: '🔮',
    description: 'AI-powered research with cited, real-time answers',
    serverUrl: 'https://mcp.perplexity.ai/mcp',
    authNote: 'Requires Authorization: Bearer <PERPLEXITY_API_KEY>',
    defaultTool: 'search',
    defaultArgs: { query: 'latest geopolitical developments', recency_filter: 'day' },
    defaultTitle: 'Perplexity Research',
  },
  {
    name: 'Polygon.io',
    icon: '📊',
    description: 'Real-time and historical stock, options, forex, and crypto data',
    serverUrl: 'https://mcp.polygon.io/mcp',
    authNote: 'Requires Authorization: Bearer <POLYGON_API_KEY>',
    defaultTool: 'get_snapshot_all_tickers',
    defaultArgs: { tickers: ['AAPL', 'MSFT', 'NVDA', 'TSLA'], include_otc: false },
    defaultTitle: 'Market Snapshot',
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
  {
    name: 'Shodan',
    icon: '🔭',
    description: 'Search internet-facing devices, open ports, and exposed services',
    serverUrl: 'https://server.smithery.ai/@dokterbob/mcp-shodan/mcp',
    authNote: 'Requires Authorization: Bearer <SHODAN_API_KEY>',
    defaultTool: 'search_hosts',
    defaultArgs: { query: 'port:22 country:IR', facets: 'org', page: 1 },
    defaultTitle: 'Shodan Search',
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
