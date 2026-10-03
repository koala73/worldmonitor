import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { buildUiResourceRead, MARKET_RADAR_UI_URI } from '../api/mcp/ui/registry';

test.describe.configure({ mode: 'serial' });
let bootstrap: string;
const fixture = { cached_at: '2026-10-03T18:30:00Z', data: {
  'stocks-bootstrap': { quotes: Array.from({ length: 12 }, (_, i) => ({
    symbol: 'TEST' + i, name: 'Controlled asset ' + i, price: 100 + i, change: 1.25,
    sparkline: i === 11 ? [] : [90, 110, 100],
  })) },
} };

test.beforeAll(async () => {
  test.setTimeout(120_000);
  execFileSync('npm', ['run', 'build:plugin'], { timeout: 120_000, stdio: 'pipe' });
  const previous = globalThis.fetch;
  globalThis.fetch = async url => {
    expect(String(url)).toBe('https://www.worldmonitor.app/plugin/market.html');
    return new Response(readFileSync('dist/plugin/market.html', 'utf8'), { headers: { 'Content-Type': 'text/html' } });
  };
  try {
    const response = await buildUiResourceRead(1, MARKET_RADAR_UI_URI, {});
    bootstrap = (await response.json()).result.contents[0].text;
  } finally { globalThis.fetch = previous; }
});

for (const [name, width, height] of [['desktop', 1280, 1000], ['mobile', 390, 900]] as const) {
  test('built market document, stylesheet and module load through the resource bootstrap on ' + name, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const projection = name === 'mobile'
      ? { cached_at: fixture.cached_at, quotes: fixture.data['stocks-bootstrap'].quotes } : fixture;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const assets: string[] = [];
    await page.route('https://www.worldmonitor.app/plugin/**', async route => {
      const url = new URL(route.request().url());
      expect(url.pathname).toMatch(/^\/plugin\/(market.html|assets\/[a-zA-Z0-9_.-]+\.(js|css))$/);
      assets.push(url.pathname);
      await route.fulfill({
        body: readFileSync('dist' + url.pathname),
        contentType: url.pathname.endsWith('.html') ? 'text/html' : url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css',
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    });
    await page.setContent('<iframe sandbox="allow-scripts" style="width:100%;height:900px;border:0"></iframe>');
    await page.evaluate(({ bootstrap, fixture }) => {
      const sent: unknown[] = [];
      Object.assign(window, { marketMessages: sent });
      window.addEventListener('message', event => {
        sent.push(event.data);
        if (event.data?.method !== 'ui/initialize') return;
        const target = event.source as Window;
        target.postMessage({ jsonrpc: '2.0', id: event.data.id, result: { hostContext: { theme: 'dark' } } }, '*');
        target.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: {
          result: { structuredContent: { projection: fixture }, _meta: { 'worldmonitor/usage': {
            unit: 'requests', remaining: 47, limit: 50, resetsAt: '2026-10-04T00:00:00Z',
          } } },
        } }, '*');
      });
      document.querySelector('iframe')!.srcdoc = bootstrap;
    }, { bootstrap, fixture: projection });
    const frame = page.frameLocator('iframe');
    await expect(frame.locator('.qsym')).toHaveCount(12);
    await expect(frame.locator('.terminal-chart')).toHaveCount(0);
    const summary = frame.locator('summary').first();
    await summary.press('Enter');
    await expect(frame.locator('details').first()).toHaveAttribute('open', '');
    await expect(frame.locator('.terminal-chart')).toBeVisible();
    await expect(frame.locator('.terminal-chart')).toContainText('LAST 100');
    await expect(frame.locator('#marketUsage')).toContainText('47 panel requests remaining');
    const last = frame.getByText('Controlled asset 11', { exact: true });
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    expect(await frame.locator('body').evaluate(body => body.scrollWidth > body.clientWidth)).toBe(false);
    expect(await frame.locator('#marketContent').evaluate(element => getComputedStyle(element).maxHeight)).toBe('560px');
    expect(assets.some(asset => asset.endsWith('.css'))).toBe(true);
    expect(assets.some(asset => asset.endsWith('.js'))).toBe(true);
    expect(assets.filter(asset => asset === '/plugin/market.html')).toHaveLength(1);
    expect(await page.evaluate(() => (window as unknown as { marketMessages: { method: string }[] }).marketMessages
      .filter(message => !['ui/initialize', 'ui/notifications/initialized', 'ui/notifications/size-changed'].includes(message.method)))).toEqual([]);
    expect(errors).toEqual([]);
  });
}
