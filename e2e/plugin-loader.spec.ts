import { test, expect, type Page } from '@playwright/test';
import { buildPluginShell } from '../api/mcp/ui/_plugin-loader';

const origin = 'https://www.worldmonitor.app';
const headers = { 'Access-Control-Allow-Origin': '*' };
const currentHtml = (root: string, version: string) => `<!doctype html><html><head><link rel="stylesheet" href="/plugin/assets/current-${version}.css"></head><body><main id="${root}">Loading current panel</main><script type="module" src="/plugin/assets/current-${version}.js"></script><script src="https://static.cloudflareinsights.com/beacon.min.js"></script></body></html>`;

for (const failure of ['stalled', 'unavailable'] as const) {
  test(`retry recovers a shared chunk that is ${failure} before the abandoned graph completes`, async ({ page }) => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let recovered = false;
    const sharedRequests: string[] = [];
    await page.route(`${origin}/plugin/country.html`, route => route.fulfill({ headers, contentType: 'text/html', body: currentHtml('countryRoot', 'A') }));
    await page.route(`${origin}/plugin/assets/**`, async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('.css')) return route.fulfill({ headers, contentType: 'text/css', body: '' });
      if (url.pathname.endsWith('/shared.js')) {
        sharedRequests.push(url.href);
        if (!recovered) {
          if (failure === 'stalled') await blocked;
          else return route.fulfill({ headers, status: 503, contentType: 'application/javascript', body: '' });
        }
        return route.fulfill({ headers, contentType: 'application/javascript', body: 'export const panel="Recovered shared graph";' });
      }
      return route.fulfill({ headers, contentType: 'application/javascript', body: `import {panel} from './shared.js';parent.postMessage({evaluated:true},'*');const url=new URL(import.meta.url);const attempt=url.pathname.match(/boot-(\\d+)/)?.[1];document.addEventListener('wm-plugin-boot-'+attempt,()=>{document.getElementById('countryRoot').textContent=panel;parent.postMessage({mounted:true},'*');},{once:true});` });
    });
    await page.clock.install();
    const frame = await mount(page, buildPluginShell({ origin, entry: 'country.html', root: 'countryRoot' }));
    await page.evaluate(() => { Object.assign(window, { mounts: 0, evaluations: 0 }); window.addEventListener('message', event => { if (event.data?.mounted) (window as unknown as { mounts: number }).mounts++; if (event.data?.evaluated) (window as unknown as { evaluations: number }).evaluations++; }); });
    await expect.poll(() => sharedRequests.length).toBe(1);
    if (failure === 'stalled') await page.clock.fastForward(11000);
    await expect(frame.getByRole('button', { name: 'Retry interface' })).toBeVisible();
    recovered = true;
    await frame.getByRole('button', { name: 'Retry interface' }).click();
    await expect(frame.locator('main')).toHaveText('Recovered shared graph');
    expect(new Set(sharedRequests).size).toBe(2);
    release();
    await expect.poll(() => page.evaluate(() => (window as unknown as { evaluations: number }).evaluations)).toBe(failure === 'stalled' ? 2 : 1);
    await expect.poll(() => page.evaluate(() => (window as unknown as { mounts: number }).mounts)).toBe(1);
  });
}

async function mount(page: Page, shell: string) {
  await page.setContent('<iframe title="WorldMonitor" sandbox="allow-scripts" style="width:100%;height:600px;border:0"></iframe>');
  await page.locator('iframe').evaluate((frame, html) => { (frame as HTMLIFrameElement).srcdoc = html; }, shell);
  return page.frameLocator('iframe');
}

