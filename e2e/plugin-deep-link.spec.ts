import { test, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import { buildPluginShell } from '../api/mcp/ui/_plugin-loader';

// Built news-and-maps view in an opaque iframe with a controlled host that behaves like ChatGPT
// opening a deep link: the open_news_dashboard entrypoint runs with empty arguments and the
// app-relative URL arrives in hostContext["openai/deepLink"] (OpenAI MCP extensions, Deep Links).
// Does not cover chatgpt.com itself.

test.use({ serviceWorkers: 'block' });

type Message = { method?: string; params?: Record<string, unknown> };

const ARTICLE = { title: 'Controlled report', source: 'Fixture publisher', link: 'https://example.com/news', publishedAt: Date.now(), location: { latitude: 35, longitude: 139 }, isAlert: false };

async function installHost(page: Page, deepLink?: string) {
  const messages: Message[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  const serve = (route: Parameters<Parameters<Page['route']>[1]>[0], path: string) => route.fulfill({ path, headers: { 'Access-Control-Allow-Origin': '*' } });
  await page.route('**/plugin/assets/**', route => serve(route, join(process.cwd(), 'dist/plugin/assets', new URL(route.request().url()).pathname.split('/').at(-1)!)));
  await page.route('**/plugin/plugin.html', route => serve(route, join(process.cwd(), 'dist/plugin/plugin.html')));
  for (const pattern of ['**/data/*.geojson', '**/data/countries-*m.json']) {
    await page.route(pattern, route => serve(route, join(process.cwd(), 'public/data', new URL(route.request().url()).pathname.split('/').at(-1)!)));
  }
  await page.route('**/deep-link-host-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>Deep link</title><body style="margin:0"><iframe title="WorldMonitor news and maps" sandbox="allow-scripts" style="width:1100px;height:1050px;border:0;display:block"></iframe>' }));
  await page.exposeFunction('recordMessage', (message: Message) => { messages.push(message); });
  await page.exposeFunction('hostCall', async (method: string, params: { name: string; arguments: Record<string, unknown> }) => {
    if (method === 'ui/initialize') {
      return {
        hostCapabilities: { serverTools: {}, updateModelContext: {} },
        hostContext: { theme: 'dark', displayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'], containerDimensions: { width: 1100, height: 1050 }, ...(deepLink ? { 'openai/deepLink': { url: deepLink } } : {}) },
      };
    }
    if (method !== 'tools/call') return {};
    toolCalls.push(params.arguments);
    return { structuredContent: { categories: { world: { items: [ARTICLE] }, conflict: { items: [] } }, coverage: { state: 'complete', servedStale: false }, requestedView: {} } };
  });
  await page.goto('/deep-link-host-test');
  const html = buildPluginShell({ origin: 'https://www.worldmonitor.app', entry: 'plugin.html', root: 'pluginRoot' });
  await page.evaluate(({ html }) => {
    const frame = document.querySelector('iframe')!;
    const bridge = window as unknown as { recordMessage: (message: object) => Promise<void>; hostCall: (method: string, params: object) => Promise<object> };
    window.addEventListener('message', async event => {
      if (event.source !== frame.contentWindow || event.data?.jsonrpc !== '2.0') return;
      const data = event.data;
      void bridge.recordMessage({ method: data.method, params: data.params });
      if (data.method === 'ui/notifications/initialized') {
        // An entrypoint opens with empty arguments.
        frame.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: {} } }, '*');
        const result = await bridge.hostCall('tools/call', { name: 'open_news_dashboard', arguments: {} });
        frame.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }, '*');
        return;
      }
      if (data.id === undefined || !data.method) return;
      const result = await bridge.hostCall(data.method, data.params);
      frame.contentWindow!.postMessage({ jsonrpc: '2.0', id: data.id, result }, '*');
    });
    frame.srcdoc = html.replace('<head>', `<head><base href="${location.origin}/">`);
  }, { html });
  return { messages, toolCalls, frame: page.frameLocator('iframe') };
}

/** The view the dashboard last reported to the model. */
function lastReportedView(messages: Message[]): Record<string, unknown> | undefined {
  const update = messages.filter(message => message.method === 'ui/update-model-context').at(-1);
  const text = (update?.params?.content as Array<{ text?: string }> | undefined)?.[0]?.text;
  return text ? (JSON.parse(text) as { view?: Record<string, unknown> }).view : undefined;
}

async function changeHostContext(page: Page, context: Record<string, unknown>) {
  await page.evaluate(context => {
    document.querySelector('iframe')!.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: context }, '*');
  }, context);
}

test('a deep link opens the dashboard on the linked view', async ({ page }) => {
  const host = await installHost(page, '/?country=IR&category=conflict&time_range=24h&utm_source=x');
  await expect.poll(() => lastReportedView(host.messages)).toMatchObject({ country: 'IR', category: 'conflict', time_range: '24h' });
  expect(host.toolCalls).toEqual([{}]);
  await expect(host.frame.getByRole('button', { name: 'IR country brief' })).toBeEnabled();
});

test('a later deep link from the host replaces the linked view', async ({ page }) => {
  const host = await installHost(page, '/?country=IR');
  await expect.poll(() => lastReportedView(host.messages)).toMatchObject({ country: 'IR' });
  await changeHostContext(page, { 'openai/deepLink': { url: '/?country=TW&category=world' } });
  await expect.poll(() => lastReportedView(host.messages)).toMatchObject({ country: 'TW', category: 'world' });
  await expect(host.frame.getByRole('button', { name: 'TW country brief' })).toBeEnabled();
});

test('without a deep link the dashboard keeps the tool view', async ({ page }) => {
  const host = await installHost(page);
  await expect(host.frame.locator('#panelsGrid')).toContainText(ARTICLE.title);
  await expect(host.frame.getByRole('button', { name: 'Select a country for its brief' })).toBeDisabled();
});
