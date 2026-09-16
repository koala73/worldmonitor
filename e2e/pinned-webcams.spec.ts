import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const base = 'https://webcams.windy.com/webcams/public/embed/player';
const fixture = { webcamId: '123', title: 'Saved camera', lat: 25, lng: 55, category: 'city', country: 'AE', playerUrl: `${base}?webcamId=123&playerType=month&interactive=true`, active: true, pinnedAt: 1 };
const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'));
const csp = vercel.headers.flatMap((entry: { headers: { key: string; value: string }[] }) => entry.headers).find((header: { key: string }) => header.key === 'Content-Security-Policy').value;

test('filters restored and imported records before frame navigation under shipped CSP', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const navigations: string[] = [];
  await page.route('**/tests/pinned-webcams-harness.html', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': csp } });
  });
  await page.route('https://webcams.windy.com/**', route => {
    navigations.push(route.request().url());
    return route.fulfill({ contentType: 'text/html', body: '<html><body style="background:#172831;color:#b5e2da;font:20px sans-serif;padding:30px">Windy player test response</body></html>' });
  });
  await page.addInitScript(({ fixture }) => {
    localStorage.setItem('wm-pinned-webcams', JSON.stringify([null, {}, fixture, { ...fixture, webcamId: '456', title: 'Rejected URL uses safe fallback', playerUrl: 'javascript:parent.__webcamCanary=true' }]));
  }, { fixture });
  await page.goto('/tests/pinned-webcams-harness.html');
  const frames = page.locator('.pinned-webcam-iframe');
  await expect(frames).toHaveCount(2);
  await expect(frames.nth(0)).toHaveAttribute('src', fixture.playerUrl);
  await expect(frames.nth(1)).toHaveAttribute('src', `${base}/456/day`);
  await page.getByRole('button', { name: 'Pin provider camera', exact: true }).click();
  await expect(frames).toHaveCount(3);
  await expect(frames.nth(2)).toHaveAttribute('src', `${base}/789/day`);
  await expect.poll(() => navigations.length).toBeGreaterThanOrEqual(3);
  await expect(page.frameLocator('.pinned-webcam-iframe').first().locator('body')).toContainText('Windy player test response');
  expect(await page.evaluate(() => Reflect.get(window, '__webcamCanary'))).toBeUndefined();
  await page.screenshot({ path: testInfo.outputPath('validated-pins-desktop.png'), fullPage: true });
  await page.getByTitle('Unpin', { exact: true }).nth(2).press('Enter');
  await expect(frames).toHaveCount(2);
  await page.getByTitle('Hide stream', { exact: true }).nth(0).click();
  await expect(frames).toHaveCount(1);
  await page.locator('#import').setInputFiles({ name: 'settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ version: 1, data: { 'wm-pinned-webcams': JSON.stringify([null, { ...fixture, playerUrl: 'https://www.youtube.com/embed/canary' }]) } })) });
  await expect(page.locator('#status')).toHaveText('Imported and read');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('wm-pinned-webcams')!))).toEqual([{ ...fixture, playerUrl: `${base}/123/day` }]);
  await expect(frames).toHaveCount(1);
  await expect(frames).toHaveAttribute('src', `${base}/123/day`);
  await expect(page.frameLocator('.pinned-webcam-iframe').locator('body')).toContainText('Windy player test response');
  await page.screenshot({ path: testInfo.outputPath('imported-fallback-desktop.png'), fullPage: true });
  expect(navigations.every(url => new URL(url).origin === 'https://webcams.windy.com')).toBe(true);
});

test('documents CSP limits of safe legacy canaries without claiming parent-origin execution', async ({ page }) => {
  await page.route('**/csp-canary', route => route.fulfill({ contentType: 'text/html', headers: { 'content-security-policy': csp }, body: '<html><body>Legacy navigation canary</body></html>' }));
  await page.route('**/unrelated-same-origin', route => route.fulfill({ contentType: 'text/html', body: '<html><body>Unrelated same-origin page</body></html>' }));
  await page.goto('/csp-canary');
  await page.evaluate(() => {
    Reflect.set(window, '__violations', []);
    document.addEventListener('securitypolicyviolation', event => Reflect.get(window, '__violations').push(event.effectiveDirective));
    for (const src of ['javascript:parent.__webcamCanary=true', 'data:text/html,<script>parent.__webcamCanary=true</script>', 'https://example.org/canary', '/unrelated-same-origin']) {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups');
      frame.src = src;
      document.body.appendChild(frame);
    }
  });
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__violations').length)).toBeGreaterThanOrEqual(3);
  await expect(page.frameLocator('iframe').last().locator('body')).toHaveText('Unrelated same-origin page');
  expect(await page.evaluate(() => Reflect.get(window, '__webcamCanary'))).toBeUndefined();
});