for (const entry of ['country.html', 'plugin.html'] as const) {
  test(`cached ${entry} shell loads both current deployments under its CSP`, async ({ page }) => {
    const root = entry === 'country.html' ? 'countryRoot' : 'pluginRoot';
    const shell = buildPluginShell({ origin, entry, root }).replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' ${origin}; style-src 'unsafe-inline' ${origin}; connect-src ${origin}; base-uri ${origin}">`);
    const requests: string[] = [];
    page.on('request', request => requests.push(request.url()));
    let version = 'A';
    await page.route(`${origin}/plugin/${entry}`, route => route.fulfill({ headers, contentType: 'text/html', body: currentHtml(root, version) }));
    await page.route(`${origin}/plugin/assets/**`, route => route.fulfill({ headers, contentType: route.request().url().endsWith('.css') ? 'text/css' : 'application/javascript', body: route.request().url().endsWith('.css') ? 'main{color:rgb(1,2,3)}' : `function mountPlugin(){document.getElementById('${root}').textContent='Current ${version} panel';}document.addEventListener('wm-plugin-boot-'+new URL(import.meta.url).pathname.match(/boot-(\\d+)/)?.[1],mountPlugin,{once:true});` }));
    const frame = await mount(page, shell);
    await expect(frame.locator('main')).toHaveText('Current A panel');
    version = 'B';
    await mount(page, shell);
    await expect(frame.locator('main')).toHaveText('Current B panel');
    await expect(frame.locator('main')).toHaveCSS('color', 'rgb(1, 2, 3)');
    expect(requests.some(url => url.includes('cloudflareinsights'))).toBe(false);
    expect(requests.some(url => url.includes('/mcp'))).toBe(false);
  });
}

for (const failure of ['document', 'module', 'style'] as const) {
  test(`${failure} failure recovers through retry even with the same asset filename`, async ({ page }, info) => {
    let failed = true;
    let documentReads = 0;
    await page.route(`${origin}/plugin/country.html`, route => {
      documentReads++;
      return route.fulfill({ headers, status: failed && failure === 'document' ? 503 : 200, contentType: 'text/html', body: currentHtml('countryRoot', 'same') });
    });
    await page.route(`${origin}/plugin/assets/**`, route => {
      const css = route.request().url().endsWith('.css');
      return route.fulfill({ headers, status: failed && ((failure === 'style' && css) || (failure === 'module' && !css)) ? 404 : 200, contentType: css ? 'text/css' : 'application/javascript', body: css ? 'main{padding:24px}' : "function mountPlugin(){document.getElementById('countryRoot').textContent='Recovered current panel';}document.addEventListener('wm-plugin-boot-'+new URL(import.meta.url).pathname.match(/boot-(\\d+)/)?.[1],mountPlugin,{once:true});" });
    });
    const frame = await mount(page, buildPluginShell({ origin, entry: 'country.html', root: 'countryRoot' }));
    await expect(frame.getByRole('status')).toContainText('could not load');
    if (failure === 'module') await page.screenshot({ path: info.outputPath('interface-failure.png') });
    failed = false;
    await frame.getByRole('button', { name: 'Retry interface' }).click();
    await expect(frame.locator('main')).toHaveText('Recovered current panel');
    expect(documentReads).toBe(2);
    if (failure === 'module') await page.screenshot({ path: info.outputPath('interface-recovered.png') });
  });
}

for (const [index, html] of [
  '<html><body>Sign in</body></html>',
  currentHtml('countryRoot', 'bad').replace('/plugin/assets/current-bad.js', 'https://example.com/foreign.js'),
  currentHtml('countryRoot', 'bad').replace('/plugin/assets/current-bad.css', 'https://example.com/foreign.css'),
  currentHtml('countryRoot', 'bad') + 'x'.repeat(131073),
].entries()) {
  test(`invalid document fails before loading scripts (${index})`, async ({ page }) => {
    const assets: string[] = [];
    page.on('request', request => { if (!request.url().endsWith('/country.html')) assets.push(request.url()); });
    await page.route(`${origin}/plugin/country.html`, route => route.fulfill({ headers, contentType: 'text/html', body: html }));
    const frame = await mount(page, buildPluginShell({ origin, entry: 'country.html', root: 'countryRoot' }));
    await expect(frame.getByRole('status')).toContainText('could not load');
    expect(assets).toEqual([]);
  });
}

