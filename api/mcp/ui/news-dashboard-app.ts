import { rpcError, rpcOk } from '../rpc';
import { UI_RESOURCE_MIME_TYPE } from './shell';

export const NEWS_DASHBOARD_UI_URI = 'ui://worldmonitor/news-dashboard.html';
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

export async function readNewsDashboard(id: unknown, corsHeaders: Record<string, string>): Promise<Response> {
  try {
    const response = await fetch(`${ASSET_ORIGIN}/plugin/plugin.html`, {
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
    if (!html.includes('id="pluginRoot"') || !html.includes('<head>')) throw new Error('Invalid plugin build');
    const text = html.replace('<head>', `<head><base href="${ASSET_ORIGIN}/">`);
    return rpcOk(id, { contents: [{ uri: NEWS_DASHBOARD_UI_URI, mimeType: UI_RESOURCE_MIME_TYPE, text, _meta: NEWS_DASHBOARD_META }] }, corsHeaders);
  } catch {
    return rpcError(id, -32603, 'WorldMonitor dashboard assets are unavailable. Retry after the plugin build is deployed.', corsHeaders);
  }
}
