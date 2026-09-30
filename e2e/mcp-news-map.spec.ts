import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

let dist: string;
let html: string;
let workerAsset: string;
const origin = 'https://worldmonitor.test';
const item = (source: string, title: string, link: string) => ({ source, title, link, publishedAt: Date.now(), isAlert: false, locationName: 'Berlin', location: { latitude: 52.5, longitude: 13.4 }, importanceScore: 70, credibilityScore: 80, corroborationCount: 1, snippet: 'Fixture news. No live provider request.', tickers: [] });
const payload = { categories: {
  politics: { items: [item('Reuters', 'Ports review shipping schedules as trade routes shift', 'https://example.com/news'), item('AP', 'Science team announces new satellite research', 'https://example.com/science')] },
  europe: { items: [item('BBC', 'Energy ministers meet to discuss winter supply', 'https://example.com/energy')] },
}, feedStatuses: {}, generatedAt: new Date().toISOString() };

test.beforeAll(async () => {
  dist = await mkdtemp(resolve(tmpdir(), 'wm-plugin-test-'));
  await build({ configFile: resolve('vite.plugin.config.ts'), logLevel: 'error', build: { outDir: dist } });
  workerAsset = (await readdir(resolve(dist, 'assets'))).find(name => name.startsWith('maplibre-gl-worker-') && name.endsWith('.js'))!;
  html = (await readFile(resolve(dist, 'plugin.html'), 'utf8')).replace('<head>', `<head><base href="${origin}/">`);
});
test.afterAll(async () => { if (dist) await rm(dist, { recursive: true, force: true }); });

