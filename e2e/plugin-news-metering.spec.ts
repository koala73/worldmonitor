import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { COUNTRY_RISK_APP_HTML } from '../api/mcp/ui/country-risk-app';
import { buildPluginShell } from '../api/mcp/ui/_plugin-loader';

test.use({ serviceWorkers: 'block' });
type HostCall = { name: string; arguments: Record<string, unknown> };
type ViewReceipt = { applied?: boolean; view?: { renderer?: string; source?: string; map_layers?: string[] }; center: { lat: number; lon: number } | null; map: { zoom: number }; renderer?: { mode: string }; viewport?: { settled: boolean; interruptedBy?: string } };
type NewsInteraction = { kind: string; link: string; title: string; source: string; displayLabel: string };
type NewsContext = { applied?: boolean; reason?: string; latestInteraction?: NewsInteraction | null; view: Record<string, unknown>; categoryLabel?: string; center?: { lat: number; lon: number } | null; map?: { zoom: number } };
async function installNewsHost(page: Page, deniedInitially = false, serverTools = true, fixture: boolean | string[] | 'blank-search' | 'windowed-search' = false, modelContext = true, observeCamera = false, initialView: Record<string, unknown> = { map_layers: ['natural'] }, observeRenderer = false, admissionExpiresAt?: string, observeSearch = true) {
  const selectionFixture = fixture === true;
  const blankSearch = fixture === 'blank-search' || fixture === 'windowed-search';
  let categoryIds = Array.isArray(fixture) ? fixture : blankSearch ? ['world', 'financial'] : ['world'];
  const calls: HostCall[] = [];
  const contexts: NewsContext[] = [];
  const methods: string[] = [];
  let snapshot: Record<string, unknown> = {};
  let units = 0;
  let viewUpdates = 0;
  const viewReceipts: ViewReceipt[] = [];
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
  if (blankSearch) articles = [{ ...article, title: 'Unlinked selection headline', source: 'First publisher', link: '', location: undefined }, { ...article, title: 'Unlinked selection headline', source: 'Second publisher', link: '', location: undefined }, { ...article, title: 'Linked control headline', location: undefined }];
  if (fixture === 'windowed-search') articles = [...Array.from({ length: 23 }, (_, index) => ({ ...article, title: `Qzx${index} Vbn${index} Plo${index}`, source: `Window publisher ${index}`, link: `https://example.com/filler/${index}`, publishedAt: Date.now() + index * 1000, location: undefined })), ...articles.slice(0, 2)];
  await page.route('**/plugin/assets/**', async route => {
    const assetName = new URL(route.request().url()).pathname.split('/').at(-1)!;
    const path = join(process.cwd(), 'dist/plugin/assets', assetName);
    const headers = { 'Access-Control-Allow-Origin': '*' };
    if (blankSearch && observeSearch && assetName.startsWith('plugin-') && assetName.endsWith('.js')) {
      const source = await readFile(path, 'utf8');
      const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const classes: Record<string, string> = {};
      const visit = (node: ts.Node) => {
        if (ts.isClassDeclaration(node) && node.name) {
          for (const member of node.members) {
            if (member.name && ts.isIdentifier(member.name)) classes[member.name.text] = node.name.text;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
      for (const method of ['registerSource', 'renderNews', 'setNewsLocations']) expect(classes[method]).toBeTruthy();
      const observation = `
        const register = ${classes.registerSource}.prototype.registerSource;
        ${classes.registerSource}.prototype.registerSource = function(...args) {
          globalThis.__newsSearch = this;
          return register.apply(this, args);
        };
        const render = ${classes.renderNews}.prototype.renderNews;
        ${classes.renderNews}.prototype.renderNews = function(...args) {
          (globalThis.__newsPanels ??= new Map()).set(this.panelId, this);
          return render.apply(this, args);
        };
        const locations = ${classes.setNewsLocations}.prototype.setNewsLocations;
        ${classes.setNewsLocations}.prototype.setNewsLocations = function(...args) {
          globalThis.__newsMap = this;
          return locations.apply(this, args);
        };`;
      return route.fulfill({ body: source + observation, contentType: 'text/javascript', headers });
    }
    if (observeRenderer && assetName.startsWith('plugin-') && assetName.endsWith('.js')) {
      const source = await readFile(path, 'utf8');
      const binding = /([$\w]+)\.onCountryClicked\(([$\w]+)=>/;
      expect(source.match(binding)).toBeTruthy();
      return route.fulfill({ body: source.replace(binding, '(globalThis.__newsMap=$1).onCountryClicked($2=>'), contentType: 'text/javascript', headers });
    }
    if (!observeCamera || !assetName.startsWith('GlobeMap-')) return route.fulfill({ path, headers });
    const source = await readFile(path, 'utf8');
    const exportedClass = source.match(/export\s*\{\s*([$\w]+)\s+as\s+GlobeMap/)?.[1];
    expect(exportedClass).toBeTruthy();
    // Observe the real compiled movement without changing its target or timing.
    const observation = `
      const originalSetCenter = ${exportedClass}.prototype.setCenter;
      ${exportedClass}.prototype.setCenter = function(...args) {
        globalThis.__newsCamera = this;
        return originalSetCenter.apply(this, args);
      };
      const originalSettlement = ${exportedClass}.prototype.whenViewportSettled;
      ${exportedClass}.prototype.whenViewportSettled = async function() {
        const settled = await originalSettlement.call(this);
        if (!settled) globalThis.__newsInterruptionObserved = true;
        return settled;
      };
      const originalGetCenter = ${exportedClass}.prototype.getCenter;
      ${exportedClass}.prototype.getCenter = function() {
        const center = originalGetCenter.call(this);
        if (globalThis.__newsInterruptionObserved) globalThis.__newsInterruptedCenter = center;
        return center;
      };`;
    return route.fulfill({ body: source + observation, contentType: 'text/javascript', headers });
  });
  await page.route('**/plugin/plugin.html', route => route.fulfill({ path: join(process.cwd(), 'dist/plugin/plugin.html'), headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.route('**/data/*.geojson', route => route.fulfill({ path: join(process.cwd(), 'public/data', new URL(route.request().url()).pathname.split('/').at(-1)!), headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.route('**/data/countries-*m.json', route => route.fulfill({ path: join(process.cwd(), 'public/data', new URL(route.request().url()).pathname.split('/').at(-1)!), headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.route('**/news-host-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>News plugin metering acceptance</title><h1>Built news plugin — controlled host and data</h1><p>Checks rendering and request reuse. Does not test live OAuth, ChatGPT installation or source freshness.</p><iframe title="WorldMonitor news and maps" sandbox="allow-scripts" style="width:100%;height:1050px;border:0"></iframe>' }));
  await page.exposeFunction('newsHost', async (method: string, params: HostCall) => {
    methods.push(method);
    if (method === 'ui/initialize') return { hostCapabilities: { ...(serverTools ? { serverTools: {} } : {}), ...(modelContext ? { updateModelContext: {} } : {}) }, hostContext: { theme: 'dark' } };
    if (method === 'ui/update-model-context') {
      viewUpdates++;
      const receipt = JSON.parse((params as unknown as { content: Array<{ text: string }> }).content[0]!.text);
      contexts.push(receipt);
      viewReceipts.push(receipt as ViewReceipt);
    }
    if (method !== 'tools/call') return {};
    calls.push(params);
    if (params.name === 'open_news_dashboard') {
      if (delayRefresh && params.arguments.refresh) await delayedRefresh;
      if (denied) return { isError: true, content: [{ type: 'text', text: 'Daily MCP quota exceeded. Resets at next UTC midnight.' }] };
      const id = String(params.arguments.request_id ?? 'initial');
      if (!successfulRefreshes.has(id)) { units++; successfulRefreshes.add(id); }
      const { refresh: _refresh, request_id: _id, ...requestedView } = params.arguments;
      snapshot = { categories: Object.fromEntries(categoryIds.map((category, index) => [category, { items: index === 0 ? articles : blankSearch ? [{ ...articles.find(item => item.source === 'Second publisher')! }, { ...article, title: 'Unrelated hidden headline', source: 'Hidden publisher', link: '', location: undefined }] : [] }])), coverage: { state: 'complete', servedStale: false }, requestedView, panelRequest: { panel: 'news', token: `news.controlled-${units}`, expiresAt: admissionExpiresAt ?? new Date(Date.now() + 300000).toISOString(), reused: false, usage: { used: units, limit: 50, remaining: 50 - units, resetsAt: '2026-10-03T00:00:00.000Z', unit: 'requests' } } };
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
  await page.evaluate(({ html, initialView }) => {
    const frame = document.querySelector('iframe')!;
    const host = (window as unknown as { newsHost: (method: string, params: object) => Promise<object> }).newsHost;
    window.addEventListener('message', async event => {
      if (event.source !== frame.contentWindow || event.data?.jsonrpc !== '2.0' || !event.data.id || !event.data.method) return;
      const result = await host(event.data.method, event.data.params);
      frame.contentWindow!.postMessage({ jsonrpc: '2.0', id: event.data.id, result }, '*');
      if (event.data.method === 'ui/initialize') {
        const args = initialView;
        frame.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: args } }, '*');
        const result = await host('tools/call', { name: 'open_news_dashboard', arguments: args });
        frame.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }, '*');
      }
    });
    frame.srcdoc = html.replace('<head>', `<head><base href="${location.origin}/">`);
  }, { html, initialView });
  return { calls, contexts, methods, viewReceipts, get snapshot() { return snapshot; }, setCategories: (keys: string[]) => { categoryIds = keys; }, removeSecondArticle: () => { articles = [article]; }, get units() { return units; }, get viewUpdates() { return viewUpdates; }, deny: () => { denied = true; }, delayRefresh: () => { delayRefresh = true; }, releaseRefresh, delayHazards: () => { delayHazards = true; }, releaseHazards, failHazards: () => { failHazards = true; }, recoverHazards: () => { failHazards = false; } };
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
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') return null;
      return Reflect.apply(original, this, [type, ...args]);
    } as typeof original;
  });
}

for (const expired of [false, true]) {
  test(`Search reveals the exact second blank-link article with ${expired ? 'past' : 'future'} admission`, async ({ page }, info) => {
    await useSvgNewsMap(page);
    const host = await installNewsHost(page, false, true, 'blank-search', true, false, { map_layers: [] }, false, new Date(Date.now() + (expired ? -60_000 : 300_000)).toISOString());
    const frame = page.frameLocator('iframe');
    await expect(frame.getByRole('combobox', { name: 'News source' })).toBeVisible();
    await frame.getByRole('combobox', { name: 'News category' }).selectOption('world');
    await frame.locator('body').evaluate(() => {
      const panels = (globalThis as unknown as { __newsPanels: Map<string, { clusteredMode: boolean }> }).__newsPanels;
      for (const panel of panels.values()) panel.clusteredMode = false;
    });
    await frame.getByRole('combobox', { name: 'News source' }).selectOption('First publisher');
    await frame.getByRole('combobox', { name: 'News source' }).selectOption('');
    const calls = host.calls.length;
    const navigations: string[] = [];
    page.on('popup', popup => navigations.push(popup.url()));
    const location = page.url();
    await frame.getByRole('button', { name: 'Search news', exact: true }).click();
    await frame.locator('.search-input').fill('Second publisher');
    await expect(frame.locator('.search-result-item[data-index]')).toHaveCount(1);
    await frame.locator('.search-result-item[data-index]').filter({ hasText: 'Second publisher' }).click();
    const expected = { kind: 'news-article', link: '', title: 'Unlinked selection headline', source: 'Second publisher', displayLabel: 'Unlinked selection headline' };
    await expect.poll(() => host.contexts.at(-1)?.latestInteraction).toEqual(expected);
    const selected = frame.locator('.panel:not([hidden]) .item').filter({ has: frame.locator('.item-source', { hasText: 'Second publisher' }) });
    await expect(selected).toHaveClass(/search-highlight/);
    await expect(selected).toBeInViewport();
    await expect(selected.locator('span.item-title')).toHaveText(expected.title);
    await expect(selected.locator('.item-title')).not.toHaveAttribute('href');
    await expect(frame.locator('.item').filter({ has: frame.locator('.item-source', { hasText: 'First publisher' }) })).not.toHaveClass(/search-highlight/);
    await expect(frame.locator('.panel[hidden] .search-highlight')).toHaveCount(0);
    const beforeBlankTool = JSON.parse(JSON.stringify(host.contexts));
    expect((await newsAction(page, 'focus_news_article', { link: '' })).isError).toBe(true);
    expect(host.contexts).toEqual(beforeBlankTool);
    await frame.getByRole('button', { name: 'Search news', exact: true }).click();
    await frame.locator('.search-input').fill('Linked control headline');
    await frame.locator('.search-result-item[data-index]').click();
    await expect.poll(() => host.contexts.at(-1)?.latestInteraction?.link).toBe('https://example.com/news');
    expect(host.calls).toHaveLength(calls);
    expect(host.calls.map(call => call.name)).toEqual(['open_news_dashboard']);
    expect(host.methods).not.toContain('ui/message');
    expect(page.url()).toBe(location);
    expect(navigations).toEqual([]);
    await writeFile(info.outputPath('blank-search-selection.json'), JSON.stringify({ contexts: host.contexts, calls: host.calls, expired, navigations }, null, 2));
    await page.screenshot({ path: info.outputPath('blank-search-selected.png'), fullPage: true });
  });
}

for (const width of [1280, 390]) {
test(`Search reveals the secondary blank-link member at row 23 in a windowed panel at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1200 });
  await useSvgNewsMap(page);
  const host = await installNewsHost(page, false, true, 'windowed-search', true, false, { map_layers: [] });
  const frame = page.frameLocator('iframe');
  await expect(frame.getByRole('combobox', { name: 'News source' })).toBeVisible();
  await frame.getByRole('combobox', { name: 'News category' }).selectOption('world');
  await expect.poll(() => frame.locator('body').evaluate(() => {
    const probe = globalThis as unknown as { __newsPanels: Map<string, { lastRawClusters: Array<{ allItems: Array<{ source: string }> }> | null }> };
    return probe.__newsPanels.get('world')?.lastRawClusters?.length;
  })).toBe(24);
  const target = await frame.locator('body').evaluate(() => {
    const probe = globalThis as unknown as { __newsPanels: Map<string, { lastRawClusters: Array<{ id: string; allItems: Array<{ source: string }> }> }> };
    const clusters = probe.__newsPanels.get('world')!.lastRawClusters;
    const index = clusters.findIndex(cluster => cluster.allItems.some(item => item.source === 'Second publisher'));
    return { id: clusters[index]!.id, index };
  });
  expect(target.index).toBe(23);
  const beforeCalls = host.calls.length;
  await frame.getByRole('button', { name: 'Search news', exact: true }).click();
  await frame.locator('.search-input').fill('Second publisher');
  await frame.locator('.search-result-item[data-index]').click();
  await expect.poll(() => host.contexts.at(-1)?.latestInteraction).toMatchObject({ link: '', title: 'Unlinked selection headline', source: 'Second publisher' });
  const row = frame.locator('.panel:not([hidden]) .item.clustered').filter({ has: frame.locator('.item-title', { hasText: 'Unlinked selection headline' }) });
  await expect(row).toHaveAttribute('data-cluster-id', target.id);
  await expect(row).toHaveClass(/search-highlight/);
  await expect(row).toBeInViewport();
  await expect.poll(() => row.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const clip = element.closest('.panel-content')!.getBoundingClientRect();
    return bounds.top >= clip.top && bounds.bottom <= clip.bottom;
  })).toBe(true);
  await expect(row.locator('..')).toHaveAttribute('data-chunk', '2');
  await expect(frame.locator('.panel[hidden] .search-highlight')).toHaveCount(0);
  expect(host.calls).toHaveLength(beforeCalls);
  await page.screenshot({ path: info.outputPath('windowed-search-row-23.png'), fullPage: true });
  await writeFile(info.outputPath('windowed-search-row-23.json'), JSON.stringify({ target, contexts: host.contexts, calls: host.calls }, null, 2));
});
}

for (const guard of ['stale', 'not-visible', 'generation', 'settlement-failure'] as const) {
  test(`Search retains the ${guard} selection guard for blank-link articles`, async ({ page }, info) => {
    await useSvgNewsMap(page);
    const host = await installNewsHost(page, false, true, 'blank-search', true, false, { map_layers: [] });
    const frame = page.frameLocator('iframe');
    await expect(frame.getByRole('combobox', { name: 'News source' })).toBeVisible();
    const before = JSON.parse(JSON.stringify(host.contexts));
    let newerRefusal: ReturnType<typeof newsAction> | undefined;
    await frame.locator('body').evaluate((_, guard) => {
      type Article = { link: string; title: string; source: string; lat?: number; lon?: number };
      const probe = globalThis as unknown as {
        __newsSearch: { sources: Array<{ type: string; items: Array<{ id: string; data: Article }> }>; onSelect: (result: { id: string; data: Article }) => void };
        __newsMap: { whenViewportSettled: (...args: unknown[]) => Promise<unknown> };
        __selectedArticle: Article; __searchAwaiting: boolean; __releaseSearch: () => void;
      };
      const result = probe.__newsSearch.sources.find(source => source.type === 'news')!.items.find(item => item.data.source === 'Second publisher')!;
      if (guard === 'stale') { probe.__newsSearch.onSelect({ ...result, data: { ...result.data } }); return; }
      probe.__selectedArticle = result.data;
      result.data.lat = 0; result.data.lon = 0;
      const original = probe.__newsMap.whenViewportSettled.bind(probe.__newsMap);
      probe.__newsMap.whenViewportSettled = async (...args) => {
        const settled = await original(...args);
        probe.__searchAwaiting = true;
        await new Promise<void>(resolve => { probe.__releaseSearch = resolve; });
        if (guard === 'settlement-failure') throw new Error('Controlled map settlement failure');
        return settled;
      };
    }, guard);
    if (guard !== 'stale') {
      await frame.getByRole('button', { name: 'Search news', exact: true }).click();
      await frame.locator('.search-input').fill('Second publisher');
      await frame.locator('.search-result-item[data-index]').click();
      await expect.poll(() => frame.locator('body').evaluate(() => Boolean((globalThis as unknown as { __searchAwaiting: boolean }).__searchAwaiting))).toBe(true);
      if (guard === 'generation') {
        const replacement = { ...host.snapshot };
        delete replacement.requestedView;
        await page.evaluate(structuredContent => document.querySelector('iframe')!.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent } }, '*'), replacement);
        await expect.poll(() => host.contexts.length).toBeGreaterThan(before.length);
        newerRefusal = newsAction(page, 'apply_news_view', { category: 'Not loaded' });
      }
      await frame.locator('body').evaluate((_, guard) => {
        const probe = globalThis as unknown as { __selectedArticle: { source: string }; __releaseSearch: () => void };
        if (guard === 'not-visible') probe.__selectedArticle.source = 'No longer visible';
        probe.__releaseSearch();
      }, guard);
    }
    await expect(frame.locator('#pluginStatus')).toHaveText('The article location could not be applied.');
    if (newerRefusal) {
      expect((await newerRefusal).structuredContent).toMatchObject({ applied: false, reason: 'unknown_category' });
      expect(host.contexts.at(-1)?.reason).toBe('unknown_category');
    }
    expect(host.contexts.every(context => !context.latestInteraction)).toBe(true);
    if (guard === 'stale') expect(host.contexts).toEqual(before);
    const refused = await newsAction(page, 'apply_news_view', { category: 'Not loaded' });
    expect(refused.structuredContent).toMatchObject({ applied: false, reason: 'unknown_category', latestInteraction: null });
    expect(host.contexts.at(-1)?.reason).toBe('unknown_category');
    expect(host.calls.map(call => call.name)).toEqual(['open_news_dashboard']);
    await writeFile(info.outputPath(`blank-search-${guard}.json`), JSON.stringify({ contexts: host.contexts, calls: host.calls }, null, 2));
  });
}

test('blank-link markers retain exact loaded and visible membership checks', async ({ page }, info) => {
  await useSvgNewsMap(page);
  const host = await installNewsHost(page, false, true, 'blank-search', true, false, { map_layers: [] });
  const frame = page.frameLocator('iframe');
  await expect(frame.getByRole('combobox', { name: 'News source' })).toBeVisible();
  const replacement = JSON.parse(JSON.stringify(host.snapshot));
  delete replacement.requestedView;
  replacement.categories.world.items[1].location = { latitude: 10, longitude: 20 };
  await page.evaluate(structuredContent => document.querySelector('iframe')!.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent } }, '*'), replacement);
  await frame.getByRole('combobox', { name: 'News source' }).selectOption('Second publisher');
  await expect(frame.locator('.news-location-marker')).toHaveCount(1);
  const beforeInvalid = host.contexts.length;
  await frame.locator('body').evaluate(() => {
    const probe = globalThis as unknown as { __newsMap: { cachedOnNewsClicked: (item: object) => void } };
    probe.__newsMap.cachedOnNewsClicked({ title: 'Unlinked selection headline', article: { link: '', title: 'Unlinked selection headline', source: 'Not loaded' } });
  });
  expect(host.contexts).toHaveLength(beforeInvalid);
  await frame.locator('.news-location-marker').click();
  await expect.poll(() => host.contexts.at(-1)?.latestInteraction).toMatchObject({ link: '', title: 'Unlinked selection headline', source: 'Second publisher' });
  expect(host.calls.map(call => call.name)).toEqual(['open_news_dashboard']);
  await writeFile(info.outputPath('blank-marker-membership.json'), JSON.stringify({ contexts: host.contexts, calls: host.calls }, null, 2));
});

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

for (const scenario of [
  { keys: ['politics', 'fixture'], requested: 'politics', selected: 'politics', label: 'World News' },
  { keys: ['politics', 'fixture'], requested: '  wOrLd NeWs  ', selected: 'politics', label: 'World News' },
  { keys: ['future-topic', 'fixture'], requested: ' FUTURE-TOPIC ', selected: 'future-topic', label: 'future-topic' },
  { keys: ['world', 'politics'], requested: 'world', selected: 'world', label: 'world' },
  { keys: ['World News', 'politics'], requested: 'World News', selected: 'World News', label: 'World News' },
]) {
  test(`loaded category identity resolves ${JSON.stringify(scenario.requested)} against ${scenario.keys.join(',')}`, async ({ page }) => {
    await useSvgNewsMap(page);
    const host = await installNewsHost(page, false, true, scenario.keys, true, false, {});
    const frame = page.frameLocator('iframe');
    await expect(frame.locator('.news-location-marker')).toHaveCount(1);
    const receipt = await newsAction(page, 'apply_news_view', { category: scenario.requested });
    expect(receipt.structuredContent).toMatchObject({ applied: true, view: { category: scenario.selected }, categoryLabel: scenario.label });
    await expect(frame.getByRole('combobox', { name: 'News category' })).toHaveValue(scenario.selected);
    await expect(frame.locator('[data-panel]').filter({ visible: true })).toHaveCount(1);
    await expect(frame.locator('.news-location-marker')).toHaveCount(1);
    expect(host.calls.map(call => call.name)).toEqual(['open_news_dashboard']);
    expect(host.units).toBe(1);
  });
}

for (const mobile of [false, true]) {
  test(`unknown initial category retains All with persistent refusal on ${mobile ? 'mobile' : 'desktop'}`, async ({ page }, info) => {
    if (mobile) await page.setViewportSize({ width: 430, height: 1500 });
    await useSvgNewsMap(page);
    const host = await installNewsHost(page, false, true, ['politics', 'fixture'], true, false, { category: 'world', map_layers: ['natural'], time_range: '1h', map_latitude: -30, map_longitude: -60 });
    const frame = page.frameLocator('iframe');
    await expect.poll(() => host.contexts.at(-1)).toMatchObject({ applied: false, reason: 'unknown_category', categoryLabel: 'All news panels', view: { time_range: 'all' } });
    await expect(frame.getByRole('combobox', { name: 'News category' })).toHaveValue('');
    await expect(frame.locator('[data-panel]').filter({ visible: true })).toHaveCount(2);
    await expect(frame.locator('.news-location-marker')).toHaveCount(1);
    await expect(frame.locator('#pluginCategoryNotice')).toContainText('world');
    await expect(frame.locator('path.country').first()).toBeAttached();
    await page.screenshot({ path: info.outputPath('category-initial-refusal.png'), fullPage: true });
    await newsAction(page, 'apply_news_view', { source: 'Fixture publisher' });
    await expect(frame.locator('#pluginCategoryNotice')).toBeVisible();
    await frame.getByRole('combobox', { name: 'News category' }).selectOption('politics');
    await expect(frame.locator('#pluginCategoryNotice')).toBeHidden();
    await expect(frame.getByRole('combobox', { name: 'News category' }).locator('option:checked')).toHaveText('World News');
    await page.screenshot({ path: info.outputPath('category-initial-recovered.png'), fullPage: true });
    expect(host.calls.map(call => call.name)).toEqual(['open_news_dashboard']);
    expect(host.units).toBe(1);
    await writeFile(info.outputPath('category-initial-receipts.json'), JSON.stringify({ contexts: host.contexts, calls: host.calls }, null, 2));
  });
}

test('unknown loaded category refuses the whole patch and preserves human camera and article selection', async ({ page }, info) => {
  await useSvgNewsMap(page);
  const host = await installNewsHost(page, false, true, ['politics', 'fixture'], true, false, {});
  const frame = page.frameLocator('iframe');
  await frame.getByRole('combobox', { name: 'News category' }).selectOption('politics');
  await frame.locator('.news-location-marker').click();
  await expect.poll(() => host.contexts.at(-1)?.latestInteraction?.link).toBe('https://example.com/news');
  const beforeDrag = (await newsAction(page, 'apply_news_view', {})).structuredContent!;
  const mapBox = await frame.locator('.map-svg').boundingBox();
  expect(mapBox).not.toBeNull();
  await page.mouse.move(mapBox!.x + mapBox!.width / 2, mapBox!.y + mapBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(mapBox!.x + mapBox!.width / 2 + 80, mapBox!.y + mapBox!.height / 2 + 30, { steps: 8 });
  await page.mouse.up();
  const before = (await newsAction(page, 'apply_news_view', {})).structuredContent!;
  expect(Math.abs(before.center!.lon - beforeDrag.center!.lon)).toBeGreaterThan(1);
  const popupsBefore = await frame.locator('.map-popup').count();
  const receipt = (await newsAction(page, 'apply_news_view', { category: 'missing', source: 'Unapplied publisher', country: 'BR', time_range: '1h', map_layers: ['fires'], renderer: 'globe', map_latitude: -20, map_longitude: 50, map_zoom: 8, query: 'Unapplied search' })).structuredContent!;
  expect(receipt).toMatchObject({ applied: false, reason: 'unknown_category', view: before.view, categoryLabel: 'World News', latestInteraction: before.latestInteraction, center: before.center, map: before.map });
  await expect(frame.getByRole('combobox', { name: 'News category' })).toHaveValue('politics');
  await expect(frame.getByRole('combobox', { name: 'News source' })).toHaveValue('');
  await expect(frame.locator('.search-modal')).toBeHidden();
  await expect(frame.locator('.map-popup')).toHaveCount(popupsBefore);
  await expect(frame.locator('.news-location-marker')).toHaveCount(1);
  await expect(frame.locator('#pluginCategoryNotice')).toContainText('missing');
  await page.screenshot({ path: info.outputPath('category-followup-refusal.png'), fullPage: true });
  await frame.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(frame.locator('#pluginCategoryNotice')).toBeHidden();
  await expect(frame.getByRole('combobox', { name: 'News category' })).toHaveValue('');
  await page.screenshot({ path: info.outputPath('category-followup-cleared.png'), fullPage: true });
  expect(host.calls.map(call => call.name)).toEqual(['open_news_dashboard']);
  expect(host.units).toBe(1);
  await writeFile(info.outputPath('category-atomic-receipts.json'), JSON.stringify({ before, receipt, calls: host.calls }, null, 2));
});

test('ambiguous loaded category refuses while exact keys still win', async ({ page }) => {
  await useSvgNewsMap(page);
  const host = await installNewsHost(page, false, true, ['politics', 'World News'], true, false, {});
  const frame = page.frameLocator('iframe');
  await frame.getByRole('combobox', { name: 'News category' }).selectOption('politics');
  const receipt = await newsAction(page, 'apply_news_view', { category: ' world news ', map_layers: ['fires'] });
  expect(receipt.structuredContent).toMatchObject({ applied: false, reason: 'ambiguous_category', view: { category: 'politics' }, categoryLabel: 'World News' });
  await expect(frame.locator('#pluginCategoryNotice')).toContainText('more than one');
  await expect(frame.getByRole('combobox', { name: 'News category' })).toHaveValue('politics');
  const exact = await newsAction(page, 'apply_news_view', { category: 'World News' });
  expect(exact.structuredContent).toMatchObject({ applied: true, view: { category: 'World News' } });
  await expect(frame.locator('#pluginCategoryNotice')).toBeHidden();
  expect(host.calls.map(call => call.name)).toEqual(['open_news_dashboard']);
});

test('refresh keeps newer human category and discloses removal before rendering All', async ({ page }) => {
  await useSvgNewsMap(page);
  const host = await installNewsHost(page, false, true, ['politics', 'fixture'], true, false, {});
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('.news-location-marker')).toHaveCount(1);
  host.delayRefresh();
  await frame.getByRole('button', { name: 'Refresh news', exact: true }).click();
  await frame.getByRole('combobox', { name: 'News category' }).selectOption('fixture');
  host.releaseRefresh();
  await expect(frame.locator('#pluginUsage')).toContainText('48 of 50 requests remaining');
  await expect(frame.getByRole('combobox', { name: 'News category' })).toHaveValue('fixture');
  host.setCategories(['politics']);
  await frame.getByRole('button', { name: 'Refresh news', exact: true }).click();
  await expect(frame.locator('#pluginUsage')).toContainText('47 of 50 requests remaining');
  await expect(frame.getByRole('combobox', { name: 'News category' })).toHaveValue('');
  await expect(frame.locator('[data-panel="politics"]')).toBeVisible();
  await expect(frame.locator('.news-location-marker')).toHaveCount(1);
  await expect(frame.locator('#pluginCategoryNotice')).toContainText('fixture');
  await expect(frame.locator('#pluginCategoryNotice')).toContainText('no longer loaded');
  await expect.poll(() => host.contexts.at(-1)?.categoryLabel).toBe('All news panels');
  expect(host.contexts.at(-1)?.view.category).toBeUndefined();
  expect(host.calls.map(call => call.name)).toEqual(['open_news_dashboard', 'open_news_dashboard', 'open_news_dashboard']);
  expect(host.units).toBe(3);
});

for (const mobile of [false, true]) {
  test(`pending category removed during hazard loading refuses before view effects on ${mobile ? 'mobile' : 'desktop'}`, async ({ page }, info) => {
    if (mobile) await page.setViewportSize({ width: 430, height: 1500 });
    await useSvgNewsMap(page);
    const host = await installNewsHost(page, false, true, ['politics', 'fixture'], true, false, {});
    const frame = page.frameLocator('iframe');
    await expect(frame.locator('.news-location-marker')).toHaveCount(1);
    const before = (await newsAction(page, 'apply_news_view', {})).structuredContent!;
    host.delayHazards();
    const pending = newsAction(page, 'apply_news_view', { category: ' World News ', source: 'Unapplied publisher', country: 'BR', time_range: '1h', map_layers: ['fires'], map_latitude: -20, map_longitude: 50, map_zoom: 8, query: 'Unapplied search' });
    await expect.poll(() => host.calls.filter(call => call.name === 'get_natural_disasters').length).toBe(1);
    host.setCategories(['fixture']);
    await frame.getByRole('button', { name: 'Refresh news', exact: true }).click();
    await expect(frame.locator('#pluginUsage')).toContainText('48 of 50 requests remaining');
    await expect(frame.getByRole('combobox', { name: 'News category' }).locator('option[value="politics"]')).toHaveCount(0);
    await expect(frame.locator('[data-panel="fixture"]')).toContainText('Controlled earthquake report in Japan');
    host.releaseHazards();
    const receipt = (await pending).structuredContent!;
    await writeFile(info.outputPath('category-pending-removal-receipts.json'), JSON.stringify({ before, receipt, calls: host.calls }, null, 2));
    expect(receipt).toMatchObject({ applied: false, reason: 'unknown_category', view: before.view, categoryLabel: 'All news panels', center: before.center, map: before.map });
    expect(receipt.view).toEqual(before.view);
    await expect(frame.getByRole('button', { name: 'Refresh news', exact: true })).toBeEnabled();
    await expect(frame.getByRole('combobox', { name: 'News category' })).toHaveValue('');
    await expect(frame.getByRole('combobox', { name: 'News source' })).toHaveValue('');
    await expect(frame.getByRole('button', { name: 'Select a country for its brief', exact: true })).toBeDisabled();
    await expect(frame.getByRole('checkbox', { name: 'Fires', exact: true })).not.toBeChecked();
    await expect(frame.locator('.search-modal')).toBeHidden();
    await expect(frame.locator('.news-location-marker')).toHaveCount(1);
    await expect(frame.locator('#pluginCategoryNotice')).toContainText('not loaded');
    await expect(frame.locator('path.country').first()).toBeAttached();
    await page.screenshot({ path: info.outputPath('category-pending-removal-refusal.png'), fullPage: true });
    await frame.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await expect(frame.locator('#pluginCategoryNotice')).toBeHidden();
    await expect(frame.locator('[data-panel="fixture"]')).toBeVisible();
    await page.screenshot({ path: info.outputPath('category-pending-removal-recovered.png'), fullPage: true });
    expect(host.calls.map(call => call.name)).toEqual(['open_news_dashboard', 'get_natural_disasters', 'open_news_dashboard']);
    expect(host.calls[1]?.arguments.panel_request).toBe('news.controlled-1');
    expect(host.units).toBe(2);
  });
}

test('pending category surviving refresh applies after hazard loading', async ({ page }, info) => {
  await useSvgNewsMap(page);
  const host = await installNewsHost(page, false, true, ['politics', 'fixture'], true, false, {});
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('.news-location-marker')).toHaveCount(1);
  host.delayHazards();
  const pending = newsAction(page, 'apply_news_view', { category: ' World News ', source: 'Fixture publisher', time_range: '24h', map_layers: ['fires'], map_latitude: -20, map_longitude: 50, map_zoom: 2 });
  await expect.poll(() => host.calls.filter(call => call.name === 'get_natural_disasters').length).toBe(1);
  host.setCategories(['politics']);
  await frame.getByRole('button', { name: 'Refresh news', exact: true }).click();
  await expect(frame.locator('#pluginUsage')).toContainText('48 of 50 requests remaining');
  await expect(frame.getByRole('combobox', { name: 'News category' }).locator('option[value="fixture"]')).toHaveCount(0);
  host.releaseHazards();
  const receipt = (await pending).structuredContent!;
  expect(receipt).toMatchObject({ applied: true, view: { category: 'politics', source: 'Fixture publisher', time_range: '24h', map_layers: ['fires'] }, categoryLabel: 'World News', center: { lat: -20, lon: 50 }, map: { zoom: 2 } });
  await expect(frame.getByRole('button', { name: 'Refresh news', exact: true })).toBeEnabled();
  await expect(frame.getByRole('combobox', { name: 'News category' })).toHaveValue('politics');
  await expect(frame.locator('#pluginCategoryNotice')).toBeHidden();
  await expect(frame.getByRole('checkbox', { name: 'Fires', exact: true })).toBeChecked();
  expect(host.calls.map(call => call.name)).toEqual(['open_news_dashboard', 'get_natural_disasters', 'open_news_dashboard', 'get_natural_disasters']);
  expect(host.calls[3]?.arguments.panel_request).toBe('news.controlled-2');
  expect(host.units).toBe(2);
  await writeFile(info.outputPath('category-pending-survival-receipts.json'), JSON.stringify({ receipt, calls: host.calls }, null, 2));
});

test('news category receipts retain the visible label without loading data', async ({ page }, info) => {
  const host = await installNewsHost(page, false, true, ['politics', 'fixture']);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#pluginUsage')).toContainText('49 of 50 requests remaining');
  await expect(frame.locator('#pluginMapStatus')).toContainText('earthquakes: 1 valid');
  const initialCalls = host.calls.length;
  await page.evaluate(() => {
    const output = document.createElement('pre');
    output.id = 'categoryContext';
    output.style.whiteSpace = 'pre-wrap';
    document.querySelector('iframe')!.before(output);
    window.addEventListener('message', event => {
      if (event.source !== document.querySelector('iframe')!.contentWindow || event.data.method !== 'ui/update-model-context') return;
      const receipt = JSON.parse(event.data.params.content[0].text);
      output.textContent = `Controlled host receipt: category=${receipt.view.category ?? '(all)'}, categoryLabel=${receipt.categoryLabel}`;
    });
  });
  await frame.getByRole('combobox', { name: 'News category' }).selectOption('politics');
  await expect(frame.getByRole('combobox', { name: 'News category' }).locator('option:checked')).toHaveText('World News');
  await expect(frame.locator('[data-panel="politics"]')).toContainText('Controlled earthquake report in Japan');
  await expect(page.locator('#categoryContext')).toHaveText('Controlled host receipt: category=politics, categoryLabel=World News');
  await page.screenshot({ path: info.outputPath('news-category-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 430, height: 1500 });
  await expect(page.locator('#categoryContext')).toHaveText('Controlled host receipt: category=politics, categoryLabel=World News');
  await page.screenshot({ path: info.outputPath('news-category-mobile.png'), fullPage: true });
  await expect.poll(() => host.contexts.at(-1)).toMatchObject({ view: { category: 'politics' }, categoryLabel: 'World News' });
  await page.evaluate(() => {
    const frame = document.querySelector('iframe')!;
    window.addEventListener('message', event => {
      if (event.source === frame.contentWindow && event.data.id === 'category-receipt') {
        (window as unknown as { categoryReceipt: object }).categoryReceipt = event.data.result.structuredContent;
      }
    });
    frame.contentWindow!.postMessage({ jsonrpc: '2.0', id: 'category-receipt', method: 'tools/call', params: { name: 'apply_news_view', arguments: { category: 'politics' } } }, '*');
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { categoryReceipt: object }).categoryReceipt)).toMatchObject({ view: { category: 'politics' }, categoryLabel: 'World News' });
  await frame.getByRole('combobox', { name: 'News category' }).selectOption('fixture');
  await expect.poll(() => host.contexts.at(-1)).toMatchObject({ view: { category: 'fixture' }, categoryLabel: 'fixture' });
  await frame.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect.poll(() => host.contexts.at(-1)).toMatchObject({ categoryLabel: 'All news panels' });
  expect(host.contexts.at(-1)?.view.category).toBeUndefined();
  expect(host.calls).toHaveLength(initialCalls);
  expect(host.units).toBe(1);
  await writeFile(info.outputPath('news-category-receipts.json'), JSON.stringify(host.contexts, null, 2));
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

for (const mobile of [false, true]) {
  test.describe(mobile ? 'phone camera settlement' : 'desktop camera settlement', () => {
    test.use({ viewport: mobile ? { width: 390, height: 1200 } : { width: 1280, height: 720 }, hasTouch: mobile, isMobile: mobile });
    for (const gesture of ['drag', 'wheel'] as const) {
      test(`a human ${gesture} during renderer transfer reports the effective camera without applying remaining view changes`, async ({ page }, info) => {
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
        const host = await installNewsHost(page, false, true, false, true, true);
        const frame = page.frameLocator('iframe');
        await expect(frame.locator('#panelsGrid')).toContainText('Controlled earthquake report in Japan');
        const action = (name: string, args: Record<string, unknown>) => page.evaluate(({ name, args }) => new Promise<{ isError?: boolean; structuredContent?: ViewReceipt }>(resolve => {
          const frame = document.querySelector('iframe')!;
          const id = crypto.randomUUID();
          const listener = (event: MessageEvent) => {
            if (event.source !== frame.contentWindow || event.data?.id !== id) return;
            window.removeEventListener('message', listener);
            resolve(event.data.result);
          };
          window.addEventListener('message', listener);
          frame.contentWindow!.postMessage({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, '*');
        }), { name, args });
        expect((await action('focus_news_article', { link: 'https://example.com/news' })).isError).not.toBe(true);
        const callsBefore = host.calls.length;
        const pending = action('apply_news_view', { renderer: 'globe', source: 'Unapplied publisher', map_latitude: -20, map_longitude: 50, map_zoom: 8, map_layers: [] });
        await expect.poll(() => frame.locator('body').evaluate(() => Boolean((window as unknown as { __newsCamera?: { viewportTarget?: object } }).__newsCamera?.viewportTarget))).toBe(true);
        const bounds = await frame.locator('#mapContainer canvas').first().boundingBox();
        expect(bounds).not.toBeNull();
        await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
        if (gesture === 'wheel') await page.mouse.wheel(0, -400);
        else {
          await page.mouse.down();
          await page.mouse.move(bounds!.x + bounds!.width / 2 + 100, bounds!.y + bounds!.height / 2 + 25, { steps: 10 });
          await page.mouse.up();
        }
        const result = await pending;
        expect(result.isError).not.toBe(true);
        const receipt = result.structuredContent!;
        expect(receipt.applied).toBe(false);
        expect(receipt.viewport).toEqual({ settled: false, interruptedBy: 'human' });
        expect(receipt.renderer?.mode).toBe('globe');
        expect(receipt.view?.renderer).toBe('globe');
        expect(receipt.view?.source).toBeUndefined();
        expect(receipt.view?.map_layers).toEqual(['natural']);
        const effectiveCenter = await frame.locator('body').evaluate(() => (window as unknown as { __newsInterruptedCenter: { lat: number; lon: number } }).__newsInterruptedCenter);
        expect(receipt.center?.lat).toBeCloseTo(effectiveCenter.lat, 4);
        expect(receipt.center?.lon).toBeCloseTo(effectiveCenter.lon, 4);
        await expect(frame.locator('#mapContainer')).toHaveClass(/globe-mode/);
        await expect(frame.locator('#mapDimensionToggle [data-mode="globe"]')).toHaveClass(/active/);
        await expect(frame.getByRole('combobox', { name: 'News source' })).toHaveValue('');
        await expect(frame.locator('#panelsGrid')).toContainText('Controlled earthquake report in Japan');
        expect(host.calls).toHaveLength(callsBefore);
        await writeFile(info.outputPath('human-interruption-receipt.json'), JSON.stringify({ receipt, effectiveCenter, hostCalls: host.calls.length }, null, 2));
        await page.screenshot({ path: info.outputPath('human-interruption.png'), fullPage: true });
      });
    }
    test('renderer-only news actions preserve the focused camera in their receipts and immediate return to flat', async ({ page }, info) => {
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
      await expect(frame.locator('#panelsGrid')).toContainText('Controlled earthquake report in Japan');
      await expect(frame.locator('#mapContainer')).toHaveClass(mobile ? /svg-mode/ : /deckgl-mode/);
      const actions = (commands: Array<{ name: string; args: Record<string, unknown> }>) => page.evaluate(async commands => {
        const frame = document.querySelector('iframe')!;
        const receipts: Array<{ isError?: boolean; structuredContent?: ViewReceipt; observedAt: number }> = [];
        for (const { name, args } of commands) {
          receipts.push(await new Promise(resolve => {
            const id = crypto.randomUUID();
            const listener = (event: MessageEvent) => {
              if (event.source !== frame.contentWindow || event.data?.id !== id) return;
              window.removeEventListener('message', listener);
              resolve({ ...event.data.result, observedAt: performance.now() });
            };
            window.addEventListener('message', listener);
            frame.contentWindow!.postMessage({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, '*');
          }));
        }
        return receipts;
      }, commands);
      const action = async (name: string, args: Record<string, unknown>) => (await actions([{ name, args }]))[0]!;
      expect((await action('focus_news_article', { link: 'https://example.com/news' })).isError).not.toBe(true);
      expect(host.viewReceipts.at(-1)?.center?.lat).toBeCloseTo(35, 4);
      expect(host.viewReceipts.at(-1)?.center?.lon).toBeCloseTo(139, 4);
      const callsBeforeSwitch = host.calls.length;
      const [globeResult, capturedResult, flatResult] = await actions([
        { name: 'apply_news_view', args: { renderer: 'globe' } },
        { name: 'apply_news_view', args: {} },
        { name: 'apply_news_view', args: { renderer: 'flat' } },
      ]);
      expect([globeResult, capturedResult, flatResult].every(result => !result!.isError)).toBe(true);
      const globe = globeResult!.structuredContent!;
      const captured = capturedResult!.structuredContent!;
      const flat = flatResult!.structuredContent!;
      expect(globe.center?.lat).toBeCloseTo(35, 4);
      expect(globe.center?.lon).toBeCloseTo(139, 4);
      expect(flat.center?.lat).toBeCloseTo(captured.center!.lat, 4);
      // GlobeMap restores idle OrbitControls autoRotateSpeed=0.3 after settlement.
      // That is 1.8 degrees/second; allow its bounded motion during this cycle.
      expect(Math.abs(flat.center!.lon - captured.center!.lon)).toBeLessThanOrEqual(0.03 + 1.8 * (flatResult!.observedAt - capturedResult!.observedAt) / 1000);
      expect(host.calls).toHaveLength(callsBeforeSwitch);
      await writeFile(info.outputPath('renderer-camera-receipts.json'), JSON.stringify({ globe, captured, flat, callsBeforeSwitch, callsAfterSwitch: host.calls.length }, null, 2));
      await page.screenshot({ path: info.outputPath('immediate-return-to-flat.png'), fullPage: true });
      if (!mobile) {
        await frame.locator('#mapDimensionToggle [data-mode="globe"]').click();
        await expect.poll(() => host.viewReceipts.at(-1)?.renderer?.mode).toBe('globe');
        const canvas = frame.locator('#mapContainer canvas').first();
        const bounds = await canvas.boundingBox();
        expect(bounds).not.toBeNull();
        await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
        await page.mouse.down();
        await page.mouse.move(bounds!.x + bounds!.width / 2 + 140, bounds!.y + bounds!.height / 2 + 25, { steps: 10 });
        await page.mouse.up();
        await page.mouse.wheel(0, -400);
        expect((await action('apply_news_view', {})).isError).not.toBe(true);
        const humanCenter = host.viewReceipts.at(-1)!.center!;
        expect(Math.abs(humanCenter.lon - 139)).toBeGreaterThan(1);
        await expect.poll(async () => { await action('apply_news_view', {}); return host.viewReceipts.at(-1)!.map.zoom; }).toBeGreaterThan(4);
        await frame.locator('#mapDimensionToggle [data-mode="flat"]').click();
        await expect.poll(() => host.viewReceipts.at(-1)?.renderer?.mode).toBe('flat');
        // OrbitControls damping can continue after mouseup. The handoff must
        // keep the human-moved camera rather than replaying the article target.
        expect(Math.abs(host.viewReceipts.at(-1)!.center!.lon - 139)).toBeGreaterThan(1);
        expect(host.viewReceipts.at(-1)!.map.zoom).toBeGreaterThan(4);
        expect(host.calls).toHaveLength(callsBeforeSwitch);
      }
    });
  });
}


test('snapshot-supplied located blank article cannot overwrite a newer queued category refusal', async ({ page }, info) => {
  await useSvgNewsMap(page);
  const host = await installNewsHost(page, false, true, 'blank-search', true, false, { map_layers: [] });
  const frame = page.frameLocator('iframe');
  await expect(frame.getByRole('combobox', { name: 'News source' })).toBeVisible();
  const count = host.contexts.length;
  const replacement = JSON.parse(JSON.stringify(host.snapshot));
  delete replacement.requestedView;
  replacement.categories.world.items[1].location = { latitude: 0, longitude: 0 };
  await page.evaluate(structuredContent => document.querySelector('iframe')!.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent } }, '*'), replacement);
  await expect.poll(() => host.contexts.length).toBeGreaterThan(count);
  const before = host.contexts.length;
  await frame.locator('body').evaluate(() => {
    const probe = globalThis as any;
    const original = probe.__newsMap.whenViewportSettled.bind(probe.__newsMap);
    probe.__newsMap.whenViewportSettled = async (...args: unknown[]) => {
      const result = await original(...args);
      probe.__sAwaiting = true;
      await new Promise<void>(resolve => { probe.__sRelease = resolve; });
      return result;
    };
    window.addEventListener('message', event => {
      if (event.data?.method === 'tools/call' && event.data?.params?.name === 'apply_news_view' && event.data?.params?.arguments?.category === 'Not loaded') probe.__sRefusalQueued = true;
    });
  });
  await frame.getByRole('button', { name: 'Search news', exact: true }).click();
  await frame.locator('.search-input').fill('Second publisher');
  await frame.locator('.search-result-item[data-index]').click();
  await expect.poll(() => frame.locator('body').evaluate(() => Boolean((globalThis as any).__sAwaiting))).toBe(true);
  const refused = newsAction(page, 'apply_news_view', { category: 'Not loaded' });
  await expect.poll(() => frame.locator('body').evaluate(() => Boolean((globalThis as any).__sRefusalQueued))).toBe(true);
  await frame.locator('body').evaluate(() => (globalThis as any).__sRelease());
  const receipt = await refused;
  await expect.poll(() => host.contexts.length).toBeGreaterThan(before);
  await frame.locator('body').evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 50)));
  await writeFile(info.outputPath('snapshot-located-queued-refusal.json'), JSON.stringify({ receipt, before, contexts: host.contexts, calls: host.calls, status: await frame.locator('#pluginStatus').textContent() }, null, 2));
  expect(receipt.structuredContent).toMatchObject({ applied: false, reason: 'unknown_category' });
  expect(host.calls.map(call => call.name)).toEqual(['open_news_dashboard']);
  expect(host.contexts.at(-1)?.reason).toBe('unknown_category');
});

type RendererProbeMap = {
  switchToFlat(): Promise<unknown>;
  whenRendererReady(): Promise<void>;
  whenViewportSettled(token?: number): Promise<void>;
  getViewportAuthorityToken(): number;
  getCenter(): { lat: number; lon: number };
  getState(): { zoom: number };
  deckGLMap: { whenViewportSettled(): Promise<boolean> };
};
type RendererProbeWindow = Window & {
  __newsMap: RendererProbeMap;
  __releaseNewsSettlement?: () => void;
  __newsSettlementReason?: string;
  __newsAuthority?: number;
};

type GlobeMovementProbe = {
  controls: { autoRotate: boolean; enableDamping: boolean };
  globe: { pointOfView(): { lat: number; lng: number; altitude: number } };
  viewportTarget: { lat: number; lng: number; altitude: number } | null;
  viewportAutoRotateBeforeMove: boolean | null;
  whenViewportSettled(): Promise<boolean>;
  setRenderPaused(paused: boolean): void;
};
type GlobeMovementWindow = RendererProbeWindow & {
  __newsCamera: GlobeMovementProbe;
  __movement?: Promise<boolean>;
  __movements?: Promise<boolean>[];
  __movementTarget?: { lat: number; lng: number; altitude: number };
  __markerDelivered?: boolean;
  __cameraWrites?: number;
  __observedMovement?: Promise<boolean>;
  __observedTarget?: { lat: number; lng: number; altitude: number } | null;
  __observedSettlement?: Promise<{
    completed: boolean;
    target: { lat: number; lng: number; altitude: number } | null;
    pov: { lat: number; lng: number; altitude: number };
    zoom: number;
    flags: { autoRotate: boolean; enableDamping: boolean };
    savedRotation: boolean | null;
  }>;
};

async function clickObservedGlobeControl(page: Page, selector: string): Promise<void> {
  const button = page.frameLocator('iframe').locator(selector);
  await button.evaluate(() => document.addEventListener('click', () => {
    const probe = window as GlobeMovementWindow;
    probe.__observedTarget = probe.__newsCamera.viewportTarget && { ...probe.__newsCamera.viewportTarget };
    probe.__observedMovement = probe.__newsCamera.whenViewportSettled();
    const target = probe.__observedTarget;
    probe.__observedSettlement = probe.__observedMovement.then(completed => ({
      completed, target, pov: probe.__newsCamera.globe.pointOfView(), zoom: probe.__newsMap.getState().zoom,
      flags: { autoRotate: probe.__newsCamera.controls.autoRotate, enableDamping: probe.__newsCamera.controls.enableDamping },
      savedRotation: probe.__newsCamera.viewportAutoRotateBeforeMove,
    }));
  }, { once: true }));
  await button.click();
}

for (const flags of [
  { autoRotate: false, enableDamping: false },
  { autoRotate: true, enableDamping: false },
  { autoRotate: false, enableDamping: true },
]) {
  test(`globe controls restore rotation ${flags.autoRotate} damping ${flags.enableDamping}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1280, height: 1200 });
    const host = await installNewsHost(page, false, true, false, true, true, { renderer: 'globe', map_layers: [] }, true);
    const frame = page.frameLocator('iframe');
    await expect(frame.locator('#panelsGrid')).toContainText('Controlled earthquake report in Japan');
    expect((await newsAction(page, 'focus_news_article', { link: 'https://example.com/news' })).isError).not.toBe(true);
    await frame.locator('body').evaluate((_element, preferences) => {
      Object.assign((window as GlobeMovementWindow).__newsCamera.controls, preferences);
    }, flags);
    const outcomes = [];
    for (const button of ['.zoom-in', '.zoom-reset']) {
      await frame.locator(button).click();
      const result = await frame.locator('body').evaluate(async () => {
        const camera = (window as GlobeMovementWindow).__newsCamera;
        const target = camera.viewportTarget && { ...camera.viewportTarget };
        const completed = await camera.whenViewportSettled();
        const restored = { autoRotate: camera.controls.autoRotate, enableDamping: camera.controls.enableDamping };
        camera.setRenderPaused(true);
        const paused = { autoRotate: camera.controls.autoRotate, enableDamping: camera.controls.enableDamping };
        camera.setRenderPaused(false);
        return { completed, target, pov: camera.globe.pointOfView(), restored, paused,
          resumed: { autoRotate: camera.controls.autoRotate, enableDamping: camera.controls.enableDamping } };
      });
      outcomes.push({ button, result });
      await writeFile(info.outputPath('preferences-before-assertion.json'), JSON.stringify({ flags, outcomes, contexts: host.contexts, calls: host.calls }, null, 2));
      expect(result.completed).toBe(true);
      expect(result.restored).toEqual(flags);
      expect(result.paused).toEqual({ autoRotate: false, enableDamping: false });
      expect(result.resumed).toEqual(flags);
    }
    expect(host.calls.map(call => call.name)).toEqual(['open_news_dashboard']);
  });
}

for (const gesture of ['pointer', 'wheel'] as const) {
test(`physical globe ${gesture} interruption fails the old Zoom and keeps later controls usable`, async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 1200 });
  const host = await installNewsHost(page, false, true, false, true, true, { renderer: 'globe', map_layers: [] }, true);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#panelsGrid')).toContainText('Controlled earthquake report in Japan');
  expect((await newsAction(page, 'focus_news_article', { link: 'https://example.com/news' })).isError).not.toBe(true);
  await frame.locator('body').evaluate(() => {
    const probe = window as GlobeMovementWindow;
    const globe = probe.__newsCamera.globe as unknown as { pointOfView(...args: unknown[]): unknown };
    const original = globe.pointOfView;
    probe.__cameraWrites = 0;
    globe.pointOfView = function (...args) {
      if (args.length) probe.__cameraWrites!++;
      return original.apply(this, args);
    };
  });
  await frame.locator('.zoom-in').click();
  await frame.locator('body').evaluate(() => {
    const probe = window as GlobeMovementWindow;
    if (!probe.__newsCamera.viewportTarget) throw new Error('Zoom must still be active before physical interruption');
    probe.__movement = probe.__newsCamera.whenViewportSettled();
  });
  const bounds = await frame.locator('#mapContainer canvas').first().boundingBox();
  await page.mouse.move(bounds!.x + 100, bounds!.y + 100);
  if (gesture === 'pointer') {
    await page.mouse.down();
    await page.mouse.move(bounds!.x + 180, bounds!.y + 130, { steps: 8 });
    await page.mouse.up();
  } else await page.mouse.wheel(0, -100);
  const interrupted = await frame.locator('body').evaluate(async () => {
    const probe = window as GlobeMovementWindow;
    return { completed: await probe.__movement, autoRotate: probe.__newsCamera.controls.autoRotate, enableDamping: probe.__newsCamera.controls.enableDamping, writes: probe.__cameraWrites };
  });
  await page.waitForTimeout(1400);
  const laterWrites = await frame.locator('body').evaluate(() => (window as GlobeMovementWindow).__cameraWrites);
  await writeFile(info.outputPath('interruption-before-assertion.json'), JSON.stringify({ interrupted, laterWrites, contexts: host.contexts, calls: host.calls }, null, 2));
  expect(interrupted.completed).toBe(false);
  expect(interrupted.autoRotate).toBe(gesture === 'wheel');
  expect(interrupted.enableDamping).toBe(true);
  expect(laterWrites).toBe(interrupted.writes);
  for (const button of ['.zoom-in', '.zoom-reset']) {
    await frame.locator(button).click();
    expect(await frame.locator('body').evaluate(() => (window as GlobeMovementWindow).__newsCamera.whenViewportSettled())).toBe(true);
  }
  expect(host.calls.map(call => call.name)).toEqual(['open_news_dashboard']);
});
}

for (const autoRotate of [false, true]) {
test(`physical Zoom supersedes a longer globe move through both tween durations rotation ${autoRotate}`, async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 1200 });
  const host = await installNewsHost(page, false, true, false, true, true, { renderer: 'globe', map_layers: [] }, true);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#panelsGrid')).toContainText('Controlled earthquake report in Japan');
  expect((await newsAction(page, 'focus_news_article', { link: 'https://example.com/news' })).isError).not.toBe(true);
  await frame.locator('body').evaluate((_element, rotate) => {
    (window as GlobeMovementWindow).__newsCamera.controls.autoRotate = rotate;
  }, autoRotate);
  const pending = newsAction(page, 'apply_news_view', { map_latitude: -20, map_longitude: 50, map_zoom: 6 });
  await expect.poll(() => frame.locator('body').evaluate(() => Boolean((window as GlobeMovementWindow).__newsCamera.viewportTarget))).toBe(true);
  await frame.locator('body').evaluate(() => {
    const probe = window as GlobeMovementWindow;
    probe.__movement = probe.__newsCamera.whenViewportSettled();
  });
  await frame.locator('.zoom-in').click();
  const superseded = await frame.locator('body').evaluate(async () => {
    const probe = window as GlobeMovementWindow;
    const camera = probe.__newsCamera;
    const target = camera.viewportTarget && { ...camera.viewportTarget };
    const newer = camera.whenViewportSettled();
    const oldCompleted = await probe.__movement;
    const newCompleted = await newer;
    return { oldCompleted, newCompleted, target, pov: camera.globe.pointOfView(),
      flags: { autoRotate: camera.controls.autoRotate, enableDamping: camera.controls.enableDamping } };
  });
  await pending;
  // Both original (1200 ms) and Zoom (500 ms) animations must have finished.
  await page.waitForTimeout(1400);
  const final = await frame.locator('body').evaluate(() => {
    const camera = (window as GlobeMovementWindow).__newsCamera;
    return { pov: camera.globe.pointOfView(), flags: { autoRotate: camera.controls.autoRotate, enableDamping: camera.controls.enableDamping } };
  });
  await writeFile(info.outputPath('supersession-before-assertion.json'), JSON.stringify({ superseded, final, contexts: host.contexts, calls: host.calls }, null, 2));
  expect(superseded.oldCompleted).toBe(false);
  expect(superseded.newCompleted).toBe(true);
  expect(superseded.target).not.toBeNull();
  expect(Math.abs(superseded.pov.lat - superseded.target!.lat)).toBeLessThanOrEqual(0.0001);
  expect(Math.abs((((superseded.pov.lng - superseded.target!.lng) + 540) % 360) - 180)).toBeLessThanOrEqual(0.0001);
  expect(Math.abs(superseded.pov.altitude - superseded.target!.altitude)).toBeLessThanOrEqual(0.001);
  expect(Math.abs(final.pov.lat - superseded.target!.lat)).toBeLessThanOrEqual(0.0001);
  expect(Math.abs(final.pov.altitude - superseded.target!.altitude)).toBeLessThanOrEqual(0.001);
  if (!autoRotate) expect(Math.abs((((final.pov.lng - superseded.target!.lng) + 540) % 360) - 180)).toBeLessThanOrEqual(0.0001);
  else expect(final.pov.lng).not.toBe(superseded.pov.lng);
  expect(final.flags).toEqual({ autoRotate, enableDamping: true });
  expect(host.calls.map(call => call.name)).toEqual(['open_news_dashboard']);
});
}