test('a stalled module reaches retry and a late import cannot mount the abandoned panel', async ({ page }) => {
  await page.clock.install();
  const root = 'countryRoot';
  let stalled = true;
  let release: () => void = () => {};
  const blocked = new Promise<void>(resolve => { release = resolve; });
  await page.route(`${origin}/plugin/country.html`, route => route.fulfill({ headers, contentType: 'text/html', body: currentHtml(root, 'stall') }));
  await page.route(`${origin}/plugin/assets/**`, async route => {
    const css = route.request().url().endsWith('.css');
    if (!css && stalled) await blocked;
    await route.fulfill({ headers, contentType: css ? 'text/css' : 'application/javascript', body: css ? 'main{color:#eee}' : `parent.postMessage({moduleEvaluated:true},'*');function mountPlugin(){document.getElementById('${root}').textContent='Current mounted panel';parent.postMessage({moduleMounted:true},'*');}if(document.documentElement.dataset.wmPluginManagedBoot==='true')document.addEventListener('wm-plugin-boot-'+new URL(import.meta.url).pathname.match(/boot-(\\d+)/)?.[1],mountPlugin,{once:true});else mountPlugin();` });
  });
  await page.setContent('<iframe sandbox="allow-scripts" style="width:100%;height:600px"></iframe>');
  await page.evaluate(() => {
    Object.assign(window, { moduleMounts: 0, moduleLoads: 0 });
    window.addEventListener('message', event => {
      if (event.source !== document.querySelector('iframe')!.contentWindow) return;
      const counts = window as unknown as { moduleLoads: number; moduleMounts: number };
      if (event.data?.moduleEvaluated) counts.moduleLoads++;
      if (event.data?.moduleMounted) counts.moduleMounts++;
    });
  });
  await page.locator('iframe').evaluate((frame, html) => { (frame as HTMLIFrameElement).srcdoc = html; }, buildPluginShell({ origin, entry: 'country.html', root }));
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('main')).toHaveText('Loading current panel');
  await page.clock.fastForward(11000);
  await expect(frame.getByRole('button', { name: 'Retry interface' })).toBeVisible({ timeout: 2000 });
  stalled = false;
  expect(await page.evaluate(() => (window as unknown as { moduleLoads: number }).moduleLoads)).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { moduleMounts: number }).moduleMounts)).toBe(0);
  await expect(frame.getByRole('status')).toContainText('could not load');
  await frame.getByRole('button', { name: 'Retry interface' }).click();
  await expect(frame.locator('main')).toHaveText('Current mounted panel');
  expect(await page.evaluate(() => (window as unknown as { moduleMounts: number }).moduleMounts)).toBe(1);
  release();
  await expect.poll(() => page.evaluate(() => (window as unknown as { moduleLoads: number }).moduleLoads)).toBe(2);
  expect(await page.evaluate(() => (window as unknown as { moduleMounts: number }).moduleMounts)).toBe(1);
});


test('host-injected about:blank document recovers without navigating away', async ({ page }, info) => {
  let failed = true;
  let documentReads = 0;
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  await page.route(`${origin}/plugin/country.html`, route => {
    documentReads++;
    return route.fulfill({ headers, status: failed ? 503 : 200, contentType: 'text/html', body: currentHtml('countryRoot', 'injected') });
  });
  await page.route(`${origin}/plugin/assets/**`, route => {
    const css = route.request().url().endsWith('.css');
    return route.fulfill({ headers, contentType: css ? 'text/css' : 'application/javascript', body: css ? 'main{padding:24px}' : "function mountPlugin(){document.getElementById('countryRoot').textContent='Recovered injected panel';}document.addEventListener('wm-plugin-boot-'+new URL(import.meta.url).pathname.match(/boot-(\\d+)/)?.[1],mountPlugin,{once:true});" });
  });
  await page.setContent('<iframe title="WorldMonitor" sandbox="allow-scripts" style="width:100%;height:600px;border:0"></iframe>');
  const injected = page.frames().find(frame => frame !== page.mainFrame())!;
  await injected.evaluate(html => { document.open(); document.write(html); document.close(); }, buildPluginShell({ origin, entry: 'country.html', root: 'countryRoot' }));
  const frame = page.frameLocator('iframe');
  await expect(frame.getByRole('status')).toContainText('could not load');
  await page.screenshot({ path: info.outputPath('injected-interface-failure.png') });
  failed = false;
  await frame.getByRole('button', { name: 'Retry interface' }).click();
  await expect(frame.locator('main')).toHaveText('Recovered injected panel');
  expect(documentReads).toBe(2);
  expect(requests.some(url => url.includes('/mcp'))).toBe(false);
  await page.screenshot({ path: info.outputPath('injected-interface-recovered.png') });
});

