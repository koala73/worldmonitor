import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { COUNTRY_RISK_APP_HTML } from '../api/mcp/ui/country-risk-app';
import { buildPluginShell } from '../api/mcp/ui/_plugin-loader';

test.use({ serviceWorkers: 'block' });
type HostCall = { name: string; arguments: Record<string, unknown> };
type NewsInteraction = { kind: string; link: string; title: string; source: string; displayLabel: string };
type NewsContext = { latestInteraction?: NewsInteraction | null; view: Record<string, unknown> };
async function installNewsHost(page: Page, deniedInitially = false, serverTools = true, selectionFixture = false, modelContext = true) {
  const calls: HostCall[] = [];
  const contexts: NewsContext[] = [];
  const methods: string[] = [];
  let snapshot: Record<string, unknown> = {};
  let units = 0;
  let viewUpdates = 0;
  let denied = deniedInitially;
  let failHazards = false;
  let delayRefresh = false;
  let releaseRefresh: () => void = () => {};
  const delayedRefresh = new Promise<void>(resolve => { releaseRefresh = resolve; });
  let delayHazards = false;
  let releaseHazards: () => void = () => {};
  const delayedHazards = new Promise<void>(resolve => { releaseHazards = resolve; });
  const successfulRefreshes = new Set<string>();
  const article = { title: 'Controlled earthquake report in Japan', source: 'Fixture publisher', link: 'https://example.com/news', publishedAt: Date.now(), location: { latitude: 35, longitude: 139 }, isAlert: true };
  let articles = selectionFixture ? [article, { ...article, source: 'Second publisher', link: 'https://example.com/second', location: { latitude: 35, longitude: 70 } }, { ...article, title: 'Tokyo earthquake controlled report', source: 'Approximate publisher', link: 'https://example.com/approximate', location: undefined }, { ...article, title: 'Alternate loaded headline in Brazil', source: 'Repeated URL publisher', link: 'https://example.com/second', location: { latitude: -15, longitude: -47 } }, { ...article, source: 'Same URL publisher', link: 'https://example.com/second', location: { latitude: 30, longitude: 31 } }] : [article];
  await page.route('**/plugin/assets/**', route => route.fulfill({ path: join(process.cwd(), 'dist/plugin/assets', new URL(route.request().url()).pathname.split('/').at(-1)!), headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.route('**/plugin/plugin.html', route => route.fulfill({ path: join(process.cwd(), 'dist/plugin/plugin.html'), headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.route('**/data/*.geojson', route => route.fulfill({ path: join(process.cwd(), 'public/data', new URL(route.request().url()).pathname.split('/').at(-1)!), headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.route('**/data/countries-*m.json', route => route.fulfill({ path: join(process.cwd(), 'public/data', new URL(route.request().url()).pathname.split('/').at(-1)!), headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.route('**/news-host-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>News plugin metering acceptance</title><h1>Built news plugin — controlled host and data</h1><p>Checks rendering and request reuse. Does not test live OAuth, ChatGPT installation or source freshness.</p><iframe title="WorldMonitor news and maps" sandbox="allow-scripts" style="width:100%;height:1050px;border:0"></iframe>' }));
  await page.exposeFunction('newsHost', async (method: string, params: HostCall) => {
    methods.push(method);
    if (method === 'ui/initialize') return { hostCapabilities: { ...(serverTools ? { serverTools: {} } : {}), ...(modelContext ? { updateModelContext: {} } : {}) }, hostContext: { theme: 'dark' } };
    if (method === 'ui/update-model-context') {
      viewUpdates++;
      contexts.push(JSON.parse((params as unknown as { content: Array<{ text: string }> }).content[0]!.text));
    }
    if (method !== 'tools/call') return {};
    calls.push(params);
    if (params.name === 'open_news_dashboard') {
      if (delayRefresh && params.arguments.refresh) await delayedRefresh;
      if (denied) return { isError: true, content: [{ type: 'text', text: 'Daily MCP quota exceeded. Resets at next UTC midnight.' }] };
      const id = String(params.arguments.request_id ?? 'initial');
      if (!successfulRefreshes.has(id)) { units++; successfulRefreshes.add(id); }
      const { refresh: _refresh, request_id: _id, ...requestedView } = params.arguments;
      snapshot = { categories: { world: { items: articles } }, coverage: { state: 'complete', servedStale: false }, requestedView, panelRequest: { panel: 'news', token: `news.controlled-${units}`, expiresAt: new Date(Date.now() + 300000).toISOString(), reused: false, usage: { used: units, limit: 50, remaining: 50 - units, resetsAt: '2026-10-03T00:00:00.000Z', unit: 'requests' } } };
      return { structuredContent: snapshot };
    }
    if (params.name === 'get_natural_disasters') {
      if (delayHazards) await delayedHazards;
      if (failHazards) return { isError: true };
      const quake = { id: 'controlled-quake', place: 'Controlled hazard fixture', magnitude: 5, depthKm: 10, location: { latitude: -45, longitude: -90 }, occurredAt: Date.now(), sourceUrl: 'https://example.com/quake', source: 'Controlled USGS', category: 'earthquake' };
      const fire = { id: 'controlled-fire', location: { latitude: 30, longitude: 35 }, detectedAt: Date.now(), brightness: 350, frp: 12, confidence: 'FIRE_CONFIDENCE_HIGH', region: 'Fixture', dayNight: 'D' };
      return { structuredContent: { data: { earthquakes: { earthquakes: [quake] }, events: { dataAvailable: true, events: [] }, fires: { dataAvailable: true, fireDetections: [fire] } } } };
    }
    throw new Error(`Unexpected tool: ${params.name}`);
  });
  await page.goto('/news-host-test');
  const html = buildPluginShell({ origin: 'https://www.worldmonitor.app', entry: 'plugin.html', root: 'pluginRoot' });
  await page.evaluate(html => {
    const frame = document.querySelector('iframe')!;
    const host = (window as unknown as { newsHost: (method: string, params: object) => Promise<object> }).newsHost;
    window.addEventListener('message', async event => {
      if (event.source !== frame.contentWindow || event.data?.jsonrpc !== '2.0' || !event.data.id || !event.data.method) return;
      const result = await host(event.data.method, event.data.params);
      frame.contentWindow!.postMessage({ jsonrpc: '2.0', id: event.data.id, result }, '*');
      if (event.data.method === 'ui/initialize') {
        const args = { map_layers: ['natural'] };
        frame.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: args } }, '*');
        const result = await host('tools/call', { name: 'open_news_dashboard', arguments: args });
        frame.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }, '*');
      }
    });
    frame.srcdoc = html.replace('<head>', `<head><base href="${location.origin}/">`);
  }, html);
  return { calls, contexts, methods, get snapshot() { return snapshot; }, removeSecondArticle: () => { articles = [article]; }, get units() { return units; }, get viewUpdates() { return viewUpdates; }, deny: () => { denied = true; }, delayRefresh: () => { delayRefresh = true; }, releaseRefresh, delayHazards: () => { delayHazards = true; }, releaseHazards, failHazards: () => { failHazards = true; }, recoverHazards: () => { failHazards = false; } };
}

async function newsAction(page: Page, name: string, args: object) {
  return page.evaluate(({ name, args }) => new Promise<{ isError?: boolean; structuredContent?: NewsContext & { link: string; title: string; source: string; mapFocused: boolean } }>(resolve => {
    const frame = document.querySelector('iframe')!.contentWindow!;
    const id = crypto.randomUUID();
    const listener = (event: MessageEvent) => {
      if (event.source !== frame || event.data?.id !== id || event.data.method) return;
      window.removeEventListener('message', listener);
      resolve(event.data.result);
    };
    window.addEventListener('message', listener);
    frame.postMessage({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, '*');
  }), { name, args });
}

async function useSvgNewsMap(page: Page) {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type: string, ...args: unknown[]) {
      if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') return null;
      return Reflect.apply(original, this, [type, ...args]);
    } as typeof original;
  });
}

test('loaded marker and search interactions retain original identity without data calls or prompts', async ({ page }, info) => {
  await useSvgNewsMap(page);
  const host = await installNewsHost(page, false, true, true);
  const frame = page.frameLocator('iframe');
  const markers = frame.locator('.news-location-marker');
  await expect(frame.locator('#pluginMapStatus')).toContainText('earthquakes: 1 valid');
  await frame.getByRole('checkbox', { name: 'Natural Events' }).uncheck();
  await expect(markers).toHaveCount(5);
  await frame.getByRole('combobox', { name: 'News source' }).selectOption('Second publisher');
  await expect(markers).toHaveCount(1);
  await markers.first().click();
  const expected = { kind: 'news-article', link: 'https://example.com/second', title: 'Controlled earthquake report in Japan', source: 'Second publisher', displayLabel: 'Controlled earthquake report in Japan' };
  await expect.poll(() => host.contexts.at(-1)?.latestInteraction).toEqual(expected);
  await page.screenshot({ path: info.outputPath('latest-news-interaction-desktop.png'), fullPage: true });
  await frame.locator('.popup-close').click();
  await frame.getByRole('combobox', { name: 'News source' }).selectOption('Fixture publisher');
  await expect.poll(() => host.contexts.at(-1)?.latestInteraction).toBeNull();
  await frame.getByRole('combobox', { name: 'News source' }).selectOption('Approximate publisher');
  await expect(markers).toHaveCount(1);
  await expect(markers.first()).toHaveAttribute('title', 'Tokyo earthquake controlled report (approximate location: Tokyo)');
  await markers.first().click();
  await expect.poll(() => host.contexts.at(-1)?.latestInteraction).toMatchObject({ link: 'https://example.com/approximate', title: 'Tokyo earthquake controlled report', displayLabel: 'Tokyo earthquake controlled report (approximate location: Tokyo)' });
  await frame.locator('.popup-close').click();
  await frame.getByRole('button', { name: 'Search news', exact: true }).click();
  await frame.locator('.search-input').fill('Controlled earthquake');
  await frame.locator('.search-result-item[data-index]').filter({ hasText: 'Second publisher' }).click();
  await expect.poll(() => host.contexts.at(-1)?.latestInteraction).toEqual(expected);
  expect(host.contexts.at(-1)?.view).toMatchObject({ category: 'world', time_range: 'all' });
  const action = await newsAction(page, 'focus_news_article', { link: expected.link });
  expect(action.structuredContent).toMatchObject({ applied: true, link: expected.link, title: expected.title, source: expected.source, mapFocused: true, latestInteraction: expected });
  const unknown = await newsAction(page, 'focus_news_article', { link: 'https://example.com/not-loaded' });
  expect(unknown.isError).toBe(true);
  expect(host.contexts.at(-1)?.latestInteraction).toEqual(expected);
  expect(host.calls.map(call => call.name)).toEqual(['open_news_dashboard', 'get_natural_disasters']);
  expect(host.units).toBe(1);
  expect(host.methods).not.toContain('ui/message');
  host.removeSecondArticle();
  await frame.getByRole('button', { name: 'Refresh news', exact: true }).click();
  await expect.poll(() => host.contexts.at(-1)?.latestInteraction).toBeNull();
  await newsAction(page, 'focus_news_article', { link: 'https://example.com/news' });
  await expect.poll(() => host.contexts.at(-1)?.latestInteraction?.link).toBe('https://example.com/news');
  const replacement: Record<string, unknown> = { ...host.snapshot, categories: { world: { items: [] } } };
  delete replacement.requestedView;
  const beforeReplacementCalls = host.calls.length;
  await page.evaluate(structuredContent => {
    document.querySelector('iframe')!.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent } }, '*');
  }, replacement);
  await expect.poll(() => host.contexts.at(-1)?.latestInteraction).toBeNull();
  expect(host.calls).toHaveLength(beforeReplacementCalls);
  await writeFile(info.outputPath('latest-news-interaction-receipts.json'), JSON.stringify({ contexts: host.contexts, calls: host.calls, units: host.units }, null, 2));
});

