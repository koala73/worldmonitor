import { test, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import { buildPluginShell } from '../api/mcp/ui/_plugin-loader';

// Built news-and-maps view in an opaque iframe with a controlled MCP Apps host.
// Covers display modes (inline, side panel and fullscreen sizing), the handshake
// order, in-view tool titles, and reloading a digest the host did not deliver.
// Does not cover claude.ai itself; the owner checklist in the plan does.

test.use({ serviceWorkers: 'block' });

type Message = { at: number; method?: string; id?: unknown; params?: Record<string, unknown> };
type HostOptions = {
  availableDisplayModes?: string[];
  displayModeAnswer?: 'fullscreen' | 'inline';
  serverTools?: boolean;
  initialResult?: 'digest' | 'text' | 'pointer' | 'error';
  reload?: 'digest' | 'fail' | 'pointer';
  frame?: { width: number; height: number };
  initialView?: Record<string, unknown>;
};

const ARTICLE = { title: 'Controlled earthquake report in Japan', source: 'Fixture publisher', link: 'https://example.com/news', publishedAt: Date.now(), location: { latitude: 35, longitude: 139 }, isAlert: true };
const INITIAL_VIEW = { country: 'JP', jmespath: 'categories' };
const REFRESH_ID = '3f2a6c1e-9b4d-4e7a-8c21-5d0f9e6b7a10';

async function installHost(page: Page, options: HostOptions = {}) {
  const messages: Message[] = [];
  const viewCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const dataRequests: number[] = [];
  const serve = (route: Parameters<Parameters<Page['route']>[1]>[0], path: string) => route.fulfill({ path, headers: { 'Access-Control-Allow-Origin': '*' } });
  await page.route('**/plugin/assets/**', route => serve(route, join(process.cwd(), 'dist/plugin/assets', new URL(route.request().url()).pathname.split('/').at(-1)!)));
  await page.route('**/plugin/plugin.html', route => serve(route, join(process.cwd(), 'dist/plugin/plugin.html')));
  for (const pattern of ['**/data/*.geojson', '**/data/countries-*m.json']) {
    await page.route(pattern, route => { dataRequests.push(Date.now()); return serve(route, join(process.cwd(), 'public/data', new URL(route.request().url()).pathname.split('/').at(-1)!)); });
  }
  const size = options.frame ?? { width: 1100, height: 1050 };
  await page.route('**/display-host-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><title>Display modes</title><body style="margin:0"><iframe title="WorldMonitor news and maps" sandbox="allow-scripts" style="width:${size.width}px;height:${size.height}px;border:0;display:block"></iframe>` }));
  const digest = () => ({ structuredContent: { categories: { world: { items: [ARTICLE] } }, coverage: { state: 'complete', servedStale: false }, requestedView: { country: 'JP' } } });
  const pointer = () => ({ content: [{ type: 'text', text: '/mnt/user-data/tool_results/open_news_dashboard_1.json' }] });
  const respond = (kind: 'digest' | 'text' | 'pointer' | 'error' | 'fail') => {
    if (kind === 'fail') throw new Error('reload failed');
    if (kind === 'text') return { content: [{ type: 'text', text: JSON.stringify(digest().structuredContent) }] };
    if (kind === 'error') return { isError: true, content: [{ type: 'text', text: 'Daily MCP quota exceeded. Resets at next UTC midnight.' }] };
    return kind === 'pointer' ? pointer() : digest();
  };
  await page.exposeFunction('recordMessage', (message: Message) => { messages.push({ ...message, at: Date.now() }); });
  await page.exposeFunction('hostCall', async (method: string, params: { name: string; arguments: Record<string, unknown> }, fromView: boolean) => {
    if (method === 'ui/initialize') {
      return {
        hostCapabilities: { ...(options.serverTools === false ? {} : { serverTools: {} }), updateModelContext: {} },
        hostContext: { theme: 'dark', displayMode: 'inline', ...(options.availableDisplayModes ? { availableDisplayModes: options.availableDisplayModes } : {}), containerDimensions: { width: size.width, maxHeight: 6000 } },
      };
    }
    if (method === 'ui/request-display-mode') return { mode: options.displayModeAnswer ?? 'fullscreen' };
    if (method !== 'tools/call') return {};
    if (fromView) viewCalls.push(params);
    if (params.name !== 'open_news_dashboard') throw new Error(`Unexpected tool ${params.name}`);
    return respond(fromView ? options.reload ?? 'digest' : options.initialResult ?? 'digest');
  });
  await page.goto('/display-host-test');
  const html = buildPluginShell({ origin: 'https://www.worldmonitor.app', entry: 'plugin.html', root: 'pluginRoot' });
  await page.evaluate(({ html, initialView }) => {
    const frame = document.querySelector('iframe')!;
    const bridge = window as unknown as {
      recordMessage: (message: object) => Promise<void>;
      hostCall: (method: string, params: object, fromView: boolean) => Promise<object>;
    };
    window.addEventListener('message', async event => {
      if (event.source !== frame.contentWindow || event.data?.jsonrpc !== '2.0') return;
      const data = event.data;
      void bridge.recordMessage({ method: data.method, id: data.id, params: data.params });
      if (data.method === 'ui/notifications/initialized') {
        // Deliver the tool input and result the moment the view reports initialized, before its map exists.
        frame.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: initialView } }, '*');
        const result = await bridge.hostCall('tools/call', { name: 'open_news_dashboard', arguments: initialView }, false);
        frame.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }, '*');
        return;
      }
      if (data.id === undefined || !data.method) return;
      try {
        const result = await bridge.hostCall(data.method, data.params, true);
        frame.contentWindow!.postMessage({ jsonrpc: '2.0', id: data.id, result }, '*');
      } catch (error) {
        frame.contentWindow!.postMessage({ jsonrpc: '2.0', id: data.id, error: { code: -32000, message: String(error) } }, '*');
      }
    });
    frame.srcdoc = html.replace('<head>', `<head><base href="${location.origin}/">`);
  }, { html, initialView: options.initialView ?? INITIAL_VIEW });
  return { messages, viewCalls, dataRequests, frame: page.frameLocator('iframe') };
}

