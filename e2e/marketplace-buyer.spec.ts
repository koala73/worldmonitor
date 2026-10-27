import { expect, test, type Page } from '@playwright/test';

const key = `wm_${'a'.repeat(40)}`;
const now = Date.now();

async function mockClerk(page: Page, signedIn: boolean): Promise<void> {
  await page.route(/\/src\/services\/clerk\.ts(?:\?|$)/, async (route) => {
    await route.fulfill({
      contentType: 'text/javascript',
      body: `
        let user = ${signedIn ? `{ id: 'user_buyer', name: 'Buyer', email: 'buyer@example.test', image: null, plan: 'free' }` : 'null'};
        const listeners = new Set();
        window.__marketplaceSetUser = (next) => { user = next; for (const listener of listeners) listener(); };
        export async function initClerk() {}
        export function getCurrentClerkUser() { return user; }
        export async function getClerkToken() { return user ? 'test-clerk-token' : null; }
        export function openSignIn() { window.__signInOpened = true; }
        export function subscribeClerk(callback) { listeners.add(callback); return () => listeners.delete(callback); }
      `,
    });
  });
}

test('Marketplace buyer portal shows signed-out guidance on desktop and mobile', async ({ page }, testInfo) => {
  await mockClerk(page, false);
  await page.goto('/marketplace.html');
  await expect(page.getByRole('heading', { name: 'Sign in to claim your purchase' })).toBeVisible();
  await expect(page.getByText('Billing is through AWS Marketplace.')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('marketplace-signed-out-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('marketplace-signed-out-mobile.png'), fullPage: true });
});

test('Marketplace buyer can create, reveal once, rotate, and revoke a key', async ({ page }, testInfo) => {
  await mockClerk(page, true);
  const license = {
    id: 'license_12345678', productCode: 'prod-test', licenseArn: 'arn:aws:license:test',
    status: 'active', planKey: 'api_starter', quantity: 2,
    validUntil: now + 300_000, checkedAt: now,
    keys: [] as Array<{ id: string; name: string; keyPrefix: string; createdAt: number; revokedAt?: number }>,
  };
  let created = 0;
  await page.route('**/api/marketplace/account', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ licenses: [license], pendingRegistration: false }) });
  });
  await page.route('**/api/marketplace/keys', async (route) => {
    const request = route.request();
    expect(request.headers().authorization).toBe('Bearer test-clerk-token');
    if (request.method() === 'POST') {
      created += 1;
      const body = request.postDataJSON();
      expect(body.licenseId).toBe(license.id);
      license.keys.push({ id: `key_${created}`, name: body.name, keyPrefix: key.slice(0, 8), createdAt: Date.now() });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ keyId: `key_${created}`, key }) });
    } else {
      const body = request.postDataJSON();
      const entry = license.keys.find((item) => item.id === body.keyId);
      if (entry) entry.revokedAt = Date.now();
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
  });
  await page.goto('/marketplace.html');
  await expect(page.getByRole('heading', { name: 'Your Marketplace licenses' })).toBeVisible();
  await expect(page.getByText('2,000 API units/day')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('marketplace-active-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('marketplace-active-mobile.png'), fullPage: true });

  await page.getByRole('textbox', { name: 'New key name' }).fill('production-agent');
  await page.getByRole('button', { name: 'Create key' }).click();
  await expect(page.getByText(key)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('marketplace-key-reveal-mobile.png'), fullPage: true });
  await page.reload();
  await expect(page.getByText(key)).toHaveCount(0);
  await page.getByRole('textbox', { name: 'New key name' }).fill('replacement-agent');
  await page.getByRole('button', { name: 'Create key' }).click();
  await expect.poll(() => created).toBe(2);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: /Revoke production-agent key/ }).click();
  await expect(page.locator('.key-list strong').filter({ hasText: 'production-agent' })).toHaveCount(0);
  await expect(page.locator('.key-list strong').filter({ hasText: 'replacement-agent' })).toHaveCount(1);
  await page.evaluate(() => (window as Window & { __marketplaceSetUser: (user: null) => void }).__marketplaceSetUser(null));
  await expect(page.getByRole('heading', { name: 'Sign in to claim your purchase' })).toBeVisible();
  await expect(page.locator('#licenses')).toBeEmpty();
  await expect(page.locator('.secret')).toHaveCount(0);
});