test('loaded marker clicks need no server or model-context capability', async ({ page }, info) => {
  await page.setViewportSize({ width: 430, height: 1500 });
  await useSvgNewsMap(page);
  const host = await installNewsHost(page, false, false, false, false);
  const frame = page.frameLocator('iframe');
  await frame.locator('.news-location-marker').click();
  await expect(frame.locator('.map-popup')).toBeVisible();
  await expect(frame.locator('.map-popup .popup-body')).toBeInViewport();
  await page.screenshot({ path: info.outputPath('latest-news-interaction-mobile.png'), fullPage: true });
  expect(host.contexts).toEqual([]);
  expect(host.calls.map(call => call.name)).toEqual(['open_news_dashboard']);
  expect(host.methods).not.toContain('ui/message');
});

test('loaded mobile marker selection publishes a receipt in a clean controlled view', async ({ page }, info) => {
  await page.setViewportSize({ width: 430, height: 1500 });
  await useSvgNewsMap(page);
  const host = await installNewsHost(page);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#pluginMapStatus')).toContainText('earthquakes: 1 valid');
  await frame.getByRole('checkbox', { name: 'Natural Events' }).uncheck();
  await expect(frame.locator('#pluginMapStatus')).toBeEmpty();
  await frame.locator('.news-location-marker').click();
  await expect.poll(() => host.contexts.at(-1)?.latestInteraction).toMatchObject({ kind: 'news-article', link: 'https://example.com/news', source: 'Fixture publisher', title: 'Controlled earthquake report in Japan' });
  await expect(frame.locator('#pluginStatus')).toBeEmpty();
  await expect(frame.locator('.map-popup .popup-body')).toBeInViewport();
  await page.screenshot({ path: info.outputPath('latest-news-interaction-mobile-clean.png'), fullPage: true });
  expect(host.calls.map(call => call.name)).toEqual(['open_news_dashboard', 'get_natural_disasters']);
  expect(host.units).toBe(1);
  expect(host.methods).not.toContain('ui/message');
});