test('globe longitude wrap and rapid physical supersession retain the latest camera', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 1200 });
  const host = await installNewsHost(page, false, true, false, true, true, { renderer: 'globe', map_layers: [] }, true);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#panelsGrid')).toContainText('Controlled earthquake report in Japan');
  expect((await newsAction(page, 'focus_news_article', { link: 'https://example.com/news' })).isError).not.toBe(true);
  await frame.locator('body').evaluate(() => { (window as GlobeMovementWindow).__newsCamera.controls.autoRotate = false; });
  expect((await newsAction(page, 'apply_news_view', { map_latitude: 0, map_longitude: 179, map_zoom: 3 })).isError).not.toBe(true);
  const crossing = newsAction(page, 'apply_news_view', { map_latitude: 0, map_longitude: -179 });
  await expect.poll(() => frame.locator('body').evaluate(() => Boolean((window as GlobeMovementWindow).__newsCamera.viewportTarget))).toBe(true);
  await page.waitForTimeout(250);
  const duringWrap = await frame.locator('body').evaluate(() => (window as GlobeMovementWindow).__newsCamera.globe.pointOfView());
  expect(Math.abs(duringWrap.lng)).toBeGreaterThan(178);
  expect((await crossing).isError).not.toBe(true);
  const wrapped = await frame.locator('body').evaluate(() => (window as GlobeMovementWindow).__newsCamera.globe.pointOfView());
  expect(Math.abs((((wrapped.lng + 179) + 540) % 360) - 180)).toBeLessThanOrEqual(0.0001);
  await frame.locator('body').evaluate(() => { (window as GlobeMovementWindow).__movements = []; });
  for (const button of ['.zoom-in', '.zoom-out', '.zoom-in']) {
    await frame.locator(button).click();
    await frame.locator('body').evaluate(() => {
      const probe = window as GlobeMovementWindow;
      probe.__movements!.push(probe.__newsCamera.whenViewportSettled());
      probe.__movementTarget = { ...probe.__newsCamera.viewportTarget! };
    });
  }
  const results = await frame.locator('body').evaluate(async () => Promise.all((window as GlobeMovementWindow).__movements!));
  await page.waitForTimeout(1400);
  const final = await frame.locator('body').evaluate(() => {
    const probe = window as GlobeMovementWindow;
    return { target: probe.__movementTarget!, pov: probe.__newsCamera.globe.pointOfView(), zoom: probe.__newsMap.getState().zoom };
  });
  await writeFile(info.outputPath('wrap-rapid-before-assertion.json'), JSON.stringify({ duringWrap, wrapped, results, final, contexts: host.contexts, calls: host.calls }, null, 2));
  expect(results).toEqual([false, false, true]);
  expect(Math.abs(final.pov.lat - final.target.lat)).toBeLessThanOrEqual(0.0001);
  expect(Math.abs((((final.pov.lng - final.target.lng) + 540) % 360) - 180)).toBeLessThanOrEqual(0.0001);
  expect(Math.abs(final.pov.altitude - final.target.altitude)).toBeLessThanOrEqual(0.001);
  await expect.poll(() => host.contexts.at(-1)?.map?.zoom).toBeCloseTo(final.zoom, 4);
  expect(host.calls.map(call => call.name)).toEqual(['open_news_dashboard']);
});

