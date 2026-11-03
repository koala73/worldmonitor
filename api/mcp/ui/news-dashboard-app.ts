import { rpcError, rpcOk } from '../rpc';
import { UI_RESOURCE_MIME_TYPE } from './shell';
import { buildPluginShell } from './_plugin-loader';

export const COUNTRY_VIEW_UI_URI = 'ui://worldmonitor/country-view-v3.html';
export const NEWS_DASHBOARD_UI_URI = 'ui://worldmonitor/news-dashboard-v3.html';
export const PREVIOUS_COUNTRY_VIEW_UI_URI = 'ui://worldmonitor/country-view-v2.html';
export const PREVIOUS_NEWS_DASHBOARD_UI_URI = 'ui://worldmonitor/news-dashboard-v2.html';
export const LEGACY_COUNTRY_VIEW_UI_URI = 'ui://worldmonitor/country-view-v1.html';
export const LEGACY_NEWS_DASHBOARD_UI_URI = 'ui://worldmonitor/news-dashboard.html';
const previewHost = process.env.VERCEL_ENV === 'preview' ? process.env.VERCEL_URL : undefined;
const ASSET_ORIGIN = previewHost && /^[a-z0-9-]+\.vercel\.app$/i.test(previewHost)
  ? `https://${previewHost}`
  : 'https://www.worldmonitor.app';
const MAP_ASSET_ORIGINS = [
  'https://tiles.openfreemap.org',
  'https://basemaps.cartocdn.com',
  'https://*.basemaps.cartocdn.com',
];
export const NEWS_DASHBOARD_META = {
  ui: {
    csp: {
      connectDomains: [ASSET_ORIGIN, ...MAP_ASSET_ORIGINS],
      resourceDomains: [ASSET_ORIGIN, ...MAP_ASSET_ORIGINS, 'data:'],
      frameDomains: [],
      baseUriDomains: [ASSET_ORIGIN],
    },
    prefersBorder: true,
  },
};

export const COUNTRY_VIEW_META = {
  ui: { csp: { connectDomains: [ASSET_ORIGIN], resourceDomains: [ASSET_ORIGIN, 'https://upload.wikimedia.org', 'data:'], frameDomains: [], baseUriDomains: [ASSET_ORIGIN] }, prefersBorder: true },
};

export const MARKET_RADAR_META = {
  ui: { csp: { connectDomains: [ASSET_ORIGIN], resourceDomains: [ASSET_ORIGIN], frameDomains: [], baseUriDomains: [ASSET_ORIGIN] }, prefersBorder: true },
};

export async function readNewsDashboard(id: unknown, corsHeaders: Record<string, string>, uri = NEWS_DASHBOARD_UI_URI): Promise<Response> {
  return readPluginDocument(id, corsHeaders, 'plugin.html', 'pluginRoot', uri);
}

export async function readCountryView(id: unknown, corsHeaders: Record<string, string>, uri = COUNTRY_VIEW_UI_URI): Promise<Response> {
  return readPluginDocument(id, corsHeaders, 'country.html', 'countryRoot', uri);
}

export async function readPluginDocument(id: unknown, corsHeaders: Record<string, string>, entry: 'plugin.html' | 'country.html' | 'market.html', root: 'pluginRoot' | 'countryRoot' | 'marketRoot', uri: string): Promise<Response> {
  try {
    const response = await fetch(`${ASSET_ORIGIN}/plugin/${entry}`, {
      headers: { 'User-Agent': 'WorldMonitor-MCP/1.0' },
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) throw new Error('Missing plugin build');
    if (!response.body) throw new Error('Missing plugin body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let html = '';
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 131072) throw new Error('Plugin document too large');
        html += decoder.decode(chunk.value, { stream: true });
      }
      html += decoder.decode();
    } finally { await reader.cancel(); }
    if (!html.includes(`id="${root}"`) || !html.includes('<head>')) throw new Error('Invalid plugin build');
    const text = buildPluginShell({ origin: ASSET_ORIGIN, entry, root });
    return rpcOk(id, { contents: [{ uri, mimeType: UI_RESOURCE_MIME_TYPE, text, _meta: root === 'pluginRoot' ? NEWS_DASHBOARD_META : root === 'marketRoot' ? MARKET_RADAR_META : COUNTRY_VIEW_META }] }, corsHeaders);
  } catch {
    return rpcError(id, -32603, 'WorldMonitor dashboard assets are unavailable. Retry after the plugin build is deployed.', corsHeaders);
  }
}
