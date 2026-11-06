import { test, expect } from '@playwright/test';

const fixture = {
  status: 'available', ip: '2.249.90.120',
  asns: [{ asn: 3301, holder: 'TELIANET-SWEDEN Telia Company AB (synthetic test response)' }],
  prefix: '2.248.0.0/14', isLessSpecific: true,
  hostnames: ['2-249-90-120-no2330.tbcn.telia.com'],
  lookupAt: '2026-11-06T10:00:00Z', routingAt: '2026-11-06T08:00:00Z',
};

for (const language of ['en', 'de']) {
  for (const width of [1280, 390]) {
    test.describe(`Cyber network popup ${language} ${width}px`, () => {
      test.use({ viewport: { width, height: 900 } });
      test('loads only on expansion, copies and stays readable', async ({ page, context }, testInfo) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        let requests = 0;
        await page.route('**/api/cyber/v1/get-network-info*', async route => {
          requests++;
          expect(new URL(route.request().url()).searchParams.get('ip')).toBe(fixture.ip);
          await route.fulfill({ json: fixture });
        });
        await page.goto(`/tests/mobile-map-harness.html?cyber=1&lang=${language}`);
        await page.waitForFunction(() => (window as unknown as { __mobileMapHarness?: { ready: boolean } }).__mobileMapHarness?.ready);
        await page.locator('#mapOverlays .hotspot').click();
        const popup = page.locator('.map-popup');
        const details = popup.locator('.cyber-network-info');
        await expect(details).toBeVisible();
        expect(requests).toBe(0);
        await popup.screenshot({ path: testInfo.outputPath(`cyber-collapsed-${language}-${width}.png`) });
        await details.locator('summary').click();
        await expect(details).toContainText('AS3301');
        await expect(details).toContainText('Telia Company AB');
        await expect(details).toContainText('RIPEstat / RIPE NCC');
        if (language === 'de') await expect(details.locator('summary')).toHaveText('Netzwerkinformationen');
        else await expect(details).toContainText('do not identify the attacker');
        await details.locator('[data-copy-network="AS3301"]').click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('AS3301');
        await expect(details.locator('.cyber-copy-status')).toHaveText(language === 'de' ? 'Kopiert.' : 'Copied.');
        expect(await popup.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
        const rect = await popup.boundingBox();
        expect(rect!.x).toBeGreaterThanOrEqual(0);
        expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
        await details.locator('summary').click();
        await details.locator('summary').click();
        expect(requests).toBe(1);
        await details.locator('summary').scrollIntoViewIfNeeded();
        await popup.screenshot({ path: testInfo.outputPath(`cyber-network-${language}-${width}.png`) });
        await details.locator('.popup-link').scrollIntoViewIfNeeded();
        await popup.screenshot({ path: testInfo.outputPath(`cyber-network-details-${language}-${width}.png`) });
        if (width === 390) {
          expect(await popup.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
          const scrollGesture = await details.evaluate(target => {
            const popup = target.closest('.map-popup') as HTMLElement;
            const touch = (y: number) => new Touch({ identifier: 1, target, clientX: 100, clientY: y });
            const start = touch(300);
            target.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [start] }));
            const move = new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [touch(500)] });
            target.dispatchEvent(move);
            const result = { prevented: move.defaultPrevented, dragging: popup.classList.contains('dragging') };
            target.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] }));
            return result;
          });
          expect(scrollGesture).toEqual({ prevented: false, dragging: false });
          await expect(popup).toBeVisible();
        }
      });
    });
  }
}

test('shows provider failure and recovers when the popup is reopened', async ({ page }, testInfo) => {
  let failed = true;
  await page.route('**/api/cyber/v1/get-network-info*', route => route.fulfill(failed
    ? { status: 503, json: { error: 'Provider unavailable' } } : { json: fixture }));
  await page.goto('/tests/mobile-map-harness.html?cyber=1&lang=en');
  await page.waitForFunction(() => (window as unknown as { __mobileMapHarness?: { ready: boolean } }).__mobileMapHarness?.ready);
  const marker = page.locator('#mapOverlays .hotspot');
  await marker.click();
  await page.locator('.cyber-network-info summary').click();
  await expect(page.locator('.cyber-network-result')).toContainText('Network lookup failed');
  await page.locator('.map-popup').screenshot({ path: testInfo.outputPath('cyber-network-error.png') });
  await page.locator('.popup-close').click();
  failed = false;
  await marker.click();
  await page.locator('.cyber-network-info summary').click();
  await expect(page.locator('.cyber-network-result')).toContainText('AS3301');
  await page.locator('.map-popup').screenshot({ path: testInfo.outputPath('cyber-network-recovered.png') });
});
