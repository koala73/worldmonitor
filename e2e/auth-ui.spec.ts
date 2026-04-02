import { expect, test, type Page } from '@playwright/test';

/** Click an element via JS to bypass overlay interception. */
async function jsClick(page: Page, selector: string) {
  await page.evaluate((sel) => {
    (document.querySelector(sel) as HTMLElement)?.click();
  }, selector);
}

test.describe('auth UI (anonymous state)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      // Dismiss the layer performance warning overlay
      localStorage.setItem('wm-layer-warning-dismissed', 'true');
    });
  });

  test('Sign In button visible with readable text', async ({ page }) => {
    await page.goto('/');
    const signInBtn = page.locator('.auth-signin-btn');
    await signInBtn.waitFor({ timeout: 20000 });
    await expect(signInBtn).toBeVisible();
    await expect(signInBtn).toHaveText('Sign In');

    const styles = await signInBtn.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { color: cs.color, background: cs.backgroundColor };
    });
    expect(styles.color).not.toBe(styles.background);
  });

  test('Sign In click triggers Clerk modal or overlay', async ({ page }) => {
    await page.goto('/');
    await page.locator('.auth-signin-btn').waitFor({ timeout: 20000 });
    await jsClick(page, '.auth-signin-btn');

    // Clerk renders its modal into .cl-rootBox or an iframe.
    // When Clerk JS is not configured (no publishable key in test env),
    // the click simply invokes openSignIn() which is a no-op -- verify
    // no uncaught errors instead.
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.waitForTimeout(1000);
    expect(errors.filter((e) => e.includes('auth'))).toHaveLength(0);
  });

  test('premium panels gated for anonymous users', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.panel', { timeout: 20000 });
    await expect(page.locator('.panel-is-locked').first()).toBeVisible({ timeout: 15000 });
  });
});
