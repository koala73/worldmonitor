import { expect, test, type Page } from '@playwright/test';

/**
 * #5912: desktop-runtime detection must not depend on the Tauri bridge
 * globals, which are ABSENT during desktop:dev early boot and in
 * VITE_DESKTOP_RUNTIME=1 browser builds. isDesktopRuntime() covers that gap
 * through its user-agent sniff; the raw `'__TAURI__' in window` checks this
 * issue converged did not.
 *
 * This spec reproduces the early-boot signal set exactly: a Tauri user agent
 * with NO bridge globals (the web bundle under the standard e2e server never
 * attaches them). The observable is main.ts's context-menu suppression — a
 * site that sniffed raw globals, so before the fix it skipped the listener
 * in precisely the environment it exists for.
 */

const TAURI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Tauri/2.0';

async function contextMenuDefaultPrevented(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

async function loadDashboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('worldmonitor-variant', 'happy');
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  // main.ts module scope has run once panels exist.
  await page.waitForSelector('.panel[data-panel]', { state: 'attached', timeout: 60_000 });
}

test.describe('desktop early boot (Tauri UA, no bridge globals) — #5912', () => {
  test.describe('desktop runtime', () => {
    test.use({ userAgent: TAURI_UA });

    test('context-menu suppression is active without the bridge globals', async ({ page }) => {
      await loadDashboard(page);

      // Premise: this run really is bridge-less — the UA is the ONLY signal.
      const hasGlobals = await page.evaluate(
        () => '__TAURI__' in window || '__TAURI_INTERNALS__' in window,
      );
      expect(hasGlobals).toBe(false);

      expect(await contextMenuDefaultPrevented(page)).toBe(true);
    });
  });

  test.describe('web runtime (control)', () => {
    test('context menu stays native in a plain browser', async ({ page }) => {
      await loadDashboard(page);
      expect(await contextMenuDefaultPrevented(page)).toBe(false);
    });
  });
});