test('each marker retains its own loaded item when URLs repeat', async ({ page }) => {
  await useSvgNewsMap(page);
  const host = await installNewsHost(page, false, true, true);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#pluginMapStatus')).toContainText('earthquakes: 1 valid');
  await frame.getByRole('checkbox', { name: 'Natural Events' }).uncheck();
  const markers = frame.locator('.news-location-marker');
  await expect(markers).toHaveCount(5);
  await markers.nth(1).click();
  await expect.poll(() => host.contexts.at(-1)?.latestInteraction).toMatchObject({ link: 'https://example.com/second', title: 'Controlled earthquake report in Japan', source: 'Second publisher' });
  await frame.locator('.popup-close').click();
  await markers.nth(3).click();
  await expect.poll(() => host.contexts.at(-1)?.latestInteraction).toMatchObject({ link: 'https://example.com/second', title: 'Alternate loaded headline in Brazil', source: 'Repeated URL publisher', displayLabel: 'Alternate loaded headline in Brazil' });
  await frame.locator('.popup-close').click();
  await markers.nth(4).click();
  await expect.poll(() => host.contexts.at(-1)?.latestInteraction).toMatchObject({ link: 'https://example.com/second', title: 'Controlled earthquake report in Japan', source: 'Same URL publisher', displayLabel: 'Controlled earthquake report in Japan' });
  expect(host.calls.map(call => call.name)).toEqual(['open_news_dashboard', 'get_natural_disasters']);
  expect(host.methods).not.toContain('ui/message');
});

