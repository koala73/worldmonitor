import { expect, test, type Page } from '@playwright/test';

// Exercise the real Settings page and rendering with a controlled native bridge.
// This does not exercise Windows WebView2 or the real sidecar.
async function openDiagnostics(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let entries = Array.from({ length: 200 }, (_, index) => ({
      timestamp: new Date(Date.UTC(2026, 10, 6, 12, 0, index)).toISOString(),
      method: 'GET', path: `/api/example/${index}?query=${'long-path-'.repeat(30)}`,
      status: index % 10 === 0 ? 503 : 200, durationMs: 12,
    }));
    Object.assign(window, { __TAURI__: { core: { invoke: async (command: string, payload?: { request?: { path?: string; method?: string } }) => {
      if (command === 'get_local_api_port') return 46123;
      if (command === 'list_configured_secret_keys') return [];
      if (command === 'proxy_local_api_request') {
        if (payload?.request?.method === 'DELETE') entries = [];
        const data = payload?.request?.path === '/api/local-traffic-log' ? { entries } : { verboseMode: false };
        return { status: 200, headers: { 'content-type': 'application/json' }, body: Array.from(new TextEncoder().encode(JSON.stringify(data))) };
      }
      return null;
    } } } });
  });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.hostname === '127.0.0.1' ? route.continue() : route.fulfill({ json: {} });
  });
  await page.goto('/settings.html');
  await page.getByRole('tab', { name: 'Debug & Logs' }).click();
  await expect(page.locator('#trafficLog tbody tr')).toHaveCount(200);
}

async function expectFooterAccessible(page: Page): Promise<void> {
  for (const id of ['cancelBtn', 'okBtn']) {
    const button = page.locator(`#${id}`);
    await expect(button).toBeInViewport({ ratio: 1 });
    await button.focus();
    await expect(button).toBeFocused();
    await button.click({ trial: true });
  }
}

test('diagnostics fills tall windows and shrinks back without losing controls', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 720 });
  await openDiagnostics(page);
  const log = page.locator('#trafficLog');
  const compactHeight = await log.evaluate(el => el.clientHeight);
  await expectFooterAccessible(page);
  await page.screenshot({ path: testInfo.outputPath('diagnostics-compact.png') });

  await page.setViewportSize({ width: 1600, height: 1200 });
  await expect.poll(() => log.evaluate(el => el.clientHeight)).toBeGreaterThan(compactHeight + 350);
  await expect.poll(() => log.evaluate(el => el.clientHeight)).toBeGreaterThan(600);
  await expectFooterAccessible(page);
  expect(await log.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  expect(await page.locator('#contentArea').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('diagnostics-tall.png') });

  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await expect(log).toHaveCount(0);
  await page.getByRole('tab', { name: 'Debug & Logs' }).click();
  await expect(page.locator('#trafficLog tbody tr')).toHaveCount(200);
  await page.setViewportSize({ width: 820, height: 480 });
  await expectFooterAccessible(page);
  await log.scrollIntoViewIfNeeded();
  expect(await log.evaluate(el => el.clientHeight)).toBeGreaterThan(80);
  expect(await log.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('diagnostics-minimum.png') });
});

test('refresh, sticky headers, Clear and enlarged text remain usable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 720 });
  await openDiagnostics(page);
  const log = page.locator('#trafficLog');
  await log.evaluate(el => { el.scrollTop = 600; });
  const scrollTop = await log.evaluate(el => el.scrollTop);
  const header = log.locator('th').first();
  expect(Math.abs((await header.boundingBox())!.y - (await log.boundingBox())!.y)).toBeLessThan(2);
  // Wait for an actual auto-refresh render, rather than a fixed timeout.
  await log.evaluate(el => { new MutationObserver(() => el.setAttribute('data-refreshed', 'true')).observe(el, { childList: true }); });
  await expect(log).toHaveAttribute('data-refreshed', 'true', { timeout: 10000 });
  expect(await log.evaluate(el => el.scrollTop)).toBe(scrollTop);
  await page.locator('#autoRefreshLog').uncheck();
  await log.evaluate(el => el.removeAttribute('data-refreshed'));
  await page.locator('#refreshLogBtn').click();
  await expect(log).toHaveAttribute('data-refreshed', 'true');
  expect(await log.evaluate(el => el.scrollTop)).toBe(scrollTop);

  // Exercise enlarged text with a full log at the native minimum window size.
  await page.setViewportSize({ width: 820, height: 480 });
  await page.locator('.settings-shell').evaluate(el => el.style.setProperty('--wm-panel-effective-scale', '1.5'));
  await expectFooterAccessible(page);
  await log.scrollIntoViewIfNeeded();
  const logBox = (await log.boundingBox())!;
  const cardBox = (await page.locator('#diagnosticsSection').boundingBox())!;
  expect(logBox.y + logBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height);
  expect(await page.locator('#contentArea').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('diagnostics-minimum-large-text.png') });

  await page.locator('#clearLogBtn').click();
  await expect(page.locator('#trafficCount')).toHaveText('(0)');
  await expect(log.locator('tbody tr')).toHaveCount(0);
  await page.locator('#refreshLogBtn').click();
  await expect(log.locator('.diag-empty')).toHaveText('No traffic recorded yet.');
  await expectFooterAccessible(page);
  await page.locator('#clearLogBtn').scrollIntoViewIfNeeded();
  await expect(page.locator('#clearLogBtn')).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: testInfo.outputPath('diagnostics-empty.png') });
});
