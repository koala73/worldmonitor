import { rpcError, rpcOk } from '../rpc';
import { UI_RESOURCE_MIME_TYPE } from './shell';
// @ts-expect-error JS module, no declaration file.
import { captureSilentError } from '../../_sentry-edge.js';

export const NEWS_DASHBOARD_UI_URI = 'ui://worldmonitor/news-dashboard.html';
const previewHost = process.env.VERCEL_ENV === 'preview' ? process.env.VERCEL_URL : undefined;
const ASSET_ORIGIN = previewHost && /^[a-z0-9-]+\.vercel\.app$/i.test(previewHost)
  ? `https://${previewHost}`
  : 'https://www.worldmonitor.app';
export const NEWS_DASHBOARD_META = {
  ui: {
    csp: {
      connectDomains: [ASSET_ORIGIN, 'https://tiles.openfreemap.org', 'https://basemaps.cartocdn.com', 'https://*.basemaps.cartocdn.com'],
      resourceDomains: [ASSET_ORIGIN, 'https://tiles.openfreemap.org', 'https://basemaps.cartocdn.com', 'https://*.basemaps.cartocdn.com', 'data:'],
      frameDomains: [],
      baseUriDomains: [ASSET_ORIGIN],
    },
    prefersBorder: true,
  },
};

export async function readNewsDashboard(id: unknown, corsHeaders: Record<string, string>): Promise<Response> {
  let stage = 'fetch';
  let status: number | undefined;
  try {
    const response = await fetch(`${ASSET_ORIGIN}/plugin/plugin.html`, {
      headers: { 'User-Agent': 'WorldMonitor-MCP/1.0' },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    status = response.status;
    stage = 'response';
    if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) throw new Error('Missing plugin build');
    if (!response.body) throw new Error('Missing plugin body');
    const reader = response.body.getReader();
    stage = 'read';
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
    stage = 'document';
    if (!html.includes('id="pluginRoot"') || !html.includes('<head>')) throw new Error('Invalid plugin build');
    const text = html.replace('<head>', `<head><base href="${ASSET_ORIGIN}/">`);
    return rpcOk(id, { contents: [{ uri: NEWS_DASHBOARD_UI_URI, mimeType: UI_RESOURCE_MIME_TYPE, text, _meta: NEWS_DASHBOARD_META }] }, corsHeaders);
  } catch (error) {
    const diagnostic = { stage, status, errorName: error instanceof Error ? error.name : 'UnknownError' };
    captureSilentError(new Error('News dashboard assets unavailable'), { tags: { route: 'mcp', step: stage }, extra: diagnostic });
    console.error(JSON.stringify({ event: 'mcp_news_dashboard_asset_failure', ...diagnostic }));
    return rpcError(id, -32603, 'WorldMonitor dashboard assets are unavailable. Retry after the plugin build is deployed.', corsHeaders, diagnostic);
  }
}