test('replacement news clears the host interaction even when its hazard reload fails', async ({ page }) => {
  await useSvgNewsMap(page);
  const host = await installNewsHost(page, false, true, true);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#pluginMapStatus')).toContainText('earthquakes: 1 valid');
  await newsAction(page, 'focus_news_article', { link: 'https://example.com/second' });
  await expect.poll(() => host.contexts.at(-1)?.latestInteraction?.link).toBe('https://example.com/second');
  host.removeSecondArticle();
  host.failHazards();
  await frame.getByRole('button', { name: 'Refresh news', exact: true }).click();
  await expect(frame.locator('#pluginStatus')).toContainText('The requested view could not be applied');
  await expect.poll(() => host.contexts.at(-1)?.latestInteraction).toBeNull();
});

test('an older failed hydration cannot clear a newer loaded article interaction', async ({ page }) => {
  await useSvgNewsMap(page);
  const host = await installNewsHost(page, false, true, true);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#pluginMapStatus')).toContainText('earthquakes: 1 valid');
  await newsAction(page, 'focus_news_article', { link: 'https://example.com/second' });
  host.removeSecondArticle();
  host.delayHazards();
  host.failHazards();
  await frame.getByRole('button', { name: 'Refresh news', exact: true }).click();
  await expect.poll(() => host.calls.filter(call => call.name === 'get_natural_disasters').length).toBe(2);
  await expect.poll(() => host.contexts.at(-1)?.latestInteraction).toBeNull();
  const replacement = { ...host.snapshot };
  delete replacement.requestedView;
  await page.evaluate(structuredContent => {
    document.querySelector('iframe')!.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent } }, '*');
  }, replacement);
  await expect.poll(() => host.contexts.at(-1)?.latestInteraction).toBeNull();
  await frame.locator('.news-location-marker').first().click();
  await expect.poll(() => host.contexts.at(-1)?.latestInteraction?.link).toBe('https://example.com/news');
  host.releaseHazards();
  await expect(frame.getByRole('button', { name: 'Refresh news', exact: true })).toBeEnabled();
  expect(host.contexts.at(-1)?.latestInteraction?.link).toBe('https://example.com/news');
  expect(host.calls.map(call => call.name)).toEqual(['open_news_dashboard', 'get_natural_disasters', 'open_news_dashboard', 'get_natural_disasters']);
});