const PANEL_INITIALIZE = {
  'plugin.html': { root: 'pluginRoot', params: { appInfo: { name: 'WorldMonitor', version: '1.0.0' }, appCapabilities: { tools: {}, availableDisplayModes: ['inline', 'fullscreen'] }, protocolVersion: '2026-01-26' } },
  'country.html': { root: 'countryRoot', params: { appInfo: { name: 'WorldMonitor country brief', version: '1.0.0' }, appCapabilities: { tools: {}, availableDisplayModes: ['inline', 'fullscreen'] }, protocolVersion: '2026-01-26' } },
  'market.html': { root: 'marketRoot', params: { appInfo: { name: 'worldmonitor-market-radar', version: '2.0.0' }, appCapabilities: {}, protocolVersion: '2026-01-26' } },
} as const;

type HostMessage = { jsonrpc?: string; id?: unknown; method?: string; params?: unknown; echo?: string | null; adopted?: string };

async function mountWithHost(page: Page, shell: string, { answer = true, notify = false, reject = false } = {}) {
  await page.setContent('<iframe title="WorldMonitor" sandbox="allow-scripts" style="width:100%;height:600px;border:0"></iframe>');
  await page.evaluate(({ answer, notify, reject }) => {
    const frame = document.querySelector('iframe')!;
    const host = window as unknown as { hostMessages: unknown[]; notified: boolean; answerInitialize: () => void };
    host.hostMessages = [];
    host.notified = false;
    const post = (message: object) => frame.contentWindow!.postMessage({ jsonrpc: '2.0', ...message }, '*');
    let initializeId: unknown;
    host.answerInitialize = () => post(reject
      ? { id: initializeId, error: { code: -32000, message: 'Fixture initialization failed' } }
      : { id: initializeId, result: { protocolVersion: '2026-01-26', hostCapabilities: {}, hostContext: { theme: 'light' } } });
    window.addEventListener('message', event => {
      if (event.source !== frame.contentWindow) return;
      host.hostMessages.push(event.data);
      if (event.data?.method === 'ui/initialize') {
        initializeId = event.data.id;
        if (answer) host.answerInitialize();
      }
      if (notify && event.data?.method === 'ui/notifications/initialized') {
        post({ method: 'ui/notifications/tool-input', params: { arguments: { country: 'JP' } } });
        post({ method: 'ui/notifications/tool-result', params: { structuredContent: { ok: true } } });
        host.notified = true;
      }
    });
  }, { answer, notify, reject });
  await page.locator('iframe').evaluate((frame, html) => { (frame as HTMLIFrameElement).srcdoc = html; }, shell);
  return {
    frame: page.frameLocator('iframe'),
    messages: () => page.evaluate(() => (window as unknown as { hostMessages: HostMessage[] }).hostMessages),
  };
}

const adoptingModule = (root: string) => `document.addEventListener('wm-plugin-boot-'+new URL(import.meta.url).pathname.match(/boot-(\\d+)/)?.[1],async()=>{const host=window.wmPluginHost;const result=await host.initialized;host.adopt(event=>parent.postMessage({echo:event.data?.method??null},'*'));document.getElementById('${root}').textContent='Adopted '+result.hostContext.theme;parent.postMessage({adopted:'${root}'},'*');},{once:true});`;

for (const [entry, { root, params }] of Object.entries(PANEL_INITIALIZE)) {
  test(`${entry} shell initializes with the host before its panel document loads`, async ({ page }) => {
    await page.route(`${origin}/plugin/${entry}`, () => {});
    const host = await mountWithHost(page, buildPluginShell({ origin, entry: entry as keyof typeof PANEL_INITIALIZE, root }), { answer: false });
    await expect.poll(async () => (await host.messages()).filter(message => message.method === 'ui/initialize').length, { timeout: 5000 }).toBe(1);
    const initialize = (await host.messages()).find(message => message.method === 'ui/initialize')!;
    expect(initialize.params).toEqual(params);
    expect(typeof initialize.id).toBe('string');
    expect((await host.messages()).some(message => message.method === 'ui/notifications/initialized')).toBe(false);
    await page.evaluate(() => (window as unknown as { answerInitialize: () => void }).answerInitialize());
    await expect.poll(async () => (await host.messages()).filter(message => message.method === 'ui/notifications/initialized').length, { timeout: 5000 }).toBe(1);
    await expect(host.frame.getByRole('status')).toHaveText('Loading WorldMonitor…');
  });
}

