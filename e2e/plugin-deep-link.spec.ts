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

async function installHost(page: Page, deepLink?: string, options: { openingError?: boolean; hazardFailures?: number; holdHazards?: boolean } = {}) {
  let hazardFailures = options.hazardFailures ?? 0;
  // With holdHazards, each map-data request waits until the test releases it, in order.
  const heldHazards: Array<() => void> = [];
  let hazardCalls = 0;
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
    if (params.name === 'get_natural_disasters') {
      hazardCalls++;
      if (options.holdHazards) await new Promise<void>(release => heldHazards.push(release));
      if (hazardFailures-- > 0) return { __rpcError: 'Hazard request failed' };
      return { structuredContent: { data: { earthquakes: { earthquakes: [] }, events: { dataAvailable: true, events: [] }, fires: { dataAvailable: true, fireDetections: [] } } } };
    }
    toolCalls.push(params.arguments);
    if (options.openingError && toolCalls.length === 1) return { isError: true, content: [{ type: 'text', text: 'The dashboard request failed.' }] };
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
      const result = await bridge.hostCall(data.method, data.params) as { __rpcError?: string };
      frame.contentWindow!.postMessage(result.__rpcError ? { jsonrpc: '2.0', id: data.id, error: { code: -32000, message: result.__rpcError } } : { jsonrpc: '2.0', id: data.id, result }, '*');
    });
    frame.srcdoc = html.replace('<head>', `<head><base href="${location.origin}/">`);
  }, { html });
  return {
    messages, toolCalls, frame: page.frameLocator('iframe'),
    hazardCalls: () => hazardCalls,
    releaseHazard: async () => { await expect.poll(() => heldHazards.length).toBeGreaterThan(0); heldHazards.shift()!(); },
  };
}

type Receipt = { view?: Record<string, unknown>; map?: { timeRange?: string } };

function contextUpdates(messages: Message[]): Receipt[] {
  return messages.filter(message => message.method === 'ui/update-model-context').map(update => {
    const text = (update.params?.content as Array<{ text?: string }> | undefined)?.[0]?.text;
    return text ? JSON.parse(text) as Receipt : {};
  });
}

/** The view the dashboard last reported to the model. */
function lastReportedView(messages: Message[]): Record<string, unknown> | undefined {
  return contextUpdates(messages).at(-1)?.view;
}

async function postToolResult(page: Page, result: object) {
  await page.evaluate(result => {
    document.querySelector('iframe')!.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }, '*');
  }, result);
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

test('a later deep link without a time range resets the news and the map to all time', async ({ page }) => {
  const host = await installHost(page, '/?country=IR&time_range=24h');
  await expect.poll(() => contextUpdates(host.messages).at(-1)).toMatchObject({ view: { country: 'IR', time_range: '24h' }, map: { timeRange: '24h' } });
  await changeHostContext(page, { 'openai/deepLink': { url: '/?country=TW' } });
  await expect.poll(() => contextUpdates(host.messages).at(-1)?.view?.country).toBe('TW');
  const last = contextUpdates(host.messages).at(-1)!;
  expect(last.view?.time_range ?? 'all').toBe('all');
  expect(last.map?.timeRange).toBe('all');
});

test('an unavailable category in a link is dropped and the other fields still apply', async ({ page }) => {
  const host = await installHost(page, '/?category=missing-panel&country=IR&time_range=24h');
  await expect.poll(() => lastReportedView(host.messages)).toMatchObject({ country: 'IR', time_range: '24h' });
  expect(lastReportedView(host.messages)?.category).toBeUndefined();
});

test('a link waits for a dashboard that loads after a failed opening', async ({ page }) => {
  const host = await installHost(page, '/?country=IR&category=conflict', { openingError: true });
  await expect(host.frame.getByText('The dashboard request failed.')).toBeVisible();
  await host.frame.getByRole('button', { name: 'Refresh news' }).click();
  await expect.poll(() => lastReportedView(host.messages)).toMatchObject({ country: 'IR', category: 'conflict' });
});