test('news and map hydration share one request, toggles reuse data and refresh charges once', async ({ page }, info) => {
  const host = await installNewsHost(page);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#pluginUsage')).toContainText('49 of 50 requests remaining');
  await expect(frame.locator('#pluginMapStatus')).toContainText('earthquakes: 1 valid');
  await expect(frame.locator('#panelsGrid')).toContainText('Controlled earthquake report in Japan');
  expect(host.calls.map(call => call.name)).toEqual(['open_news_dashboard', 'get_natural_disasters']);
  expect(host.calls[1]?.arguments.panel_request).toBe('news.controlled-1');
  expect(host.units).toBe(1);
  const natural = frame.getByRole('checkbox', { name: 'Natural Events' });
  await natural.uncheck();
  await natural.check();
  await expect(frame.locator('#pluginMapStatus')).toContainText('earthquakes: 1 valid');
  expect(host.calls).toHaveLength(2);
  const fires = frame.getByRole('checkbox', { name: 'Fires', exact: true });
  await fires.check();
  await expect(frame.locator('#pluginMapStatus')).toContainText('fires: 1 valid');
  expect(host.calls).toHaveLength(3);
  expect(host.units).toBe(1);
  await fires.uncheck();
  await fires.check();
  await expect(frame.locator('#pluginMapStatus')).toContainText('fires: 1 valid');
  expect(host.calls).toHaveLength(3);
  await frame.getByRole('button', { name: 'Refresh map data', exact: true }).click();
  await expect(frame.locator('#pluginUsage')).toContainText('48 of 50 requests remaining');
  await expect.poll(() => host.calls.length).toBe(5);
  expect(host.calls.at(-1)?.arguments.panel_request).toBe('news.controlled-2');
  expect(host.units).toBe(2);
  await expect(frame.locator('#mapContainer path.country').first()).toBeAttached();
  await page.screenshot({ path: info.outputPath('news-plugin-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 430, height: 1500 });
  await page.locator('iframe').evaluate(element => { (element as HTMLIFrameElement).style.height = '1300px'; });
  await frame.locator('#panelsGrid').scrollIntoViewIfNeeded();
  await expect(frame.getByText('Controlled earthquake report in Japan', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('news-plugin-mobile.png'), fullPage: true });
  host.deny();
  await frame.getByRole('button', { name: 'Refresh news', exact: true }).click();
  await expect(frame.locator('#pluginStatus')).toContainText('Daily MCP quota exceeded');
  await expect(frame.locator('#panelsGrid')).toContainText('Controlled earthquake report in Japan');
  expect(host.calls).toHaveLength(6);
  expect(host.units).toBe(2);
  await writeFile(info.outputPath('news-request-cost.json'), JSON.stringify({ surface: 'built opaque iframe, controlled host', initialCalls: 2, initialUnits: 1, repeatLayerCalls: 0, newLayerCalls: 1, newLayerUnits: 0, refreshCalls: 2, refreshUnits: 1, deniedRefreshHazardCalls: 0 }, null, 2));
});

test('initial quota denial starts no map loads and displays the host reason', async ({ page }) => {
  const host = await installNewsHost(page, true);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#pluginStatus')).toContainText('Daily MCP quota exceeded');
  await expect(frame.locator('#pluginUsage')).toBeHidden();
  expect(host.calls.map(call => call.name)).toEqual(['open_news_dashboard']);
  expect(host.units).toBe(0);
});

test('a failed map read is retried under the paid request', async ({ page }) => {
  const host = await installNewsHost(page);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#pluginMapStatus')).toContainText('earthquakes: 1 valid');
  host.failHazards();
  await frame.getByRole('checkbox', { name: 'Fires', exact: true }).check();
  await expect(frame.locator('#pluginMapStatus')).toContainText('Hazard access was denied');
  host.recoverHazards();
  await frame.getByRole('checkbox', { name: 'Fires', exact: true }).check();
  await expect(frame.locator('#pluginMapStatus')).toContainText('fires: 1 valid');
  expect(host.calls.filter(call => call.name === 'get_natural_disasters')).toHaveLength(3);
  expect(host.units).toBe(1);
});

test('single-result panels show their paid usage notice without more data calls', async ({ page }, info) => {
  await page.route('**/single-panel-host-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><h1>Single-result panel — controlled host and data</h1><iframe title="Country risk panel" sandbox="allow-scripts" style="width:100%;height:600px;border:0"></iframe>' }));
  await page.goto('/single-panel-host-test');
  await page.evaluate(html => {
    const frame = document.querySelector('iframe')!;
    window.addEventListener('message', event => {
      if (event.source !== frame.contentWindow || event.data?.method !== 'ui/initialize') return;
      frame.contentWindow!.postMessage({ jsonrpc: '2.0', id: event.data.id, result: { hostContext: { theme: 'dark' } } }, '*');
      frame.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: {
        structuredContent: { countryCode: 'US', countryName: 'United States (controlled data)', cii: { combinedScore: 32, components: { unrest: 20, conflict: 30, security: 40, information: 38 } } },
        _meta: { 'worldmonitor/usage': { used: 1, limit: 50, remaining: 49, resetsAt: '2026-10-03T00:00:00.000Z', unit: 'requests' } },
      } }, '*');
    });
    frame.srcdoc = html;
  }, COUNTRY_RISK_APP_HTML);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#panel-usage')).toContainText('49 of 50 requests remaining');
  await expect(frame.locator('#country')).toContainText('United States');
  await page.screenshot({ path: info.outputPath('single-panel-usage-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 430, height: 800 });
  await page.screenshot({ path: info.outputPath('single-panel-usage-mobile.png'), fullPage: true });
});

test('refresh preserves newer filter and layer selections', async ({ page }) => {
  const host = await installNewsHost(page);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#pluginMapStatus')).toContainText('earthquakes: 1 valid');
  host.delayRefresh();
  await frame.getByRole('button', { name: 'Refresh news', exact: true }).click();
  await expect.poll(() => host.calls.filter(call => call.name === 'open_news_dashboard').length).toBe(2);
  await frame.getByRole('checkbox', { name: 'Natural Events' }).uncheck();
  await frame.getByRole('combobox', { name: 'News source' }).selectOption('Fixture publisher');
  await expect(frame.locator('#pluginMapStatus')).toBeEmpty();
  host.releaseRefresh();
  await expect(frame.locator('#pluginUsage')).toContainText('48 of 50 requests remaining');
  await expect(frame.getByRole('checkbox', { name: 'Natural Events' })).not.toBeChecked();
  await expect(frame.getByRole('combobox', { name: 'News source' })).toHaveValue('Fixture publisher');
  expect(host.calls.filter(call => call.name === 'get_natural_disasters')).toHaveLength(1);
});

test('a new host admission reloads inherited active layers with the new token', async ({ page }) => {
  const host = await installNewsHost(page);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#pluginMapStatus')).toContainText('earthquakes: 1 valid');
  await page.evaluate(async () => {
    const host = (window as unknown as { newsHost: (method: string, params: object) => Promise<object> }).newsHost;
    const result = await host('tools/call', { name: 'open_news_dashboard', arguments: { refresh: true, request_id: crypto.randomUUID() } });
    document.querySelector('iframe')!.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }, '*');
  });
  await expect.poll(() => host.calls.filter(call => call.name === 'get_natural_disasters').length).toBe(2);
  expect(host.calls.at(-1)?.arguments.panel_request).toBe('news.controlled-2');
});