test('an active globe movement pauses without camera writes and resumes with its preferences', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 1200 });
  const host = await installNewsHost(page, false, true, false, true, true, { renderer: 'globe', map_layers: [] }, true);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#panelsGrid')).toContainText('Controlled earthquake report in Japan');
  expect((await newsAction(page, 'focus_news_article', { link: 'https://example.com/news' })).isError).not.toBe(true);
  await frame.locator('.zoom-in').click();
  const paused = await frame.locator('body').evaluate(() => {
    const probe = window as GlobeMovementWindow;
    probe.__movement = probe.__newsCamera.whenViewportSettled();
    probe.__movementTarget = { ...probe.__newsCamera.viewportTarget! };
    probe.__newsCamera.setRenderPaused(true);
    return probe.__newsCamera.globe.pointOfView();
  });
  await page.waitForTimeout(700);
  const during = await frame.locator('body').evaluate(() => (window as GlobeMovementWindow).__newsCamera.globe.pointOfView());
  const result = await frame.locator('body').evaluate(async () => {
    const probe = window as GlobeMovementWindow;
    probe.__newsCamera.setRenderPaused(false);
    const completed = await probe.__movement;
    return { completed, target: probe.__movementTarget!, pov: probe.__newsCamera.globe.pointOfView(), flags: { autoRotate: probe.__newsCamera.controls.autoRotate, enableDamping: probe.__newsCamera.controls.enableDamping } };
  });
  await writeFile(info.outputPath('active-pause-before-assertion.json'), JSON.stringify({ paused, during, result, contexts: host.contexts }, null, 2));
  expect(during.lat).toBeCloseTo(paused.lat, 10);
  expect(during.lng).toBeCloseTo(paused.lng, 10);
  expect(during.altitude).toBeCloseTo(paused.altitude, 10);
  expect(result.completed).toBe(true);
  expect(Math.abs(result.pov.lat - result.target.lat)).toBeLessThanOrEqual(0.0001);
  expect(Math.abs((((result.pov.lng - result.target.lng) + 540) % 360) - 180)).toBeLessThanOrEqual(0.0001);
  expect(Math.abs(result.pov.altitude - result.target.altitude)).toBeLessThanOrEqual(0.001);
  expect(result.flags).toEqual({ autoRotate: true, enableDamping: true });
});

