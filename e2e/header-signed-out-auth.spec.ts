import { expect, test } from '@playwright/test';

// #10464 — signed-out visitors get one header account action (Sign In) plus a
// free-account reason. Create account is folded into Clerk's sign-in flow.
// Tablet widths previously clipped the second CTA at the right edge.

const WIDTHS = [768, 834, 940, 1000] as const;

for (const width of WIDTHS) {
  test.describe(`signed-out header auth at ${width}px`, () => {
    test.use({ viewport: { width, height: 1112 } });

    test('keeps one Sign In action fully on screen', async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.setItem('wm-layer-warning-dismissed', 'true');
        localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
        localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
      });

      await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('html')).toHaveAttribute('data-wm-event-handlers-ready', 'true', {
        timeout: 45_000,
      });

      const auth = page.locator('#authWidgetMount .auth-header-widget');
      await expect(auth).toBeVisible({ timeout: 20_000 });
      await expect(auth.locator('.auth-signin-btn')).toBeVisible();
      await expect(auth.locator('.auth-signin-btn')).toHaveText('Sign In');
      await expect(auth.locator('.auth-signup-link')).toHaveCount(0);

      const clipped = await page.evaluate(() => {
        const signIn = document.querySelector<HTMLElement>('#authWidgetMount .auth-signin-btn');
        const reason = document.querySelector<HTMLElement>('#authWidgetMount .auth-free-reason');
        if (!signIn) {
          throw new Error('missing header auth controls');
        }

        const viewportWidth = window.innerWidth;
        const fullyOnScreen = (el: HTMLElement): boolean => {
          const rect = el.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= viewportWidth + 0.5;
        };
        const reasonShown = Boolean(
          reason
          && getComputedStyle(reason).display !== 'none'
          && reason.getBoundingClientRect().width > 1,
        );

        return {
          signInClipped: !fullyOnScreen(signIn),
          reasonShown,
          reasonClipped: reasonShown && reason ? !fullyOnScreen(reason) : false,
          accountActions: document.querySelectorAll('#authWidgetMount .auth-signin-btn, #authWidgetMount .auth-signup-link').length,
        };
      });

      expect(clipped.accountActions, 'exactly one header account action').toBe(1);
      expect(clipped.signInClipped, 'Sign In must not be clipped').toBe(false);
      expect(clipped.reasonClipped, 'free reason must not be clipped when shown').toBe(false);
      if (width === 834 || width === 940) {
        expect(clipped.reasonShown, `free reason should show at ${width}px`).toBe(true);
      }
    });
  });
}