test('denied map refresh reports the quota reason in the map status', async ({ page }) => {
  const host = await installNewsHost(page);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#pluginMapStatus')).toContainText('earthquakes: 1 valid');
  host.deny();
  await frame.getByRole('button', { name: 'Refresh map data', exact: true }).click();
  await expect(frame.locator('#pluginMapStatus')).toContainText('Daily MCP quota exceeded');
  expect(host.calls.filter(call => call.name === 'get_natural_disasters')).toHaveLength(1);
});

test('refresh controls are disabled without server tool capability', async ({ page }) => {
  const host = await installNewsHost(page, false, false);
  const frame = page.frameLocator('iframe');
  await expect(frame.getByRole('button', { name: 'Refresh news', exact: true })).toBeDisabled();
  await expect(frame.getByRole('button', { name: 'Refresh map data', exact: true })).toBeDisabled();
  expect(host.calls.map(call => call.name)).toEqual(['open_news_dashboard']);
});

test('a host input is consumed once and cannot restore cleared filters', async ({ page }) => {
  const host = await installNewsHost(page);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#pluginMapStatus')).toContainText('earthquakes: 1 valid');
  await page.evaluate(async () => {
    const host = (window as unknown as { newsHost: (method: string, params: object) => Promise<{ structuredContent?: Record<string, unknown> }> }).newsHost;
    const target = document.querySelector('iframe')!.contentWindow!;
    const args = { source: 'Fixture publisher', map_layers: ['natural'] };
    target.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: args } }, '*');
    const result = await host('tools/call', { name: 'open_news_dashboard', arguments: args });
    delete result.structuredContent!.requestedView;
    target.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }, '*');
  });
  await expect(frame.getByRole('combobox', { name: 'News source' })).toHaveValue('Fixture publisher');
  await frame.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(frame.getByRole('combobox', { name: 'News source' })).toHaveValue('');
  await page.evaluate(async () => {
    const host = (window as unknown as { newsHost: (method: string, params: object) => Promise<{ structuredContent?: Record<string, unknown> }> }).newsHost;
    const result = await host('tools/call', { name: 'open_news_dashboard', arguments: { refresh: true, request_id: crypto.randomUUID() } });
    delete result.structuredContent!.requestedView;
    document.querySelector('iframe')!.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }, '*');
  });
  await expect(frame.locator('#pluginUsage')).toContainText('48 of 50 requests remaining');
  // Each of the three accepted snapshots clears identity, then publishes its applied view.
  await expect.poll(() => host.viewUpdates).toBe(7);
  await expect(frame.getByRole('combobox', { name: 'News source' })).toHaveValue('');
});