test('a repeated dashboard result keeps the linked filters', async ({ page }) => {
  const host = await installHost(page, '/?country=IR&category=conflict');
  await expect.poll(() => lastReportedView(host.messages)).toMatchObject({ country: 'IR', category: 'conflict' });
  const before = contextUpdates(host.messages).length;
  await postToolResult(page, { structuredContent: { categories: { world: { items: [ARTICLE] }, conflict: { items: [] } }, coverage: { state: 'complete', servedStale: false }, requestedView: {} } });
  await expect.poll(() => contextUpdates(host.messages).length).toBeGreaterThan(before);
  await page.waitForTimeout(500);
  expect(lastReportedView(host.messages)).toMatchObject({ country: 'IR', category: 'conflict' });
});

test('a link whose map data failed applies again after Refresh news', async ({ page }) => {
  const host = await installHost(page, '/?country=IR&map_layers=natural', { hazardFailures: 1 });
  await expect(host.frame.getByText('The linked view could not be applied. Showing news with the previous filters.')).toBeVisible();
  await host.frame.getByRole('button', { name: 'Refresh news' }).click();
  await expect.poll(() => lastReportedView(host.messages)).toMatchObject({ country: 'IR', map_layers: ['natural'] });
});

test('a link that arrives while another applies wins', async ({ page }) => {
  const host = await installHost(page, '/?country=IR');
  await expect.poll(() => lastReportedView(host.messages)).toMatchObject({ country: 'IR' });
  await changeHostContext(page, { 'openai/deepLink': { url: '/?country=JP' } });
  await changeHostContext(page, { 'openai/deepLink': { url: '/?country=TW&category=world' } });
  await expect.poll(() => lastReportedView(host.messages)).toMatchObject({ country: 'TW', category: 'world' });
  await page.waitForTimeout(1000);
  expect(lastReportedView(host.messages)).toMatchObject({ country: 'TW', category: 'world' });
});

test('returning to the first link while a second applies shows the first again', async ({ page }) => {
  const host = await installHost(page, '/?country=IR');
  await expect.poll(() => lastReportedView(host.messages)).toMatchObject({ country: 'IR' });
  // Both arrive in one task, so the return to IR lands while TW is still applying.
  await page.evaluate(() => {
    const target = document.querySelector('iframe')!.contentWindow!;
    for (const url of ['/?country=TW', '/?country=IR']) target.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { 'openai/deepLink': { url } } }, '*');
  });
  await page.waitForTimeout(3000);
  expect(lastReportedView(host.messages)).toMatchObject({ country: 'IR' });
});

test('a host that returns to a link after it finished, while the next one applies, ends on that link', async ({ page }) => {
  const host = await installHost(page, undefined, { holdHazards: true });
  await expect(host.frame.locator('#panelsGrid')).toContainText(ARTICLE.title);
  await changeHostContext(page, { 'openai/deepLink': { url: '/?country=IR&map_layers=natural' } });
  await expect.poll(() => host.hazardCalls()).toBe(1);
  await changeHostContext(page, { 'openai/deepLink': { url: '/?country=TW&map_layers=fires' } });
  // IR finishes while TW waits in the queue; TW then starts and asks for its own map data.
  await host.releaseHazard();
  await expect.poll(() => lastReportedView(host.messages)?.country).toBe('IR');
  await expect.poll(() => host.hazardCalls()).toBe(2);
  // The host goes back to IR before TW finishes.
  await changeHostContext(page, { 'openai/deepLink': { url: '/?country=IR&map_layers=natural' } });
  const reportsBeforeTw = contextUpdates(host.messages).length;
  await host.releaseHazard();
  // TW applies, then the queued return to IR replaces it.
  await expect.poll(() => contextUpdates(host.messages).slice(reportsBeforeTw).some(update => update.view?.country === 'TW')).toBe(true);
  await expect.poll(() => lastReportedView(host.messages)?.country).toBe('IR');
  await page.waitForTimeout(1000);
  expect(lastReportedView(host.messages)?.country).toBe('IR');
});