test('renderer replacement cancels an active globe movement and its scheduled writes', async ({ page }, info) => {
  await page.route(/^https:\/\/(tiles\.openfreemap\.org\/styles\/|basemaps\.cartocdn\.com\/gl\/)/, route => route.fulfill({
    json: { version: 8, sources: {}, layers: [] }, headers: { 'Access-Control-Allow-Origin': '*' },
  }));
  const host = await installNewsHost(page, false, true, false, true, true, { renderer: 'globe', map_layers: [] }, true);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#panelsGrid')).toContainText('Controlled earthquake report in Japan');
  expect((await newsAction(page, 'focus_news_article', { link: 'https://example.com/news' })).isError).not.toBe(true);
  await frame.locator('.zoom-in').click();
  const result = await frame.locator('body').evaluate(async () => {
    const probe = window as GlobeMovementWindow;
    const pending = probe.__newsCamera.whenViewportSettled();
    await probe.__newsMap.switchToFlat();
    const camera = probe.__newsCamera as GlobeMovementProbe & { destroyed: boolean; viewportAnimationFrame: number | null };
    return { completed: await pending, destroyed: camera.destroyed, frame: camera.viewportAnimationFrame };
  });
  const count = host.contexts.length;
  await page.waitForTimeout(1400);
  await writeFile(info.outputPath('replacement-before-assertion.json'), JSON.stringify({ result, count, contexts: host.contexts, calls: host.calls }, null, 2));
  expect(result).toEqual({ completed: false, destroyed: true, frame: null });
  expect(host.contexts.slice(count).every(context => (context as NewsContext & { renderer?: { mode?: string } }).renderer?.mode === 'flat')).toBe(true);
  expect(host.calls.map(call => call.name)).toEqual(['open_news_dashboard']);
});