test('a delayed older host render cannot commit filters after a newer result', async ({ page }) => {
  const host = await installNewsHost(page);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#pluginMapStatus')).toContainText('earthquakes: 1 valid');
  host.delayHazards();
  await page.evaluate(async () => {
    const host = (window as unknown as { newsHost: (method: string, params: object) => Promise<object> }).newsHost;
    const result = await host('tools/call', { name: 'open_news_dashboard', arguments: { source: 'Fixture publisher', map_layers: ['natural'], refresh: true, request_id: crypto.randomUUID() } });
    document.querySelector('iframe')!.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }, '*');
  });
  await expect.poll(() => host.calls.filter(call => call.name === 'get_natural_disasters').length).toBe(2);
  await page.evaluate(async () => {
    const host = (window as unknown as { newsHost: (method: string, params: object) => Promise<object> }).newsHost;
    const result = await host('tools/call', { name: 'open_news_dashboard', arguments: { refresh: true, request_id: crypto.randomUUID() } });
    document.querySelector('iframe')!.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }, '*');
  });
  await expect(frame.locator('#pluginUsage')).toContainText('47 of 50 requests remaining');
  host.releaseHazards();
  await expect.poll(() => host.calls.filter(call => call.name === 'get_natural_disasters').length).toBe(3);
  await expect.poll(() => host.viewUpdates).toBeGreaterThanOrEqual(2);
  await expect(frame.locator('#pluginMapStatus')).toContainText('earthquakes: 1 valid');
  await expect(frame.getByRole('combobox', { name: 'News source' })).toHaveValue('');
  expect(host.calls.at(-1)?.arguments.panel_request).toBe('news.controlled-3');
});