test('claiming a license enables key creation without a page reload', async ({ page }) => {
  await mockClerk(page, true);
  let claimed = false;
  let keyRequests = 0;
  await page.route('**/api/marketplace/account', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      pendingRegistration: !claimed,
      licenses: claimed ? [{
        id: 'license_claimed', productCode: 'prod-test', licenseArn: 'arn:test',
        status: 'active', planKey: 'api_starter', quantity: 1,
        validUntil: Date.now() + 300_000, checkedAt: Date.now(), keys: [],
      }] : [],
    }) });
  });
  await page.route('**/api/marketplace/claim', async (route) => {
    claimed = true;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"licenseId":"license_claimed","principalId":"aws-marketplace:license_claimed"}' });
  });
  await page.route('**/api/marketplace/keys', async (route) => {
    keyRequests++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ keyId: 'key_claimed', key }) });
  });

  await page.goto('/marketplace.html?setup=1');
  await page.getByRole('button', { name: 'Claim license' }).click();
  await expect(page.getByRole('heading', { name: 'Your Marketplace licenses' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create key' })).toBeEnabled({ timeout: 2000 });
  await page.getByRole('textbox', { name: 'New key name' }).fill('claimed-agent');
  await page.getByRole('button', { name: 'Create key' }).click();
  await expect(page.getByText(key)).toBeVisible();
  expect(keyRequests).toBe(1);
});

test('same-account Clerk updates preserve a pending one-time key', async ({ page }, testInfo) => {
  await mockClerk(page, true);
  await page.route('**/api/marketplace/account', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      licenses: [{ id: 'license_1', productCode: 'prod-test', licenseArn: 'arn:test', status: 'active', planKey: 'api_starter', quantity: 1,
        validUntil: Date.now() + 300_000, checkedAt: Date.now(), keys: [] }], pendingRegistration: false,
    }) });
  });
  let release: (() => void) | undefined;
  await page.route('**/api/marketplace/keys', async (route) => {
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ keyId: 'key_refresh', key }) });
  });
  await page.goto('/marketplace.html');
  await page.getByRole('textbox', { name: 'New key name' }).fill('refresh-safe-agent');
  await page.getByRole('button', { name: 'Create key' }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('marketplace-key-pending-desktop.png'), fullPage: true });
  const notifySameUser = () => page.evaluate(() => (window as Window & {
    __marketplaceSetUser: (user: { id: string }) => void;
  }).__marketplaceSetUser({ id: 'user_buyer' }));
  await notifySameUser();
  const response = page.waitForResponse((result) => result.url().endsWith('/api/marketplace/keys'));
  release?.();
  await (await response).finished();
  await expect(page.getByRole('button', { name: 'Create key' })).toBeEnabled();
  await expect(page.getByText(key)).toBeVisible({ timeout: 2000 });
  await expect(page.locator('.key-list strong')).toHaveText('refresh-safe-agent');
  await notifySameUser();
  await expect(page.getByText(key)).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Key created. Copy it now');
  await page.screenshot({ path: testInfo.outputPath('marketplace-key-refresh-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('marketplace-key-refresh-mobile.png'), fullPage: true });
});

test('late key creation after sign-out does not reveal a secret or restore the old account', async ({ page }) => {
  await mockClerk(page, true);
  await page.route('**/api/marketplace/account', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      licenses: [{ id: 'license_1', productCode: 'prod-test', licenseArn: 'arn:test', status: 'active', planKey: 'api_starter', quantity: 1,
        validUntil: Date.now() + 300_000, checkedAt: Date.now(), keys: [] }], pendingRegistration: false,
    }) });
  });
  let release: (() => void) | undefined;
  await page.route('**/api/marketplace/keys', async (route) => {
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ keyId: 'key_late', key }) });
  });
  await page.goto('/marketplace.html');
  await page.getByRole('textbox', { name: 'New key name' }).fill('late-key');
  await page.getByRole('button', { name: 'Create key' }).click();
  await expect(page.getByRole('status')).toContainText('Creating your key');
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.evaluate(() => (window as Window & { __marketplaceSetUser: (user: null) => void }).__marketplaceSetUser(null));
  await expect(page.locator('#licenses')).toBeEmpty();
  const response = page.waitForResponse((result) => result.url().endsWith('/api/marketplace/keys'));
  release?.();
  await (await response).finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.getByRole('heading', { name: 'Sign in to claim your purchase' })).toBeVisible();
  await expect(page.locator('.secret')).toHaveCount(0);
  await expect(page.locator('#licenses')).toBeEmpty();
});

test('late key revocation after sign-out does not restore account content', async ({ page }) => {
  await mockClerk(page, true);
  await page.route('**/api/marketplace/account', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      licenses: [{ id: 'license_1', productCode: 'prod-test', licenseArn: 'arn:test', status: 'active', planKey: 'api_starter', quantity: 1,
        validUntil: Date.now() + 300_000, checkedAt: Date.now(), keys: [{ id: 'key_1', name: 'existing', keyPrefix: 'wm_12345', createdAt: Date.now() }] }], pendingRegistration: false,
    }) });
  });
  let release: (() => void) | undefined;
  await page.route('**/api/marketplace/keys', async (route) => {
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.goto('/marketplace.html');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: /Revoke existing key/ }).click();
  await expect(page.getByRole('button', { name: /Revoke existing key/ })).toBeDisabled();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.evaluate(() => (window as Window & { __marketplaceSetUser: (user: null) => void }).__marketplaceSetUser(null));
  const response = page.waitForResponse((result) => result.url().endsWith('/api/marketplace/keys'));
  release?.();
  await (await response).finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.getByRole('heading', { name: 'Sign in to claim your purchase' })).toBeVisible();
  await expect(page.locator('#licenses')).toBeEmpty();
});

test('expired AWS setup shows recovery through Marketplace', async ({ page }, testInfo) => {
  await mockClerk(page, true);
  let claimError = 'REGISTRATION_EXPIRED';
  await page.route('**/api/marketplace/account', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"licenses":[],"pendingRegistration":true}' });
  });
  await page.route('**/api/marketplace/claim', async (route) => {
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: claimError }) });
  });
  await page.goto('/marketplace.html?setup=1');
  await page.getByRole('button', { name: 'Claim license' }).click();
  await expect(page.getByRole('status')).toContainText('Return to AWS Marketplace');
  await expect(page.getByRole('link', { name: 'Manage subscription in AWS' })).toHaveAttribute('href', /console\.aws\.amazon\.com/);
  await page.screenshot({ path: testInfo.outputPath('marketplace-expired-recovery.png'), fullPage: true });
  claimError = 'REGISTRATION_REQUIRED';
  await page.getByRole('button', { name: 'Claim license' }).click();
  await expect(page.getByRole('status')).toContainText('Return to AWS Marketplace');
});
