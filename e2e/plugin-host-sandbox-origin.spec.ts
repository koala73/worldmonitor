import { test, expect, type Page, type Route } from '@playwright/test';
import { join } from 'node:path';
import { buildPluginShell } from '../api/mcp/ui/_plugin-loader';

// Claude serves an MCP Apps view from its own sandbox origin
// (<hash>.claudemcpcontent.com) with a CSP that blocks <base>, so the shell's
// <base href="https://www.worldmonitor.app/"> is ignored there. Any asset or
// data path the view resolves against the document then points at the sandbox
// origin and 404s: the map stylesheet failed, deck.gl fell back to the SVG map,
// and the SVG map drew no countries. This spec serves WorldMonitor files only
// from the asset origin and runs the view on a separate origin that blocks <base>.

test.use({ serviceWorkers: 'block' });

const ASSET_ORIGIN = 'https://www.worldmonitor.app';
const SANDBOX_ORIGIN = 'https://view.sandbox.test';
const ARTICLE = { title: 'Controlled earthquake report in Japan', source: 'Fixture publisher', link: 'https://example.com/news', publishedAt: Date.now(), location: { latitude: 35, longitude: 139 }, isAlert: true };
const VIEW = { country: 'JP' };

async function installSandboxedHost(page: Page) {
  const sandboxRequests: string[] = [];
  const assetRequests: string[] = [];
  const consoleProblems: string[] = [];
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') consoleProblems.push(message.text());
  });
  const serve = (route: Route, path: string) => route.fulfill({ path, headers: { 'Access-Control-Allow-Origin': '*' } });
  await page.route(`${ASSET_ORIGIN}/**`, route => {
    const { pathname } = new URL(route.request().url());
    assetRequests.push(pathname);
    const file = pathname.split('/').at(-1)!;
    if (pathname.startsWith('/plugin/assets/')) return serve(route, join(process.cwd(), 'dist/plugin/assets', file));
    if (pathname === '/plugin/plugin.html') return serve(route, join(process.cwd(), 'dist/plugin/plugin.html'));
    if (pathname.startsWith('/data/')) return serve(route, join(process.cwd(), 'public/data', file));
    if (pathname.startsWith('/textures/')) return serve(route, join(process.cwd(), 'public/textures', file));
    return route.fulfill({ status: 404, body: 'Not Found' });
  });
  const shell = buildPluginShell({ origin: ASSET_ORIGIN, entry: 'plugin.html', root: 'pluginRoot' });
  await page.route(`${SANDBOX_ORIGIN}/**`, route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/view') {
      return route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': "base-uri 'none'" }, body: shell });
    }
    sandboxRequests.push(pathname);
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' });
  });
  await page.route('**/sandbox-host-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>Sandboxed host</title><body style="margin:0"><iframe title="WorldMonitor news and maps" sandbox="allow-scripts allow-same-origin" style="width:1100px;height:1050px;border:0;display:block"></iframe>' }));
  await page.exposeFunction('hostCall', async (method: string) => {
    if (method === 'ui/initialize') {
      return { hostCapabilities: { serverTools: {} }, hostContext: { theme: 'dark', displayMode: 'inline', containerDimensions: { width: 1100, maxHeight: 6000 } } };
    }
    if (method === 'tools/call') {
      return { structuredContent: { categories: { world: { items: [ARTICLE] } }, coverage: { state: 'complete', servedStale: false }, requestedView: VIEW } };
    }
    return {};
  });
  await page.goto('/sandbox-host-test');
  await page.evaluate(({ src, view }) => {
    const frame = document.querySelector('iframe')!;
    const bridge = window as unknown as { hostCall: (method: string, params: object) => Promise<object> };
    window.addEventListener('message', async event => {
      if (event.source !== frame.contentWindow || event.data?.jsonrpc !== '2.0') return;
      const data = event.data;
      if (data.method === 'ui/notifications/initialized') {
        frame.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: view } }, '*');
        const result = await bridge.hostCall('tools/call', { name: 'open_news_dashboard', arguments: view });
        frame.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }, '*');
        return;
      }
      if (data.id === undefined || !data.method) return;
      const result = await bridge.hostCall(data.method, data.params);
      frame.contentWindow!.postMessage({ jsonrpc: '2.0', id: data.id, result }, '*');
    });
    frame.src = src;
  }, { src: `${SANDBOX_ORIGIN}/view`, view: VIEW });
  return { frame: page.frameLocator('iframe'), sandboxRequests, assetRequests, consoleProblems };
}

test('a host sandbox that blocks <base> still gets the map assets and country shapes from WorldMonitor', async ({ page }) => {
  const host = await installSandboxedHost(page);
  await expect(host.frame.locator('#panelsGrid')).toContainText(ARTICLE.title);
  // The 2D map needs the country topology; the deck.gl map also needs its stylesheet.
  await expect.poll(() => host.assetRequests.some(path => /^\/data\/countries/.test(path)), { timeout: 15_000 }).toBe(true);
  await page.waitForTimeout(1000);
  expect(host.sandboxRequests, 'nothing may resolve against the sandbox origin').toEqual([]);
  expect(host.consoleProblems.filter(text => /Failed to load map data|Unable to preload CSS|DeckGL initialization failed/.test(text))).toEqual([]);
});