test('narrow news cards select the initial renderer from input capabilities', async ({ browser }, info) => {
  for (const finePointer of [true, false]) {
    const context = await browser.newContext({
      baseURL: String(info.project.use.baseURL),
      viewport: { width: 600, height: 1100 },
      hasTouch: !finePointer,
      isMobile: !finePointer,
      serviceWorkers: 'block',
    });
    try {
      const page = await context.newPage();
      await page.route(/^https:\/\/(tiles\.openfreemap\.org\/styles\/|basemaps\.cartocdn\.com\/gl\/)/, route => route.fulfill({
        json: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#111111' } }] },
        headers: { 'Access-Control-Allow-Origin': '*' },
      }));
      await page.addInitScript(() => {
        const getExtension = WebGL2RenderingContext.prototype.getExtension;
        WebGL2RenderingContext.prototype.getExtension = function (name) {
          return name === 'WEBGL_debug_renderer_info' ? null : Reflect.apply(getExtension, this, [name]);
        };
      });
      const host = await installNewsHost(page);
      const frame = page.frameLocator('iframe');
      await expect(frame.locator('#pluginUsage')).toContainText('49 of 50 requests remaining');
      expect(await frame.locator('body').evaluate(() => innerWidth)).toBeLessThan(768);
      expect(await frame.locator('body').evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches)).toBe(finePointer);
      await expect(frame.locator('#mapContainer')).toHaveClass(finePointer ? /deckgl-mode/ : /svg-mode/);
      await expect(frame.locator(finePointer ? '.maplibregl-canvas' : 'path.country').first()).toBeAttached();
      await expect(frame.locator('#panelsGrid')).toContainText('Controlled earthquake report in Japan');
      expect(host.calls.map(call => call.name)).toEqual(['open_news_dashboard', 'get_natural_disasters']);
      expect(host.units).toBe(1);
    } finally {
      await context.close();
    }
  }
});