async function setHostContext(page: Page, context: Record<string, unknown>, frameSize?: { width: number; height: number }) {
  await page.evaluate(({ context, frameSize }) => {
    const frame = document.querySelector('iframe')!;
    if (frameSize) { frame.style.width = `${frameSize.width}px`; frame.style.height = `${frameSize.height}px`; }
    frame.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: context }, '*');
  }, { context, frameSize });
}

async function enterFullscreen(page: Page, width: number, height: number) {
  await page.setViewportSize({ width: Math.max(width, 400), height: Math.max(height, 400) });
  await setHostContext(page, { displayMode: 'fullscreen', containerDimensions: { width, height } }, { width, height });
}

const sizeChanges = (messages: Message[]) => messages.filter(message => message.method === 'ui/notifications/size-changed').length;

test('a host without fullscreen gets no expand button and content-height sizing', async ({ page }) => {
  const host = await installHost(page, { availableDisplayModes: ['inline'] });
  await expect(host.frame.locator('#panelsGrid')).toContainText(ARTICLE.title);
  await expect(host.frame.getByRole('button', { name: 'Expand' })).toBeHidden();
  await expect.poll(() => sizeChanges(host.messages)).toBeGreaterThan(0);
  const initialize = host.messages.find(message => message.method === 'ui/initialize');
  expect(initialize?.params?.appCapabilities).toEqual({ tools: {}, availableDisplayModes: ['inline', 'fullscreen'] });
});