test('host notifications sent before the panel mounts reach the adopted panel exactly once', async ({ page }) => {
  let release!: () => void;
  const moduleGate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`${origin}/plugin/plugin.html`, route => route.fulfill({ headers, contentType: 'text/html', body: currentHtml('pluginRoot', 'early') }));
  await page.route(`${origin}/plugin/assets/**`, async route => {
    const css = route.request().url().endsWith('.css');
    if (!css) await moduleGate;
    await route.fulfill({ headers, contentType: css ? 'text/css' : 'application/javascript', body: css ? '' : adoptingModule('pluginRoot') });
  });
  const host = await mountWithHost(page, buildPluginShell({ origin, entry: 'plugin.html', root: 'pluginRoot' }), { notify: true });
  await expect.poll(() => page.evaluate(() => (window as unknown as { notified: boolean }).notified), { timeout: 5000 }).toBe(true);
  release();
  await expect(host.frame.locator('main')).toHaveText('Adopted light');
  await page.evaluate(() => document.querySelector('iframe')!.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'dark' } }, '*'));
  await expect.poll(async () => (await host.messages()).filter(message => 'echo' in message).length).toBe(3);
  await page.waitForTimeout(250);
  expect((await host.messages()).filter(message => 'echo' in message).map(message => message.echo)).toEqual([
    'ui/notifications/tool-input',
    'ui/notifications/tool-result',
    'ui/notifications/host-context-changed',
  ]);
});

test('retrying the interface does not initialize with the host a second time', async ({ page }) => {
  let failed = true;
  await page.route(`${origin}/plugin/country.html`, route => route.fulfill({ headers, status: failed ? 503 : 200, contentType: 'text/html', body: currentHtml('countryRoot', 'retry') }));
  await page.route(`${origin}/plugin/assets/**`, route => {
    const css = route.request().url().endsWith('.css');
    return route.fulfill({ headers, contentType: css ? 'text/css' : 'application/javascript', body: css ? '' : adoptingModule('countryRoot') });
  });
  const host = await mountWithHost(page, buildPluginShell({ origin, entry: 'country.html', root: 'countryRoot' }));
  await expect(host.frame.getByRole('status')).toContainText('could not load');
  failed = false;
  await host.frame.getByRole('button', { name: 'Retry interface' }).click();
  await expect(host.frame.locator('main')).toHaveText('Adopted light');
  const messages = await host.messages();
  expect(messages.filter(message => message.method === 'ui/initialize')).toHaveLength(1);
  expect(messages.filter(message => message.method === 'ui/notifications/initialized')).toHaveLength(1);
});

test('a host that rejects initialize reaches the panel as a failed handshake without an initialized notification', async ({ page }) => {
  await page.route(`${origin}/plugin/market.html`, route => route.fulfill({ headers, contentType: 'text/html', body: currentHtml('marketRoot', 'rejected') }));
  await page.route(`${origin}/plugin/assets/**`, route => {
    const css = route.request().url().endsWith('.css');
    return route.fulfill({ headers, contentType: css ? 'text/css' : 'application/javascript', body: css ? '' : "document.addEventListener('wm-plugin-boot-'+new URL(import.meta.url).pathname.match(/boot-(\\d+)/)?.[1],()=>{window.wmPluginHost.initialized.catch(error=>{document.getElementById('marketRoot').textContent='Rejected: '+error.message;});},{once:true});" });
  });
  const host = await mountWithHost(page, buildPluginShell({ origin, entry: 'market.html', root: 'marketRoot' }), { reject: true });
  await expect(host.frame.locator('main')).toHaveText('Rejected: Fixture initialization failed');
  expect((await host.messages()).map(message => message.method)).toEqual(['ui/initialize']);
});