test('real WorldMonitor panels, search, map and host refresh in an opaque sandbox', async ({ page }, testInfo) => {
  const errors: string[] = [];
  let releaseGeometry!: () => void;
  const geometryGate = new Promise<void>(resolve => { releaseGeometry = resolve; });
  let geometryRequested = false;
  page.on('pageerror', error => errors.push(error.message));
  await page.context().route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' });
    if (url.pathname === '/data/countries.geojson') {
      geometryRequested = true;
      await geometryGate;
    }
    const path = url.pathname.startsWith('/plugin/') ? resolve(dist, url.pathname.slice('/plugin/'.length)) : resolve('public', url.pathname.slice(1));
    if (!path.startsWith(dist + '/') && !path.startsWith(resolve('public') + '/')) return route.abort();
    const types: Record<string, string> = { js: 'text/javascript', css: 'text/css', json: 'application/json', svg: 'image/svg+xml', woff2: 'font/woff2' };
    try { return await route.fulfill({ body: await readFile(path), contentType: types[path.split('.').at(-1)!] ?? 'application/octet-stream', headers: { 'Access-Control-Allow-Origin': '*' } }); }
    catch { return route.abort(); }
  });
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.goto(origin);
  await page.setContent(`<iframe title="WorldMonitor plugin" style="border:0;width:100%;height:1100px" sandbox="allow-scripts"></iframe><script>
  const frame=document.querySelector('iframe');window.calls=[];
  window.sendResult=result=>frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:result},'*');
  window.addEventListener('message',e=>{if(e.source!==frame.contentWindow)return;const m=e.data;window.calls.push(m);const send=o=>frame.contentWindow.postMessage({jsonrpc:'2.0',...o},'*');
  if(m.method==='ui/initialize')send({id:m.id,result:{hostCapabilities:{serverTools:{},openLinks:{},updateModelContext:{}},hostContext:{theme:'dark'}}});
  if(m.method==='ui/notifications/initialized')window.sendResult({structuredContent:${JSON.stringify(payload)}});
  if(m.method==='tools/call')send({id:m.id,result:{isError:true,content:[{type:'text',text:'Fixture access denied'}]}});
  if(m.method==='ui/open-link'||m.method==='ui/update-model-context')send({id:m.id,result:{}});
  });frame.srcdoc=${JSON.stringify(html).replace(/</g, '\\u003c')};</script>`);
  const app = page.frameLocator('iframe');
  await expect(app.locator('[data-panel="politics"]')).toContainText('Ports review shipping');
  await expect(app.locator('[data-panel="europe"]')).toContainText('Energy ministers');
  await expect(app.locator('#mapContainer svg').first()).toBeVisible();
  expect(await app.locator('body').evaluate(async (_element, assetUrl) => {
    const blob = `data:text/javascript;charset=utf-8,${encodeURIComponent(`import ${JSON.stringify(assetUrl)};self.postMessage({pluginWorkerReady:true});`)}`;
    const worker = new Worker(blob, { type: 'module' });
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Map worker did not start')), 10_000);
        worker.onmessage = event => { if (event.data?.pluginWorkerReady) { clearTimeout(timer); resolve(true); } };
        worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message || 'Map worker failed')); };
      });
    } finally { worker.terminate(); }
  }, `${origin}/plugin/assets/${workerAsset}`)).toBe(true);
  await app.locator('[data-panel="politics"] a[href="https://example.com/news"]').first().click();
  await expect.poll(() => page.evaluate(() => (window as any).calls.filter((call: any) => call.method === 'ui/open-link').length)).toBe(1);
  expect(await page.evaluate(() => (window as any).calls.filter((call: any) => call.method === 'tools/call').length)).toBe(0);
  await app.locator('[data-panel="politics"] .panel-summarize-btn').click();
  await expect(app.locator('[data-panel="politics"] .panel-summary-error')).toBeVisible();
  await app.getByRole('button', { name: 'Search news' }).click();
  await app.locator('.search-input:visible').fill('Energy');
  await expect(app.locator('.search-results')).toContainText('Energy ministers');
  await app.locator('.search-input:visible').press('Escape');
  await app.getByRole('button', { name: 'Clear filters' }).click();
  await page.evaluate(() => document.querySelector('iframe')!.contentWindow!.postMessage({ jsonrpc: '2.0', id: 'fixture-action', method: 'tools/call', params: { name: 'apply_news_view', arguments: { source: 'Reuters' } } }, '*'));
  await expect.poll(() => page.evaluate(() => (window as any).calls.find((call: any) => call.id === 'fixture-action')?.result?.structuredContent?.applied)).toBe(true);
  await expect(app.locator('[data-panel="europe"]')).toContainText('No news matches');
  await app.getByRole('button', { name: 'Clear filters' }).click();
  await app.getByLabel('News source', { exact: true }).selectOption('Reuters');
  await expect(app.locator('[data-panel="europe"]')).toContainText('No news matches');
  await app.getByRole('button', { name: 'Clear filters' }).click();
  await expect(app.locator('[data-panel="europe"]')).toContainText('Energy ministers');
  await page.evaluate(() => document.querySelector('iframe')!.contentWindow!.postMessage({ jsonrpc: '2.0', id: 'fixture-map', method: 'tools/call', params: { name: 'apply_news_view', arguments: { map_latitude: 52.5, map_longitude: 13.4, map_zoom: 4 } } }, '*'));
  await expect.poll(() => page.evaluate(() => (window as any).calls.find((call: any) => call.id === 'fixture-map')?.result?.structuredContent?.applied)).toBe(true);
  const mapReceipt = await page.evaluate(() => (window as any).calls.find((call: any) => call.id === 'fixture-map')?.result?.structuredContent);
  expect(mapReceipt.center.lat).toBeCloseTo(52.5, 1);
  expect(mapReceipt.center.lon).toBeCloseTo(13.4, 1);
  await page.evaluate(() => document.querySelector('iframe')!.contentWindow!.postMessage({ jsonrpc: '2.0', id: 'fixture-country', method: 'tools/call', params: { name: 'apply_news_view', arguments: { country: 'DE' } } }, '*'));
  await expect.poll(() => geometryRequested).toBe(true);
  expect(await page.evaluate(() => (window as any).calls.some((call: any) => call.id === 'fixture-country'))).toBe(false);
  await app.locator('.time-btn[data-range="1h"]').click();
  releaseGeometry();
  await expect.poll(() => page.evaluate(() => (window as any).calls.find((call: any) => call.id === 'fixture-country')?.result?.structuredContent?.applied)).toBe(true);
  await page.evaluate(() => document.querySelector('iframe')!.contentWindow!.postMessage({ jsonrpc: '2.0', id: 'fixture-after-time', method: 'tools/call', params: { name: 'apply_news_view', arguments: {} } }, '*'));
  await expect.poll(() => page.evaluate(() => (window as any).calls.find((call: any) => call.id === 'fixture-after-time')?.result?.structuredContent?.view?.time_range)).toBe('1h');
  await expect(app.locator('.time-btn[data-range="1h"]')).toHaveClass(/active/);
  await app.getByRole('button', { name: 'Clear filters' }).click();
  await app.getByRole('button', { name: 'Refresh news' }).click();
  await expect(app.getByRole('status')).toContainText('refresh failed');
  await expect(app.locator('[data-panel="politics"]')).toContainText('Ports review shipping');
  await page.screenshot({ path: testInfo.outputPath('news-maps-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 1000 });
  await expect(app.locator('[data-panel="politics"]')).toContainText('Ports review shipping');
  await expect(app.getByRole('button', { name: 'Refresh news' })).toBeInViewport();
  expect(await app.locator('body').evaluate(element => element.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('news-maps-mobile.png'), fullPage: true });
  await page.evaluate(() => (window as any).sendResult({ structuredContent: { categories: {}, feedStatuses: {}, generatedAt: '' } }));
  await expect(app.locator('.panel')).toHaveCount(0);
  await expect(app.getByRole('status')).toContainText('No news is available');
  expect(errors).toEqual([]);
});
