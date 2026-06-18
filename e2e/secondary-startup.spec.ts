import { expect, test } from '@playwright/test';

const SECONDARY_STARTUP_REQUEST =
  /(?:abacus\.worldmonitor\.app\/script\.js|fonts\.googleapis\.com\/css2|fonts\.gstatic\.com\/s\/(?:nunito|tajawal)|clerk\.worldmonitor\.app|ingest\.us\.sentry\.io|static\.cloudflareinsights\.com|\/_vercel\/insights\/script\.js|www\.youtube\.com\/iframe_api)/;

test.describe('secondary startup work', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('wm-layer-warning-dismissed', 'true');
      const idleCallbacks: Array<() => void> = [];
      (window as unknown as {
        requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => number;
        cancelIdleCallback: (id: number) => void;
        __wmRunDeferredIdle: () => void;
      }).requestIdleCallback = (cb) => {
        idleCallbacks.push(cb);
        return idleCallbacks.length;
      };
      (window as unknown as { cancelIdleCallback: (id: number) => void }).cancelIdleCallback = () => {};
      (window as unknown as { __wmRunDeferredIdle: () => void }).__wmRunDeferredIdle = () => {
        const callbacks = idleCallbacks.splice(0, idleCallbacks.length);
        for (const cb of callbacks) cb();
      };
    });
  });

  test('defers secondary startup requests until idle startup runs', async ({ page }) => {
    const secondaryRequests: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (SECONDARY_STARTUP_REQUEST.test(url)) secondaryRequests.push(url);
    });

    await page.goto('/');
    await page.locator('.auth-signin-btn, .panel').first().waitFor({ timeout: 20000 });
    await page.waitForTimeout(250);

    expect(secondaryRequests).toEqual([]);

    await page.evaluate(() => {
      (window as unknown as { __wmRunDeferredIdle?: () => void }).__wmRunDeferredIdle?.();
    });
    await expect.poll(() => secondaryRequests.some((url) => url.includes('abacus.worldmonitor.app/script.js'))).toBe(true);
    expect(secondaryRequests.some((url) => url.includes('www.youtube.com/iframe_api'))).toBe(false);
  });
});