for (const initialZoom of [1.5, 4]) {
  test(`globe wheel then Zoom settles at initial zoom ${initialZoom}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1280, height: 1200 });
    await page.route('**/textures/**', route => route.fulfill({
      path: join(process.cwd(), 'public/textures', new URL(route.request().url()).pathname.split('/').at(-1)!),
      headers: { 'Access-Control-Allow-Origin': '*' },
    }));
    const host = await installNewsHost(page, false, true, false, true, true, { renderer: 'globe', map_layers: [] }, true);
    const frame = page.frameLocator('iframe');
    await expect(frame.locator('#panelsGrid')).toContainText('Controlled earthquake report in Japan');
    expect((await newsAction(page, 'focus_news_article', { link: 'https://example.com/news' })).isError).not.toBe(true);
    expect((await newsAction(page, 'apply_news_view', { map_zoom: initialZoom })).isError).not.toBe(true);
    const article = { kind: 'news-article', link: 'https://example.com/news', title: 'Controlled earthquake report in Japan', source: 'Fixture publisher', displayLabel: 'Controlled earthquake report in Japan' };
    const marker = frame.locator('#mapContainer [title="Controlled earthquake report in Japan"]');
    await expect(marker).toBeAttached();
    await marker.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await frame.locator('#mapContainer').evaluate(element => element.addEventListener('click', event => {
      (window as GlobeMovementWindow).__markerDelivered = event.isTrusted && event.target instanceof Element
        && event.target.closest('[title]')?.getAttribute('title') === 'Controlled earthquake report in Japan';
    }, { once: true, capture: true }));
    const beforeMarker = host.contexts.length;
    await marker.click({ force: true });
    await expect.poll(() => host.contexts.length).toBeGreaterThan(beforeMarker);
    expect(await frame.locator('body').evaluate(() => (window as GlobeMovementWindow).__markerDelivered)).toBe(true);
    expect(host.contexts.at(-1)?.latestInteraction).toEqual(article);
    const before = await frame.locator('body').evaluate(() => {
      const probe = window as GlobeMovementWindow;
      return { zoom: probe.__newsMap.getState().zoom, flags: { autoRotate: probe.__newsCamera.controls.autoRotate, enableDamping: probe.__newsCamera.controls.enableDamping } };
    });
    expect(before.flags.autoRotate).toBe(true);
    expect(before.flags.enableDamping).toBe(true);
    const beforeWheel = host.contexts.length;
    const bounds = await frame.locator('#mapContainer canvas').first().boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.move(bounds!.x + bounds!.width * 0.7, bounds!.y + bounds!.height * 0.7);
    await page.mouse.wheel(0, -400);
    await expect.poll(() => host.contexts.length).toBeGreaterThan(beforeWheel);
    const wheel = await frame.locator('body').evaluate(() => (window as GlobeMovementWindow).__newsMap.getState().zoom);
    expect(wheel).toBeGreaterThan(before.zoom);
    await expect.poll(() => host.contexts.at(-1)?.map?.zoom).toBeCloseTo(wheel, 4);
    const beforeZoom = host.contexts.length;
    await clickObservedGlobeControl(page, '.zoom-in');
    const result = await frame.locator('body').evaluate(() => (window as GlobeMovementWindow).__observedSettlement!);
    await writeFile(info.outputPath('wheel-zoom-before-assertion.json'), JSON.stringify({ initialZoom, before, wheel, beforeZoom, result, contexts: host.contexts, calls: host.calls }, null, 2));
    expect(result.completed).toBe(true);
    expect(result.target).not.toBeNull();
    expect(Math.abs(result.pov.lat - result.target!.lat)).toBeLessThanOrEqual(0.0001);
    expect(Math.abs((((result.pov.lng - result.target!.lng) + 540) % 360) - 180)).toBeLessThanOrEqual(0.0001);
    expect(Math.abs(result.pov.altitude - result.target!.altitude)).toBeLessThanOrEqual(0.001);
    expect(result.zoom).toBeGreaterThan(wheel);
    expect(result.flags).toEqual({ autoRotate: true, enableDamping: true });
    expect(result.savedRotation).toBeNull();
    await expect.poll(() => host.contexts.length).toBeGreaterThan(beforeZoom);
    await expect.poll(() => host.contexts.at(-1)?.map?.zoom).toBeCloseTo(result.zoom, 4);
    expect(host.contexts.at(-1)?.latestInteraction).toEqual(article);
    expect(host.calls.map(call => call.name)).toEqual(['open_news_dashboard']);
    await writeFile(info.outputPath('wheel-zoom-final.json'), JSON.stringify({ initialZoom, result, beforeZoom, contexts: host.contexts, calls: host.calls }, null, 2));
  });
}

for (const failure of ['human', 'nonhuman', 'button', 'readiness'] as const) {
  test(`renderer recovery reconciles ${failure} failure without applying pending filters`, async ({ page }, info) => {
    await page.route(/^https:\/\/(tiles\.openfreemap\.org\/styles\/|basemaps\.cartocdn\.com\/gl\/)/, route => route.fulfill({
      json: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#111111' } }] },
      headers: { 'Access-Control-Allow-Origin': '*' },
    }));
    await page.addInitScript(() => {
      const original = WebGL2RenderingContext.prototype.getExtension;
      WebGL2RenderingContext.prototype.getExtension = function (name) {
        return name === 'WEBGL_debug_renderer_info' ? null : Reflect.apply(original, this, [name]);
      };
    });
    const host = await installNewsHost(page, false, true, false, true, false, { map_layers: ['natural'] }, true);
    const frame = page.frameLocator('iframe');
    await expect(frame.locator('#panelsGrid')).toContainText('Controlled earthquake report in Japan');
    expect((await newsAction(page, 'apply_news_view', { renderer: 'globe' })).isError).not.toBe(true);
    expect((await newsAction(page, 'focus_news_article', { link: 'https://example.com/news' })).isError).not.toBe(true);
    const latestInteraction = host.contexts.at(-1)?.latestInteraction;
    const previousContext = host.contexts.at(-1);
    const before = host.calls.length;
    await frame.locator('body').evaluate((_, failure) => {
      const probe = window as RendererProbeWindow;
      const map = probe.__newsMap;
      const switchToFlat = map.switchToFlat.bind(map);
      const settle = map.whenViewportSettled.bind(map);
      map.whenViewportSettled = async token => {
        try { await settle(token); }
        catch (error) {
          probe.__newsSettlementReason = (error as { reason?: string }).reason;
          throw error;
        }
      };
      map.switchToFlat = async () => {
        const result = await switchToFlat();
        probe.__newsAuthority = map.getViewportAuthorityToken();
        if (failure === 'readiness') {
          map.whenRendererReady = () => Promise.reject(new Error('Controlled renderer readiness failure'));
          throw new Error('Controlled renderer readiness failure');
        }
        const concrete = map.deckGLMap;
        const original = concrete.whenViewportSettled.bind(concrete);
        const held = new Promise<boolean>(resolve => {
          probe.__releaseNewsSettlement = () => {
            concrete.whenViewportSettled = original;
            resolve(false);
          };
        });
        concrete.whenViewportSettled = () => held;
        return result;
      };
    }, failure);
    const pending = failure === 'button'
      ? frame.locator('#mapDimensionToggle [data-mode="flat"]').click().then(() => undefined)
      : newsAction(page, 'apply_news_view', { renderer: 'flat', source: 'Unapplied publisher', map_latitude: -20, map_longitude: 50, map_zoom: 8, map_layers: [] });
    if (failure !== 'readiness') {
      await expect.poll(() => frame.locator('body').evaluate(() => Boolean((window as RendererProbeWindow).__releaseNewsSettlement))).toBe(true);
      if (failure === 'human') {
        await frame.locator('.zoom-in').click();
        await frame.locator('.zoom-reset').click();
      }
      await frame.locator('body').evaluate(() => (window as RendererProbeWindow).__releaseNewsSettlement!());
    }
    const result = await pending;
    if (failure === 'button') await expect.poll(() => frame.locator('body').evaluate(() => (window as RendererProbeWindow).__newsSettlementReason)).toBe('viewport_interrupted');
    const trace = await frame.locator('body').evaluate(() => {
      const probe = window as RendererProbeWindow;
      return { reason: probe.__newsSettlementReason, authorityBefore: probe.__newsAuthority, authorityAfter: probe.__newsMap.getViewportAuthorityToken() };
    });
    await writeFile(info.outputPath('renderer-failure-trace.json'), JSON.stringify({ failure, trace, result, contexts: host.contexts }, null, 2));
    if (failure === 'button') {
      await expect(frame.locator('#pluginStatus')).toHaveText('The map is available, but the requested view did not finish.');
      await expect(frame.locator('#mapDimensionToggle [data-mode="flat"]')).toHaveClass(/active/);
      await expect.poll(() => host.contexts.at(-1)?.view.renderer).toBe('flat');
      expect(host.contexts.at(-1)?.applied).toBe(false);
    } else if (failure === 'readiness') {
      expect(result!.isError).toBe(true);
      expect(host.contexts.at(-1)).toEqual(previousContext);
    } else {
      expect(trace.reason).toBe('viewport_interrupted');
      expect(trace.authorityAfter > trace.authorityBefore!).toBe(failure === 'human');
      expect(result!.isError).not.toBe(true);
      expect(result!.structuredContent).toMatchObject({ applied: false, view: { renderer: 'flat', map_layers: ['natural'] }, viewport: { settled: false } });
      if (failure === 'human') expect(result!.structuredContent).toMatchObject({ viewport: { interruptedBy: 'human' } });
      await expect(frame.locator('#mapDimensionToggle [data-mode="flat"]')).toHaveClass(/active/);
      expect(host.contexts.at(-1)?.view.renderer).toBe('flat');
      expect(host.contexts.at(-1)?.latestInteraction).toEqual(latestInteraction);
    }
    await expect(frame.getByRole('combobox', { name: 'News source' })).toHaveValue('');
    await expect(frame.locator('#pluginMapLayers input[value="natural"]')).toBeChecked();
    expect(host.calls).toHaveLength(before);
    await writeFile(info.outputPath('renderer-failure-trace.json'), JSON.stringify({ failure, trace, result, contexts: host.contexts, status: await frame.locator('#pluginStatus').textContent(), activeMode: await frame.locator('#mapDimensionToggle .active').getAttribute('data-mode'), calls: host.calls }, null, 2));
    if (failure === 'button') await page.screenshot({ path: info.outputPath('ready-flat-incomplete-view.png'), fullPage: true });
  });
}

test('isolated globe wheel publishes the changed camera without another view command', async ({ page }, info) => {
  const host = await installNewsHost(page, false, true, false, true, true, { renderer: 'globe', map_layers: [] }, true);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#panelsGrid')).toContainText('Controlled earthquake report in Japan');
  expect((await newsAction(page, 'focus_news_article', { link: 'https://example.com/news' })).isError).not.toBe(true);
  expect((await newsAction(page, 'apply_news_view', {})).isError).not.toBe(true);
  const selected = host.contexts.at(-1)?.latestInteraction;
  const callsBefore = host.calls.length;
  const contextsBefore = host.contexts.length;
  const before = await frame.locator('body').evaluate(() => {
    const map = (window as RendererProbeWindow).__newsMap;
    return { zoom: map.getState().zoom, authority: map.getViewportAuthorityToken() };
  });
  const bounds = await frame.locator('#mapContainer canvas').first().boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await page.mouse.wheel(0, -400);
  await expect.poll(() => frame.locator('body').evaluate(() => (window as RendererProbeWindow).__newsMap.getState().zoom)).toBeGreaterThan(before.zoom);
  const changed = await frame.locator('body').evaluate(async () => {
    const map = (window as RendererProbeWindow).__newsMap;
    await map.whenViewportSettled();
    return { zoom: map.getState().zoom, authority: map.getViewportAuthorityToken() };
  });
  await writeFile(info.outputPath('isolated-wheel-before-assertion.json'), JSON.stringify({ before, changed, contextsBefore, contexts: host.contexts, calls: host.calls }, null, 2));
  expect(changed.authority).toBeGreaterThan(before.authority);
  await expect.poll(() => host.contexts.length, { timeout: 3000 }).toBeGreaterThan(contextsBefore);
  await expect.poll(() => host.contexts.at(-1)?.map?.zoom).toBeCloseTo(changed.zoom, 4);
  expect(host.contexts.at(-1)?.latestInteraction).toEqual(selected);
  expect(host.calls).toHaveLength(callsBefore);
});

test('a news marker clicked during globe Zoom retains the settled camera context', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 1200 });
  await page.route('**/textures/**', route => route.fulfill({ body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=', 'base64'), contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' } }));
  const host = await installNewsHost(page, false, true, false, true, true, { renderer: 'globe', map_layers: [] }, true);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#panelsGrid')).toContainText('Controlled earthquake report in Japan');
  await frame.locator('#mapContainer canvas').first().click({ position: { x: 30, y: 30 } });
  expect((await newsAction(page, 'focus_news_article', { link: 'https://example.com/news' })).isError).not.toBe(true);
  const selected = host.contexts.at(-1)?.latestInteraction;
  expect(selected).toEqual({ kind: 'news-article', link: 'https://example.com/news', title: 'Controlled earthquake report in Japan', source: 'Fixture publisher', displayLabel: 'Controlled earthquake report in Japan' });
  const callsBefore = host.calls.length;
  await expect(frame.locator('#mapContainer [title="Controlled earthquake report in Japan"]')).toBeAttached();
  await frame.locator('#mapContainer').evaluate(container => {
    const probe = window as GlobeMovementWindow & { __orbitStarts?: number };
    probe.__orbitStarts = 0;
    (probe.__newsCamera.controls as { autoRotate: boolean; enableDamping: boolean; addEventListener(type: string, callback: () => void): void }).addEventListener('start', () => { probe.__orbitStarts!++; });
    const observeMarker = (event: Event) => {
      const title = event.target instanceof Element ? event.target.closest('[title]')?.getAttribute('title') ?? null : null;
      if (title !== 'Controlled earthquake report in Japan') return;
      (probe as GlobeMovementWindow & { __newsMarkerClick?: object }).__newsMarkerClick = {
        title: event.target instanceof Element ? event.target.closest('[title]')?.getAttribute('title') ?? null : null,
        targetTitle: event.target instanceof Element ? event.target.closest('[title]')?.getAttribute('title') ?? null : null,
        pending: Boolean(probe.__newsCamera.viewportTarget),
        isTrusted: event.isTrusted,
        zoom: probe.__newsMap.getState().zoom,
        target: probe.__newsCamera.viewportTarget && { ...probe.__newsCamera.viewportTarget },
        orbitStarts: probe.__orbitStarts,
      };
      container.removeEventListener('click', observeMarker, true);
    };
    container.addEventListener('click', observeMarker, { capture: true });
  });
  const contextsBeforeMarker = host.contexts.length;
  const zoomBounds = await frame.locator('.zoom-in').boundingBox();
  const markerBounds = await frame.locator('#mapContainer [title="Controlled earthquake report in Japan"]').boundingBox();
  await page.mouse.click(zoomBounds!.x + zoomBounds!.width / 2, zoomBounds!.y + zoomBounds!.height / 2);
  await page.mouse.click(markerBounds!.x + markerBounds!.width / 2, markerBounds!.y + markerBounds!.height / 2);
  await expect.poll(() => host.contexts.length, { timeout: 1000 }).toBeGreaterThan(contextsBeforeMarker);
  const clicked = await frame.locator('body').evaluate(() => {
    const probe = window as unknown as { __newsMarkerClick?: { zoom: number; target: object; title: string | null; targetTitle: string | null; pending: boolean; isTrusted: boolean } };
    return probe.__newsMarkerClick!;
  });
  const markerContext = host.contexts[contextsBeforeMarker];
  const contextsAfterMarker = contextsBeforeMarker + 1;
  const settled = await frame.locator('body').evaluate(async () => {
    const map = (window as RendererProbeWindow).__newsMap;
    let failure: string | undefined;
    try { await map.whenViewportSettled(); } catch (error) { failure = String(error); }
    return { center: map.getCenter(), map: map.getState(), failure };
  });
  await writeFile(info.outputPath('marker-during-zoom-before-assertion.json'), JSON.stringify({ clicked, markerContext, contextsBeforeMarker, contextsAfterMarker, settled, context: host.contexts.at(-1), contexts: host.contexts, calls: host.calls }, null, 2));
  expect(clicked).toMatchObject({ title: 'Controlled earthquake report in Japan', targetTitle: 'Controlled earthquake report in Japan', pending: true, isTrusted: true, orbitStarts: 0 });
  expect(markerContext?.latestInteraction).toEqual(selected);
  expect(markerContext?.map?.zoom).toBeLessThan(5);
  expect(settled.failure).toBeUndefined();
  expect(settled.map.zoom).toBeGreaterThan(clicked.zoom);
  await expect.poll(() => host.contexts.length, { timeout: 3000 }).toBeGreaterThan(contextsAfterMarker);
  await expect.poll(() => host.contexts.at(-1)?.map?.zoom, { timeout: 3000 }).toBeCloseTo(settled.map.zoom, 4);
  expect(host.contexts.at(-1)?.latestInteraction).toEqual(selected);
  expect(host.calls).toHaveLength(callsBefore);
  await writeFile(info.outputPath('marker-during-zoom-final.json'), JSON.stringify({ clicked, markerContext, contextsBeforeMarker, contextsAfterMarker, settled, contexts: host.contexts, calls: host.calls }, null, 2));
});

test('direct news Zoom and Reset publish the settled camera without another view command', async ({ page }, info) => {
  await page.route(/^https:\/\/(tiles\.openfreemap\.org\/styles\/|basemaps\.cartocdn\.com\/gl\/)/, route => route.fulfill({
    json: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#111111' } }] },
    headers: { 'Access-Control-Allow-Origin': '*' },
  }));
  await page.addInitScript(() => {
    const original = WebGL2RenderingContext.prototype.getExtension;
    WebGL2RenderingContext.prototype.getExtension = function (name) {
      return name === 'WEBGL_debug_renderer_info' ? null : Reflect.apply(original, this, [name]);
    };
  });
  const host = await installNewsHost(page, false, true, false, true, false, { map_layers: [] }, true);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#panelsGrid')).toContainText('Controlled earthquake report in Japan');
  expect((await newsAction(page, 'focus_news_article', { link: 'https://example.com/news' })).isError).not.toBe(true);
  const latestInteraction = host.contexts.at(-1)?.latestInteraction;
  const before = host.calls.length;
  const contextsBeforeZoom = host.contexts.length;
  const zoomBefore = await frame.locator('body').evaluate(() => (window as RendererProbeWindow).__newsMap.getState().zoom);
  await frame.locator('.zoom-in').click();
  await expect.poll(() => frame.locator('body').evaluate(() => (window as RendererProbeWindow).__newsMap.getState().zoom)).toBeGreaterThan(zoomBefore);
  const zoomed = await frame.locator('body').evaluate(async () => {
    const map = (window as RendererProbeWindow).__newsMap;
    await map.whenViewportSettled();
    return { center: map.getCenter(), map: map.getState() };
  });
  await expect.poll(() => host.contexts.length).toBeGreaterThan(contextsBeforeZoom);
  expect(zoomed.map.zoom).toBeGreaterThan(zoomBefore);
  await expect.poll(() => host.contexts.at(-1)?.map?.zoom).toBeCloseTo(zoomed.map.zoom, 4);
  expect(host.contexts.at(-1)?.latestInteraction).toEqual(latestInteraction);
  expect(host.calls).toHaveLength(before);
  await frame.locator('.zoom-reset').click();
  const settled = await frame.locator('body').evaluate(async () => {
    const map = (window as RendererProbeWindow).__newsMap;
    await map.whenViewportSettled();
    return { center: map.getCenter(), map: map.getState() };
  });
  await writeFile(info.outputPath('direct-controls-before-assertion.json'), JSON.stringify({ settled, context: host.contexts.at(-1) }, null, 2));
  await expect.poll(() => host.contexts.at(-1)?.center?.lat, { timeout: 3000 }).toBeCloseTo(settled.center.lat, 4);
  await expect.poll(() => host.contexts.at(-1)?.center?.lon).toBeCloseTo(settled.center.lon, 4);
  await expect.poll(() => host.contexts.at(-1)?.map?.zoom).toBeCloseTo(settled.map.zoom, 4);
  expect(host.contexts.at(-1)?.latestInteraction).toEqual(latestInteraction);
  expect(host.calls).toHaveLength(before);
  await writeFile(info.outputPath('direct-controls-receipt.json'), JSON.stringify({ settled, context: host.contexts.at(-1), calls: host.calls }, null, 2));
});

test('host resize preserves a newer category refusal after a superseded human observation', async ({ page }, info) => {
  await useSvgNewsMap(page);
  const host = await installNewsHost(page, false, true, false, true, false, {}, true);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#panelsGrid')).toContainText('Controlled earthquake report in Japan');
  expect((await newsAction(page, 'focus_news_article', { link: 'https://example.com/news' })).isError).not.toBe(true);
  const selected = host.contexts.at(-1)?.latestInteraction;
  const callsBefore = host.calls.length;
  await frame.locator('body').evaluate(() => {
    const probe = window as RendererProbeWindow & { __observerEntered?: boolean; __observerFinished?: Promise<void> };
    const map = probe.__newsMap;
    const original = map.whenViewportSettled.bind(map);
    const gate = new Promise<void>(resolve => { probe.__releaseNewsSettlement = resolve; });
    let finish: () => void;
    probe.__observerFinished = new Promise<void>(resolve => { finish = resolve; });
    map.whenViewportSettled = async token => {
      probe.__observerEntered = true;
      await gate;
      try { await original(token); }
      finally { finish(); }
    };
  });
  await frame.locator('[data-action="zoom-in"]').click();
  await expect.poll(() => frame.locator('body').evaluate(() => Boolean((window as RendererProbeWindow & { __observerEntered?: boolean }).__observerEntered))).toBe(true);
  const refusal = await newsAction(page, 'apply_news_view', { category: 'missing', source: 'Unapplied publisher' });
  const expected = { applied: false, reason: 'unknown_category', requestedCategory: 'missing', latestInteraction: selected };
  expect(refusal.structuredContent).toMatchObject(expected);
  await expect.poll(() => host.contexts.at(-1)).toMatchObject(expected);
  const atRefusal = host.contexts.length;
  await frame.locator('body').evaluate(async () => {
    const probe = window as RendererProbeWindow & { __observerFinished?: Promise<void> };
    probe.__releaseNewsSettlement!();
    await probe.__observerFinished;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  expect(host.contexts.at(-1)).toMatchObject(expected);
  expect(host.contexts).toHaveLength(atRefusal);
  const authorityBefore = await frame.locator('body').evaluate(() => (window as RendererProbeWindow).__newsMap.getViewportAuthorityToken());
  const widthBefore = await frame.locator('body').evaluate(() => innerWidth);
  const contextBeforeResize = host.contexts.at(-1);
  const beforeResize = host.contexts.length;
  expect(contextBeforeResize).toMatchObject(expected);
  await page.setViewportSize({ width: 1111, height: 820 });
  const widthAfter = await frame.locator('body').evaluate(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return innerWidth;
  });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  const authorityAfter = await frame.locator('body').evaluate(() => (window as RendererProbeWindow).__newsMap.getViewportAuthorityToken());
  await writeFile(info.outputPath('host-resize-checkpoint.json'), JSON.stringify({ refusal, contextBeforeResize, latest: host.contexts.at(-1), afterResize: host.contexts.slice(beforeResize), authorityBefore, authorityAfter, widthBefore, widthAfter, calls: host.calls }, null, 2));
  expect(widthAfter).not.toBe(widthBefore);
  expect(authorityAfter).toBe(authorityBefore);
  expect(host.contexts.at(-1)).toMatchObject(expected);
  expect(host.contexts).toHaveLength(atRefusal);
  expect(host.calls).toHaveLength(callsBefore);
  await expect(frame.locator('#pluginCategoryNotice')).toContainText('missing');
  await expect(frame.getByRole('combobox', { name: 'News source' })).toHaveValue('');
  await frame.locator('[data-action="reset"]').click();
  const reset = await frame.locator('body').evaluate(async () => {
    const map = (window as RendererProbeWindow).__newsMap;
    await map.whenViewportSettled();
    return { authority: map.getViewportAuthorityToken(), center: map.getCenter(), map: map.getState() };
  });
  expect(reset.authority).toBeGreaterThan(authorityAfter);
  await expect.poll(() => host.contexts.length).toBeGreaterThan(atRefusal);
  await expect.poll(() => host.contexts.at(-1)).toMatchObject({ center: reset.center, map: { zoom: reset.map.zoom }, viewport: { settled: true }, latestInteraction: selected });
  expect(host.calls).toHaveLength(callsBefore);
  await expect(frame.getByRole('combobox', { name: 'News source' })).toHaveValue('');
  await writeFile(info.outputPath('human-reset-after-preserved-refusal.json'), JSON.stringify({ reset, latest: host.contexts.at(-1), selected, calls: host.calls }, null, 2));
});

test('a newer category refusal supersedes an older pending human camera observation', async ({ page }, info) => {
  await useSvgNewsMap(page);
  const host = await installNewsHost(page, false, true, false, true, false, {}, true);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#panelsGrid')).toContainText('Controlled earthquake report in Japan');
  expect((await newsAction(page, 'focus_news_article', { link: 'https://example.com/news' })).isError).not.toBe(true);
  const selected = host.contexts.at(-1)?.latestInteraction;
  const callsBefore = host.calls.length;
  await frame.locator('body').evaluate(() => {
    const probe = window as RendererProbeWindow & { __observerEntered?: boolean; __observerFinished?: Promise<void> };
    const map = probe.__newsMap;
    const original = map.whenViewportSettled.bind(map);
    const gate = new Promise<void>(resolve => { probe.__releaseNewsSettlement = resolve; });
    let finish: () => void;
    probe.__observerFinished = new Promise<void>(resolve => { finish = resolve; });
    map.whenViewportSettled = async token => {
      probe.__observerEntered = true;
      await gate;
      try { await original(token); }
      finally { finish(); }
    };
  });
  await frame.locator('[data-action="zoom-in"]').click();
  await expect.poll(() => frame.locator('body').evaluate(() => Boolean((window as RendererProbeWindow & { __observerEntered?: boolean }).__observerEntered))).toBe(true);
  const refusal = await newsAction(page, 'apply_news_view', { category: 'missing', source: 'Unapplied publisher' });
  const expected = { applied: false, reason: 'unknown_category', requestedCategory: 'missing', latestInteraction: selected };
  expect(refusal.structuredContent).toMatchObject(expected);
  await expect.poll(() => host.contexts.at(-1)).toMatchObject(expected);
  const atRefusal = host.contexts.length;
  await frame.locator('body').evaluate(async () => {
    const probe = window as RendererProbeWindow & { __observerFinished?: Promise<void> };
    probe.__releaseNewsSettlement!();
    await probe.__observerFinished;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  await writeFile(info.outputPath('pending-observer-refusal.json'), JSON.stringify({ refusal, contextAtRefusal: host.contexts[atRefusal - 1], latest: host.contexts.at(-1), laterContexts: host.contexts.slice(atRefusal), calls: host.calls }, null, 2));
  expect(host.contexts.at(-1)).toMatchObject(expected);
  expect(host.contexts).toHaveLength(atRefusal);
  expect(host.calls).toHaveLength(callsBefore);
  await expect(frame.locator('#pluginCategoryNotice')).toContainText('missing');
  await expect(frame.getByRole('combobox', { name: 'News source' })).toHaveValue('');
});


test('aged default clustered Search keeps the exact selected row highlighted after its queued commit', async ({ page }, info) => {
  await useSvgNewsMap(page);
  const host = await installNewsHost(page, false, true, 'blank-search', true, false, { map_layers: [] }, false, undefined, false);
  const frame = page.frameLocator('iframe');
  await frame.getByRole('combobox', { name: 'News category' }).selectOption('world');
  await expect(frame.locator('.panel:not([hidden]) .item.clustered')).toHaveCount(2);
  await frame.getByRole('button', { name: 'Search news', exact: true }).click();
  await frame.locator('.search-input').fill('Second publisher');
  await expect(frame.locator('.search-result-item[data-index]')).toHaveCount(1);
  await page.waitForTimeout(2200);
  const started = Date.now();
  await frame.locator('.search-result-item[data-index]').click();
  await expect.poll(() => host.contexts.at(-1)?.latestInteraction).toMatchObject({ link: '', title: 'Unlinked selection headline', source: 'Second publisher' });
  await page.waitForTimeout(500);
  const row = frame.locator('.panel:not([hidden]) .item.clustered').filter({ has: frame.locator('.item-title', { hasText: 'Unlinked selection headline' }) });
  await expect(row).toHaveClass(/search-highlight/);
  await expect(row.locator('.item-title')).not.toHaveAttribute('href');
  await expect(frame.locator('.panel[hidden] .search-highlight')).toHaveCount(0);
  expect(host.calls.map(call => call.name)).toEqual(['open_news_dashboard']);
  const geometry = await row.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const clip = element.closest('.panel-content')!.getBoundingClientRect();
    return { row: bounds.toJSON(), clip: clip.toJSON(), inside: bounds.top >= clip.top && bounds.bottom <= clip.bottom };
  });
  expect(geometry.inside).toBe(true);
  await writeFile(info.outputPath('aged-default-search.json'), JSON.stringify({ elapsed: Date.now() - started, geometry, contexts: host.contexts, calls: host.calls, assetsRewritten: false }, null, 2));
  await page.screenshot({ path: info.outputPath('aged-default-search.png'), fullPage: true });
});
