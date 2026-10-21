import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { NEWS_DASHBOARD_META } from '../api/mcp/ui/news-dashboard-app';
test.use({ launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

let dist: string;
let html: string;
const origin = 'https://worldmonitor.test';
const item = (source: string, title: string, link: string) => ({ source, title, link, publishedAt: Date.now(), isAlert: false, locationName: 'Berlin', location: { latitude: 52.5, longitude: 13.4 }, importanceScore: 70, credibilityScore: 80, corroborationCount: 1, snippet: 'Fixture news. No live provider request.', tickers: [] });
const payload = { categories: {
  politics: { items: [{ ...item('Reuters', 'Ports review shipping schedules as trade routes shift in Berlin', 'https://example.com/news'), location: undefined, locationName: '' }, { ...item('AP', 'Science team announces new satellite research in Berlin', 'https://example.com/science'), publishedAt: Date.now() - 2 * 60 * 60 * 1000, locationName: 'Helsinki', location: { latitude: 60.17, longitude: 24.94 } }, { ...item('Missing link feed', 'Headline with no supplied source URL', ''), locationName: 'London', location: { latitude: 51.5, longitude: -0.12 } }, { ...item('AP', 'The research group presents its quarterly findings', 'https://example.com/unlocated'), location: undefined, locationName: '' }] },
  europe: { items: [{ ...item('BBC', 'Energy ministers meet to discuss winter supply', 'https://example.com/energy'), locationName: 'Paris', location: { latitude: 48.86, longitude: 2.35 } }] },
}, feedStatuses: {}, generatedAt: new Date().toISOString() };
const hazards = { structuredContent: { data: {
  earthquakes: { earthquakes: [
    { id: 'fixture-quake', place: 'Fixture Berlin', magnitude: 5.1, depthKm: 10, location: { latitude: 52.5, longitude: 13.4 }, occurredAt: Date.now(), sourceUrl: 'https://example.com/quake', source: 'USGS fixture', category: 'earthquake' },
    { id: 'invalid-quake', location: { latitude: 999, longitude: 13.4 } },
  ] },
  events: { dataAvailable: true, events: [{ id: 'fixture-flood', title: 'Fixture flood', category: 'floods', categoryTitle: 'Floods', lat: 50, lon: 10, date: Date.now(), sourceUrl: 'https://example.com/flood', sourceName: 'Fixture', closed: false }] },
  fires: { dataAvailable: true, fireDetections: [{ id: 'fixture-fire', location: { latitude: 48, longitude: 12 }, brightness: 350, frp: 12, confidence: 'FIRE_CONFIDENCE_HIGH', detectedAt: Date.now(), region: 'Fixture', dayNight: 'D' }] },
} } };

test.beforeAll(async () => {
  dist = await mkdtemp(resolve(tmpdir(), 'wm-plugin-test-'));
  const inheritedTiles = process.env.VITE_PMTILES_URL;
  process.env.VITE_PMTILES_URL = 'https://private-tiles.example/planet.pmtiles';
  try {
    await build({ configFile: resolve('vite.plugin.config.ts'), logLevel: 'error', build: { outDir: dist } });
  } finally {
    if (inheritedTiles === undefined) delete process.env.VITE_PMTILES_URL;
    else process.env.VITE_PMTILES_URL = inheritedTiles;
  }
  html = (await readFile(resolve(dist, 'plugin.html'), 'utf8')).replace('<head>', `<head><base href="${origin}/">`);
});

test.describe('2D basemap with enforced CSP', () => {
  test('paints public basemap assets without inheriting private PMTiles configuration', async ({ page }, testInfo) => {
    const errors: string[] = [];
    const textureReferrers: string[] = [];
    const mapPayload = { ...payload, categories: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`region-${index}`, payload.categories.politics])) };
    page.on('pageerror', error => errors.push(error.message));
    await page.context().route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === 'https://tiles.openfreemap.org') {
        if (url.pathname === '/styles/dark') return route.fulfill({ json: {
          version: 8, sprite: 'https://tiles.openfreemap.org/sprites/fixture',
          sources: { land: { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-60, -40], [60, -40], [60, 60], [-60, 60], [-60, -40]]] } } } },
          layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#16283f' } }, { id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': '#37a56f' } }],
        }, headers: { 'Access-Control-Allow-Origin': '*' } });
        return route.fulfill({ body: url.pathname.endsWith('.json') ? '{}' : await readFile(resolve('public/favico/favicon-32x32.png')), contentType: url.pathname.endsWith('.json') ? 'application/json' : 'image/png', headers: { 'Access-Control-Allow-Origin': '*' } });
      }
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' });
      const path = url.pathname.startsWith('/plugin/') ? resolve(dist, url.pathname.slice('/plugin/'.length)) : resolve('public', url.pathname.slice(1));
      if (!path.startsWith(dist + '/') && !path.startsWith(resolve('public') + '/')) return route.abort();
      if (url.pathname.startsWith('/textures/')) {
        const referrer = route.request().headers().referer ?? '';
        textureReferrers.push(referrer);
        if (referrer) return route.fulfill({ status: 403, body: 'Hotlink protection' });
      }
      try { return route.fulfill({ body: await readFile(path), contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.jpg') ? 'image/jpeg' : 'application/json', headers: { 'Access-Control-Allow-Origin': '*' } }); }
      catch { return route.abort(); }
    });
    const domains = NEWS_DASHBOARD_META.ui.csp;
    const csp = `default-src 'none'; script-src 'unsafe-inline' ${origin} data:; worker-src blob:; style-src 'unsafe-inline' ${origin}; font-src ${origin} data:; img-src ${origin} ${domains.resourceDomains.join(' ')}; connect-src ${origin} ${domains.connectDomains.join(' ')}; base-uri ${origin}`;
    const strictHtml = html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}"><script>(() => {
      const createObjectURL = URL.createObjectURL;
      URL.createObjectURL = function (blob) {
        const url = createObjectURL.call(this, blob);
        if (blob.type === 'text/javascript') document.documentElement.dataset.workerBlobUrl = url;
        return url;
      };
      const revokeObjectURL = URL.revokeObjectURL;
      URL.revokeObjectURL = function (url) {
        if (url === document.documentElement.dataset.workerBlobUrl) document.documentElement.dataset.workerBlobRevoked = 'true';
        return revokeObjectURL.call(this, url);
      };
      const getExtension = WebGL2RenderingContext.prototype.getExtension;
      WebGL2RenderingContext.prototype.getExtension = function (name) {
        return name === 'WEBGL_debug_renderer_info' ? null : Reflect.apply(getExtension, this, [name]);
      };
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, options) {
        return Reflect.apply(getContext, this, [type, type.startsWith('webgl') ? { ...options, preserveDrawingBuffer: true } : options]);
      };
})();
document.documentElement.dataset.cspViolations='0';document.addEventListener('securitypolicyviolation',()=>document.documentElement.dataset.cspViolations=String(Number(document.documentElement.dataset.cspViolations)+1));</script>`);
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.goto(origin);
    await page.setContent(`<iframe title="WorldMonitor plugin" style="border:0;width:100%;height:1000px" sandbox="allow-scripts"></iframe><script>
      const frame=document.querySelector('iframe');window.calls=[];window.addEventListener('message',e=>{if(e.source!==frame.contentWindow)return;const m=e.data;window.calls.push(m);const send=o=>frame.contentWindow.postMessage({jsonrpc:'2.0',...o},'*');
      if(m.method==='ui/initialize')send(window.rejectInit?{id:m.id,error:{code:-32000,message:'Fixture initialization failed'}}:{id:m.id,result:{hostCapabilities:{},hostContext:{theme:'dark'}}});
      if(m.method==='ui/notifications/initialized')send({method:'ui/notifications/tool-result',params:{structuredContent:${JSON.stringify(mapPayload)}}});});frame.srcdoc=${JSON.stringify(strictHtml).replace(/</g, '\\u003c')};</script>`);
    const app = page.frameLocator('iframe');
    await expect(app.locator('.panel')).toHaveCount(12);
    await expect.poll(() => app.locator('#mapSection').evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(1000);
    await expect(app.locator('#deckgl-basemap canvas')).toBeVisible();
    await expect.poll(() => app.locator('#deckgl-basemap canvas').evaluate((element) => {
      const gl = (element as HTMLCanvasElement).getContext('webgl2');
      if (!gl) return false;
      const pixel = new Uint8Array(4);
      gl.readPixels(gl.drawingBufferWidth / 2, gl.drawingBufferHeight / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return pixel[1]! > pixel[0]! + 10 && pixel[3]! > 0;
    }), { timeout: 20_000 }).toBe(true);
    await expect(app.locator('html')).toHaveAttribute('data-csp-violations', '0');
    expect(errors).toEqual([]);
    await app.getByRole('combobox', { name: 'News category' }).selectOption('region-0');
    await expect(app.locator('.panel:visible')).toHaveCount(1);
    await app.getByRole('button', { name: 'Clear filters' }).press('Enter');
    await expect(app.locator('.panel:visible')).toHaveCount(12);
    await page.screenshot({ path: testInfo.outputPath('news-map-2d-csp.png'), fullPage: true });
    await app.locator('#pluginMapLayers').getByLabel('Military Bases', { exact: true }).check();
    await expect(app.locator('#pluginMapStatus')).toContainText('reference data');
    await page.evaluate(() => document.querySelector('iframe')!.contentWindow!.postMessage({ jsonrpc: '2.0', id: 'fixture-globe', method: 'tools/call', params: { name: 'apply_news_view', arguments: { renderer: 'globe', map_layers: ['bases', 'cables'] } } }, '*'));
    await expect.poll(() => page.evaluate(() => (window as any).calls.find((call: any) => call.id === 'fixture-globe')?.result?.structuredContent?.renderer?.mode)).toBe('globe');
    await expect(app.locator('#mapContainer canvas').first()).toBeVisible();
    await expect.poll(() => textureReferrers.length).toBeGreaterThan(0);
    expect(textureReferrers).toEqual(['']);
    await expect.poll(() => app.locator('#mapContainer canvas').first().evaluate(element => {
      const gl = (element as HTMLCanvasElement).getContext('webgl2');
      if (!gl) return false;
      const pixel = new Uint8Array(4);
      gl.readPixels(gl.drawingBufferWidth / 2, gl.drawingBufferHeight / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return pixel[0]! + pixel[1]! + pixel[2]! > 40 && pixel[3]! > 0;
    })).toBe(true);
    await expect(app.locator('#mapDimensionToggle button[data-mode="globe"]')).toHaveClass(/active/);
    await expect(app.locator('#pluginMapLayers').getByLabel('Undersea Cables', { exact: true })).toBeChecked();
    await expect(app.locator('html')).toHaveAttribute('data-csp-violations', '0');
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('domain-maps-globe.png'), fullPage: true });
    await page.evaluate(() => {
      (window as any).rejectInit = true;
      const frame = document.querySelector('iframe')!;
      frame.setAttribute('srcdoc', frame.srcdoc);
    });
    await expect(app.locator('#pluginStatus')).toContainText('Fixture initialization failed');
    await expect(app.locator('html')).toHaveAttribute('data-worker-blob-url', /^blob:/);
    await app.locator('html').evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await expect(app.locator('html')).toHaveAttribute('data-worker-blob-revoked', 'true');
  });
});
test.afterAll(async () => { if (dist) await rm(dist, { recursive: true, force: true }); });

test('real WorldMonitor panels, search, map and host refresh in an opaque sandbox', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, options) {
      return type.startsWith('webgl') ? null : Reflect.apply(getContext, this, [type, options]);
    };
  });
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
  const frame=document.querySelector('iframe');window.calls=[];window.hazards={isError:true};
  window.sendResult=result=>frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:result},'*');
  window.addEventListener('message',e=>{if(e.source!==frame.contentWindow)return;const m=e.data;window.calls.push(m);const send=o=>frame.contentWindow.postMessage({jsonrpc:'2.0',...o},'*');
  if(m.method==='ui/initialize')send({id:m.id,result:{hostCapabilities:{serverTools:{},openLinks:{},updateModelContext:{}},hostContext:{theme:'dark'}}});
  if(m.method==='ui/notifications/initialized')window.sendResult({structuredContent:{...${JSON.stringify(payload)},requestedView:{map_layers:['natural']}}});
  if(m.method==='tools/call')send({id:m.id,result:m.params.name==='get_natural_disasters'?(window.hazardBudgetLimit&&m.params.arguments.limit>window.hazardBudgetLimit?{structuredContent:{_budget_exceeded:true,budget_bytes:131072,actual_bytes:200000}}:window.hazards):{isError:true,content:[{type:'text',text:'Fixture access denied'}]}});
  if(m.method==='ui/open-link'||m.method==='ui/update-model-context')send({id:m.id,result:{}});
  });frame.srcdoc=${JSON.stringify(html).replace(/</g, '\\u003c')};</script>`);
  const app = page.frameLocator('iframe');
  await expect(app.locator('[data-panel="politics"]')).toContainText('Ports review shipping');
  await expect(app.locator('[data-panel="europe"]')).toContainText('Energy ministers');
  await expect(app.locator('#pluginStatus')).toContainText('requested view could not be applied');
  await page.screenshot({ path: testInfo.outputPath('news-initial-hazard-denied.png'), fullPage: true });
  await page.evaluate(value => { (window as any).hazards = value; }, hazards);
  await expect(app.locator('#mapContainer svg').first()).toBeVisible();
  await expect(app.locator('.news-location-marker')).toHaveCount(4);
  await expect(app.locator('.news-location-marker').first()).toHaveAttribute('title', 'Ports review shipping schedules as trade routes shift in Berlin (approximate location: Berlin)');
  await expect(app.locator('.news-location-marker').nth(1)).toHaveAttribute('title', 'Science team announces new satellite research in Berlin');
  const locationCases = [
    { ...item('Fixture', 'NATO meets in Paris', 'https://example.com/paris'), location: undefined },
    { ...item('Fixture', 'Paris and Berlin discuss trade', 'https://example.com/ambiguous'), location: undefined },
    { ...item('Fixture', 'NATO announces its quarterly report', 'https://example.com/organization'), location: undefined },
    { ...item('Fixture', 'Washington DC and Moscow discuss trade', 'https://example.com/two-capitals'), location: undefined },
    { ...item('Fixture', 'Berlin hosts energy talks', 'https://example.com/invalid-coordinates'), location: { latitude: Infinity, longitude: 13.4 } },
  ];
  await page.evaluate(items => (window as any).sendResult({ structuredContent: { categories: { politics: { items } }, feedStatuses: {}, generatedAt: '' } }), locationCases);
  await expect(app.locator('.news-location-marker[title="NATO meets in Paris (approximate location: Paris)"]')).toHaveCount(1);
  await expect(app.locator('.news-location-marker[title="Berlin hosts energy talks (approximate location: Berlin)"]')).toHaveCount(1);
  await expect(app.locator('.news-location-marker')).toHaveCount(2);
  await page.evaluate(data => (window as any).sendResult({ structuredContent: data }), payload);
  await expect(app.locator('.news-location-marker')).toHaveCount(4);
  await page.evaluate(() => document.querySelector('iframe')!.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: { query: 'Energy', map_latitude: 52.5, map_longitude: 13.4, map_zoom: 4 } } }, '*'));
  await expect(app.locator('.search-input:visible')).toHaveValue('Energy');
  await expect.poll(() => page.evaluate(() => (window as any).calls.filter((call: any) => call.method === 'ui/update-model-context').at(-1)?.params?.content?.[0]?.text)).toContain('52.5');
  await app.locator('.search-input:visible').press('Escape');
  await app.getByRole('button', { name: 'Clear filters' }).press('Enter');
  await expect(app.locator('.news-location-marker')).toHaveCount(4);
  await page.screenshot({ path: testInfo.outputPath('news-markers-desktop.png'), fullPage: true });
  await app.locator('.news-location-marker').first().click();
  await expect(app.locator('.map-popup')).toContainText('Ports review shipping schedules as trade routes shift');
  await app.locator('.map-popup .popup-close').press('Enter');
  await expect(app.locator('.map-popup')).toHaveCount(0);
  await app.locator('[data-panel="politics"] a[href=""]').first().click();
  await expect(app.locator('#pluginStatus')).toContainText('source link is unavailable');
  expect(await page.evaluate(() => (window as any).calls.filter((call: any) => call.method === 'ui/open-link').length)).toBe(0);
  await app.locator('[data-panel="politics"] a[href="https://example.com/news"]').first().click();
  await expect.poll(() => page.evaluate(() => (window as any).calls.filter((call: any) => call.method === 'ui/open-link').length)).toBe(1);
  expect(await page.evaluate(() => (window as any).calls.filter((call: any) => call.method === 'tools/call').length)).toBe(1);
  await app.locator('[data-panel="politics"] .panel-summarize-btn').click();
  await expect(app.locator('[data-panel="politics"] .panel-summary-error')).toBeVisible();
  await app.getByRole('button', { name: 'Search news' }).click();
  await expect(app.locator('.search-scope')).toHaveCount(2);
  await expect(app.locator('.tip-item, .search-chip, .search-all-commands-link')).toHaveCount(0);
  await expect(app.locator('.search-input:visible')).toHaveAttribute('placeholder', 'Search news');
  await page.screenshot({ path: testInfo.outputPath('news-search-desktop.png'), fullPage: true });
  await app.locator('.search-input:visible').fill('Energy');
  await expect(app.locator('.search-results')).toContainText('Energy ministers');
  await app.locator('.search-input:visible').press('Escape');
  await app.getByRole('button', { name: 'Clear filters' }).press('Enter');
  await page.evaluate(() => document.querySelector('iframe')!.contentWindow!.postMessage({ jsonrpc: '2.0', id: 'fixture-action', method: 'tools/call', params: { name: 'apply_news_view', arguments: { source: 'Reuters' } } }, '*'));
  await expect.poll(() => page.evaluate(() => (window as any).calls.find((call: any) => call.id === 'fixture-action')?.result?.structuredContent?.applied)).toBe(true);
  await expect(app.locator('[data-panel="europe"]')).toContainText('No news matches');
  await app.getByRole('button', { name: 'Clear filters' }).press('Enter');
  await app.getByLabel('News source', { exact: true }).selectOption('Reuters');
  await expect(app.locator('[data-panel="europe"]')).toContainText('No news matches');
  await expect(app.locator('.news-location-marker')).toHaveCount(1);
  await app.getByRole('button', { name: 'Clear filters' }).press('Enter');
  await expect(app.locator('[data-panel="europe"]')).toContainText('Energy ministers');
  await expect(app.locator('.news-location-marker')).toHaveCount(4);
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
  await expect(app.locator('.news-location-marker')).toHaveCount(0);
  await app.getByRole('button', { name: 'Clear filters' }).press('Enter');
  await expect(app.locator('.news-location-marker')).toHaveCount(4);
  await app.locator('.time-btn[data-range="1h"]').click();
  await expect(app.locator('.news-location-marker')).toHaveCount(3);
  await app.getByRole('button', { name: 'Refresh news' }).press('Enter');
  await expect(app.locator('#pluginStatus')).toContainText('refresh failed');
  await expect(app.locator('[data-panel="politics"]')).toContainText('Ports review shipping');
  await expect(app.locator('.news-location-marker')).toHaveCount(3);
  await app.getByRole('button', { name: 'Clear filters' }).press('Enter');
  await expect(app.locator('.news-location-marker')).toHaveCount(4);
  await app.locator('#pluginMapLayers').getByLabel('Natural Events', { exact: true }).check();
  await expect(app.locator('.earthquake-marker[title*="Fixture Berlin"]')).toBeVisible();
  await expect(app.locator('#pluginMapStatus')).toContainText('earthquakes: 1 valid, 1 skipped');
  expect(await page.evaluate(() => (window as any).calls.filter((call: any) => call.params?.name === 'get_natural_disasters').at(-1)?.params?.arguments)).toEqual({ dataset: ['earthquakes', 'other'], limit: 100 });
  await page.evaluate(() => document.querySelector('iframe')!.contentWindow!.postMessage({ jsonrpc: '2.0', id: 'fixture-layers', method: 'tools/call', params: { name: 'apply_news_view', arguments: { map_layers: ['natural', 'fires', 'bases', 'cables', 'pipelines', 'waterways'] } } }, '*'));
  await expect.poll(() => page.evaluate(() => (window as any).calls.find((call: any) => call.id === 'fixture-layers')?.result?.structuredContent?.view.map_layers)).toEqual(['natural', 'fires', 'cables', 'pipelines', 'waterways', 'bases']);
  await expect(app.locator('#pluginMapLayers').getByLabel('Fires', { exact: true })).toBeChecked();
  await expect(app.locator('#pluginMapLayers').getByLabel('Undersea Cables', { exact: true })).toBeChecked();
  await expect(app.locator('#pluginMapStatus')).toContainText('fires: 1 valid');
  const hazardCallsBeforeFocus = await page.evaluate(() => (window as any).calls.filter((call: any) => call.params?.name === 'get_natural_disasters').length);
  await page.evaluate(() => document.querySelector('iframe')!.contentWindow!.postMessage({ jsonrpc: '2.0', id: 'fixture-focus-layers', method: 'tools/call', params: { name: 'focus_news_article', arguments: { link: 'https://example.com/news' } } }, '*'));
  await expect.poll(() => page.evaluate(() => (window as any).calls.find((call: any) => call.id === 'fixture-focus-layers')?.result?.structuredContent?.view.map_layers)).toEqual(['natural', 'fires', 'cables', 'pipelines', 'waterways', 'bases']);
  expect(await page.evaluate(() => (window as any).calls.filter((call: any) => call.params?.name === 'get_natural_disasters').length)).toBe(hazardCallsBeforeFocus);
  await expect(app.locator('#pluginMapLayers').getByLabel('Natural Events', { exact: true })).toBeChecked();
  await app.getByRole('button', { name: 'Clear filters' }).press('Enter');
  await expect(app.locator('#pluginMapLayers').getByLabel('Fires', { exact: true })).toBeChecked();
  await page.evaluate(() => { (window as any).hazardBudgetLimit = 20; });
  await app.getByRole('button', { name: 'Refresh map data' }).press('Enter');
  await expect(app.locator('#pluginMapStatus')).toContainText('up to 20/source');
  const budgetCalls = await page.evaluate(() => (window as any).calls.filter((call: any) => call.params?.name === 'get_natural_disasters').slice(-2).map((call: any) => call.params.arguments.limit));
  expect(budgetCalls).toEqual([100, 20]);
  await expect(app.locator('.earthquake-marker[title*="Fixture Berlin"]')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('domain-maps-budget-recovery.png'), fullPage: true });
  await page.evaluate(() => { (window as any).hazardBudgetLimit = undefined; });
  await page.evaluate(() => { (window as any).hazards = { isError: true, structuredContent: { data: {} } }; });
  await app.getByRole('button', { name: 'Refresh map data' }).press('Enter');
  await expect(app.locator('#pluginMapStatus')).toContainText('denied or unavailable');
  await expect(app.locator('.earthquake-marker[title*="Fixture Berlin"]')).toBeVisible();
  await expect(app.locator('#pluginMapLayers').getByLabel('Natural Events', { exact: true })).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('domain-maps-desktop.png'), fullPage: true });
  await page.evaluate(value => { (window as any).hazards = value; }, hazards);
  await app.getByRole('button', { name: 'Refresh map data' }).press('Enter');
  await expect(app.locator('#pluginMapStatus')).toContainText('Global hazard snapshot');
  await page.screenshot({ path: testInfo.outputPath('news-maps-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 1000 });
  await expect(app.locator('[data-panel="politics"]')).toContainText('Ports review shipping');
  await expect(app.getByRole('button', { name: 'Refresh news' })).toBeInViewport();
  expect(await app.locator('#mapContainer').evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(360);
  expect(await app.locator('#mapContainer').evaluate(element => element.getBoundingClientRect().bottom <= document.getElementById('panelsGrid')!.getBoundingClientRect().top)).toBe(true);
  expect(await app.locator('body').evaluate(element => element.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await app.getByRole('button', { name: 'Search news' }).click();
  await expect(app.locator('.search-scope')).toHaveCount(2);
  await expect(app.locator('.tip-item, .search-chip, .search-all-commands-link')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('news-search-mobile.png'), fullPage: true });
  await app.locator('.search-input:visible').press('Escape');
  await expect(app.getByRole('dialog')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('news-maps-mobile.png'), fullPage: true });
  await page.screenshot({ path: testInfo.outputPath('domain-maps-mobile.png'), fullPage: true });
  await page.evaluate(() => { (window as any).hazards = { structuredContent: { data: { earthquakes: { earthquakes: [] }, events: { dataAvailable: true, events: [] }, fires: { dataAvailable: true, fireDetections: [] } } } }; });
  await app.getByRole('button', { name: 'Refresh map data' }).press('Enter');
  await expect(app.locator('#pluginMapStatus')).toContainText('earthquakes: 0 valid');
  await expect(app.locator('.earthquake-marker')).toHaveCount(0);
  const crowded = Array.from({ length: 350 }, (_, index) => item('Fixture', `Located headline ${index}`, `https://example.com/news/${index}`));
  await page.evaluate(items => (window as any).sendResult({ structuredContent: { categories: { politics: { items } }, feedStatuses: {}, generatedAt: '', requestedView: { map_layers: [] } } }), crowded);
  await expect(app.locator('[data-panel="politics"]')).toContainText('Located headline');
  await expect(app.locator('.news-location-marker')).toHaveCount(300);
  await expect(app.locator('.map-truncation-summary')).toHaveText('300/350 markers');
  await page.evaluate(() => {
    (window as any).calls = [];
    const frame = document.querySelector('iframe')!;
    frame.setAttribute('srcdoc', frame.srcdoc);
  });
  await expect(app.locator('[data-panel="politics"]')).toContainText('Ports review shipping');
  await page.evaluate(() => document.querySelector('iframe')!.contentWindow!.postMessage({ jsonrpc: '2.0', id: 'fixture-mobile-news', method: 'tools/call', params: { name: 'apply_news_view', arguments: { map_layers: [], map_latitude: 52.5, map_longitude: 13.4, map_zoom: 3 } } }, '*'));
  await expect.poll(() => page.evaluate(() => (window as any).calls.find((call: any) => call.id === 'fixture-mobile-news')?.result?.structuredContent?.applied)).toBe(true);
  await expect(app.locator('.news-location-marker')).toHaveCount(4);
  await page.screenshot({ path: testInfo.outputPath('news-markers-mobile.png'), fullPage: true });
  await app.locator('.news-location-marker').first().press('Enter');
  await expect(app.locator('.map-popup-sheet')).toContainText('Ports review shipping schedules as trade routes shift');
  await page.screenshot({ path: testInfo.outputPath('news-marker-mobile-details.png'), fullPage: true });
  await app.locator('.map-popup .popup-close').press('Enter');
  await expect(app.locator('.map-popup')).toHaveCount(0);
  await page.evaluate(items => (window as any).sendResult({ structuredContent: { categories: { politics: { items } }, feedStatuses: {}, generatedAt: '', requestedView: { map_layers: [] } } }), crowded);
  await expect(app.locator('.news-location-marker')).toHaveCount(150);
  await expect(app.locator('.map-truncation-summary')).toHaveText('150/350 markers');
  await page.evaluate(() => (window as any).sendResult({ structuredContent: { categories: {}, feedStatuses: {}, generatedAt: '' } }));
  await expect(app.locator('.panel')).toHaveCount(0);
  await expect(app.locator('.news-location-marker')).toHaveCount(0);
  await expect(app.locator('.map-truncation-summary')).toHaveCount(0);
  await expect(app.locator('#pluginStatus')).toContainText('No news is available');
  expect(errors).toEqual([]);
});