test('the expand button sends one fullscreen request from the click', async ({ page }) => {
  const host = await installHost(page, { availableDisplayModes: ['inline', 'fullscreen'] });
  const expand = host.frame.getByRole('button', { name: 'Expand' });
  await expect(expand).toBeVisible();
  const box = await expand.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  const actions = await host.frame.locator('#pluginActions > *').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label') ?? node.textContent));
  expect(actions.at(-1)).toBe('Expand');
  await expand.click();
  await expect.poll(() => host.messages.filter(message => message.method === 'ui/request-display-mode').length).toBe(1);
  expect(host.messages.find(message => message.method === 'ui/request-display-mode')?.params).toEqual({ mode: 'fullscreen' });
  await expect(expand).toBeHidden();
});

test('a refused expand request keeps the layout and says so', async ({ page }) => {
  const host = await installHost(page, { availableDisplayModes: ['inline', 'fullscreen'], displayModeAnswer: 'inline' });
  await expect(host.frame.locator('#panelsGrid')).toContainText(ARTICLE.title);
  await host.frame.getByRole('button', { name: 'Expand' }).click();
  await expect(host.frame.locator('#pluginStatus')).toHaveText('Claude kept this view in the conversation.');
  await expect(host.frame.locator('body')).not.toHaveAttribute('data-wm-fill');
  await expect(host.frame.getByRole('button', { name: 'Expand' })).toBeVisible();
});

test('fullscreen at 380 by 700 stacks the map above the news and fills the container', async ({ page }, info) => {
  const host = await installHost(page, { availableDisplayModes: ['inline', 'fullscreen'] });
  await expect(host.frame.locator('#panelsGrid')).toContainText(ARTICLE.title);
  await enterFullscreen(page, 380, 700);
  const body = host.frame.locator('body');
  await expect(body).toHaveAttribute('data-wm-fill', '');
  await expect.poll(() => body.evaluate(element => element.getBoundingClientRect().height)).toBe(700);
  const before = sizeChanges(host.messages);
  const map = await host.frame.locator('#mapSection').boundingBox();
  const panels = await host.frame.locator('#panelsGrid').boundingBox();
  expect(map!.y + map!.height).toBeLessThanOrEqual(panels!.y + 1);
  expect(await body.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await host.frame.locator('#panelsGrid').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  expect(sizeChanges(host.messages)).toBe(before);
  await page.screenshot({ path: info.outputPath('news-fullscreen-380.png') });
});

test('fullscreen at 320 by 600 wraps the action row without horizontal overflow', async ({ page }) => {
  const host = await installHost(page, { availableDisplayModes: ['inline', 'fullscreen'] });
  await expect(host.frame.locator('#panelsGrid')).toContainText(ARTICLE.title);
  await enterFullscreen(page, 320, 600);
  const body = host.frame.locator('body');
  await expect(body).toHaveAttribute('data-wm-fill', '');
  expect(await body.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const rows = await host.frame.locator('#pluginActions > :not([hidden])').evaluateAll(nodes => new Set(nodes.map(node => Math.round(node.getBoundingClientRect().top))).size);
  expect(rows).toBeGreaterThan(1);
  for (const control of await host.frame.locator('#pluginActions > :not([hidden])').all()) {
    const box = await control.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(321);
  }
});

test('fullscreen at 1500 by 800 puts map and news side by side, and inline sizing resumes after', async ({ page }, info) => {
  const host = await installHost(page, { availableDisplayModes: ['inline', 'fullscreen'] });
  await expect(host.frame.locator('#panelsGrid')).toContainText(ARTICLE.title);
  await enterFullscreen(page, 1500, 800);
  const body = host.frame.locator('body');
  await expect.poll(() => body.evaluate(element => element.getBoundingClientRect().height)).toBe(800);
  const map = await host.frame.locator('#mapSection').boundingBox();
  const panels = await host.frame.locator('#panelsGrid').boundingBox();
  expect(Math.abs(map!.y - panels!.y)).toBeLessThan(map!.height);
  expect(panels!.x).toBeGreaterThan(map!.x);
  expect(panels!.y + panels!.height).toBeLessThanOrEqual(801);
  await page.screenshot({ path: info.outputPath('news-fullscreen-1500.png') });
  const before = sizeChanges(host.messages);
  await setHostContext(page, { displayMode: 'inline', containerDimensions: { width: 1100, maxHeight: 6000 } }, { width: 1100, height: 1050 });
  await expect(body).not.toHaveAttribute('data-wm-fill');
  await expect.poll(() => sizeChanges(host.messages)).toBeGreaterThan(before);
  await expect(host.frame.getByRole('button', { name: 'Expand' })).toBeVisible();
});

test('safe-area insets pad the view', async ({ page }) => {
  const host = await installHost(page, { availableDisplayModes: ['inline', 'fullscreen'] });
  await expect(host.frame.locator('#panelsGrid')).toContainText(ARTICLE.title);
  await setHostContext(page, { safeAreaInsets: { top: 12, right: 0, bottom: 20, left: 8 } });
  await expect(host.frame.locator('body')).toHaveCSS('padding-top', '12px');
  await expect(host.frame.locator('body')).toHaveCSS('padding-bottom', '20px');
  await expect(host.frame.locator('body')).toHaveCSS('padding-left', '8px');
});

test('the view reports initialized before loading map data, and a result sent at once still renders', async ({ page }) => {
  const host = await installHost(page);
  await expect(host.frame.locator('#panelsGrid')).toContainText(ARTICLE.title);
  await expect.poll(() => host.dataRequests.length).toBeGreaterThan(0);
  const initialized = host.messages.find(message => message.method === 'ui/notifications/initialized');
  expect(initialized).toBeTruthy();
  expect(initialized!.at).toBeLessThanOrEqual(Math.min(...host.dataRequests));
  expect(host.viewCalls).toEqual([]);
});

test('in-view tools carry titles and short first description lines', async ({ page }) => {
  const host = await installHost(page);
  await expect(host.frame.locator('#panelsGrid')).toContainText(ARTICLE.title);
  const tools = await page.evaluate(() => new Promise<Array<{ name: string; title?: string; description: string }>>(resolve => {
    const frame = document.querySelector('iframe')!.contentWindow!;
    const listener = (event: MessageEvent) => {
      if (event.source !== frame || event.data?.id !== 'list-1') return;
      window.removeEventListener('message', listener);
      resolve(event.data.result.tools);
    };
    window.addEventListener('message', listener);
    frame.postMessage({ jsonrpc: '2.0', id: 'list-1', method: 'tools/list', params: {} }, '*');
  }));
  expect(tools.map(tool => [tool.name, tool.title])).toEqual([['apply_news_view', 'Apply news and map view'], ['focus_news_article', 'Focus a news article']]);
  for (const tool of tools) expect(tool.description.split('\n')[0]!.length).toBeLessThanOrEqual(200);
});

test.describe('digest the host did not deliver', () => {
  test('a result with the digest makes no extra call', async ({ page }) => {
    const host = await installHost(page);
    await expect(host.frame.locator('#panelsGrid')).toContainText(ARTICLE.title);
    await page.waitForTimeout(300);
    expect(host.viewCalls).toEqual([]);
  });

  test('a digest delivered only as text JSON renders without an extra call', async ({ page }) => {
    const host = await installHost(page, { initialResult: 'text' });
    await expect(host.frame.locator('#panelsGrid')).toContainText(ARTICLE.title);
    await page.waitForTimeout(300);
    expect(host.viewCalls).toEqual([]);
  });

  test('a file-pointer result is reloaded once with the original view and no refresh', async ({ page }) => {
    const host = await installHost(page, { initialResult: 'pointer' });
    await expect(host.frame.locator('#panelsGrid')).toContainText(ARTICLE.title);
    expect(host.viewCalls).toEqual([{ name: 'open_news_dashboard', arguments: { country: 'JP' } }]);
  });

  test('later host results without a digest, such as echoes of in-view analysis calls, start no reload and keep the status', async ({ page }) => {
    const host = await installHost(page);
    await expect(host.frame.locator('#panelsGrid')).toContainText(ARTICLE.title);
    await expect(host.frame.locator('.panel-data-badge.live').first()).toBeVisible();
    await host.frame.locator('#pluginStatus').evaluate(element => { element.textContent = 'Fixture coverage warning'; });
    // The MCP Apps interactive phase lets a host echo a view-initiated call's input and result as notifications.
    await page.evaluate(() => {
      const frame = document.querySelector('iframe')!.contentWindow!;
      const echo = (result: object) => {
        frame.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: { headlines: ['Controlled earthquake report in Japan'], mode: 'brief' } } }, '*');
        frame.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }, '*');
      };
      echo({ structuredContent: { summary: 'Fixture summary', model: 'fixture' }, content: [{ type: 'text', text: 'Fixture summary' }] });
      echo({ isError: true, content: [{ type: 'text', text: 'News analysis was denied.' }] });
    });
    await page.waitForTimeout(500);
    expect(host.viewCalls).toEqual([]);
    await expect(host.frame.locator('#panelsGrid')).toContainText(ARTICLE.title);
    await expect(host.frame.locator('#pluginStatus')).toHaveText('Fixture coverage warning');
    await expect(host.frame.locator('.panel-data-badge.cached')).toHaveCount(0);
  });

  test('a refreshed open is reloaded with its request_id so the server reuses that request', async ({ page }) => {
    const host = await installHost(page, { initialResult: 'pointer', initialView: { country: 'JP', refresh: true, request_id: REFRESH_ID } });
    await expect(host.frame.locator('#panelsGrid')).toContainText(ARTICLE.title);
    expect(host.viewCalls).toEqual([{ name: 'open_news_dashboard', arguments: { country: 'JP', refresh: true, request_id: REFRESH_ID } }]);
  });

  test('a refresh without a request_id is not reloaded, since a reload would be charged again', async ({ page }) => {
    const host = await installHost(page, { initialResult: 'pointer', initialView: { country: 'JP', refresh: true } });
    await expect(host.frame.locator('#pluginStatus')).toHaveText('The news feed could not be loaded. Ask for the dashboard again.');
    await page.waitForTimeout(300);
    expect(host.viewCalls).toEqual([]);
  });

  test('without server tools the view says the feed could not be loaded', async ({ page }) => {
    const host = await installHost(page, { initialResult: 'pointer', serverTools: false });
    await expect(host.frame.locator('#pluginStatus')).toHaveText('The news feed could not be loaded. Ask for the dashboard again.');
    expect(host.viewCalls).toEqual([]);
  });

  test('a failed reload is not retried', async ({ page }) => {
    const host = await installHost(page, { initialResult: 'pointer', reload: 'fail' });
    await expect(host.frame.locator('#pluginStatus')).toHaveText('The news feed could not be loaded. Ask for the dashboard again.');
    await page.waitForTimeout(300);
    expect(host.viewCalls).toHaveLength(1);
  });

  test('a reload that also lacks the digest stops after one attempt', async ({ page }) => {
    const host = await installHost(page, { initialResult: 'pointer', reload: 'pointer' });
    await expect(host.frame.locator('#pluginStatus')).toHaveText('The news feed could not be loaded. Ask for the dashboard again.');
    await page.waitForTimeout(300);
    expect(host.viewCalls).toHaveLength(1);
  });

  test('an error result shows the host reason and makes no reload', async ({ page }) => {
    const host = await installHost(page, { initialResult: 'error' });
    await expect(host.frame.locator('#pluginStatus')).toContainText('Daily MCP quota exceeded');
    await page.waitForTimeout(300);
    expect(host.viewCalls).toEqual([]);
  });
});
