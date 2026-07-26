import { expect, test } from '@playwright/test';

/**
 * MCP Grant Consent Page — DOM-behavioural coverage (#5654).
 *
 * Drives the /mcp-grant consent page with stubbed Clerk auth and stubbed
 * /api/internal/mcp-grant-{context,mint} endpoints. Asserts the four
 * error shapes produce the correct DOM state and that the happy-path
 * renders the consent card then navigates on authorize.
 *
 * Stubbing strategy:
 *   - The Clerk service module is intercepted to provide a minimal stub
 *     (signed-in user, no-op sign-in, stable token).
 *   - /api/internal/mcp-grant-context is route-intercepted per test.
 *   - /api/internal/mcp-grant-mint is route-intercepted per test.
 */

const GRANT_PAGE = '/mcp-grant?nonce=test-nonce-e2e';

/**
 * Intercept the Clerk service module to provide a stub that looks like a
 * signed-in Pro user. This avoids needing real Clerk credentials.
 */
async function stubClerkModule(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/services/clerk*', async (route) => {
    const response = `
      export async function initClerk() {}
      export function getClerkToken() { return Promise.resolve('stub-jwt-token'); }
      export function getCurrentClerkUser() { return { email: 'e2e@worldmonitor.app' }; }
      export function openSignIn() {}
      export function subscribeClerk(cb) { cb(); }
    `;
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: response,
    });
  });
}

function stubContextSuccess(page: import('@playwright/test').Page): Promise<void> {
  return page.route('**/api/internal/mcp-grant-context*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ client_name: 'Claude Desktop', redirect_host: 'api.worldmonitor.app' }),
    });
  });
}

function stubContextError(
  page: import('@playwright/test').Page,
  error: string,
  status: number,
): Promise<void> {
  return page.route('**/api/internal/mcp-grant-context*', async (route) => {
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify({ error, error_description: `Test: ${error}` }),
    });
  });
}

function stubMintSuccess(page: import('@playwright/test').Page): Promise<void> {
  return page.route('**/api/internal/mcp-grant-mint', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ redirect: 'https://api.worldmonitor.app/oauth/authorize-pro?nonce=test-nonce-e2e&grant=signed-token' }),
    });
  });
}

function stubMintError(
  page: import('@playwright/test').Page,
  error: string,
  status: number,
): Promise<void> {
  return page.route('**/api/internal/mcp-grant-mint', async (route) => {
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify({ error, error_description: `Test: ${error}` }),
    });
  });
}

function stubMintNetworkError(page: import('@playwright/test').Page): Promise<void> {
  return page.route('**/api/internal/mcp-grant-mint', async (route) => {
    await route.abort('connectionrefused');
  });
}

test.describe('MCP grant consent page (#5654)', () => {
  test('missing nonce shows terminal error view', async ({ page }) => {
    await stubClerkModule(page);
    await page.goto('/mcp-grant');

    await expect(page.locator('#errorView')).toBeVisible();
    await expect(page.locator('#errorBody')).toContainText('Missing authorization parameter');
    await expect(page.locator('#consent')).toBeHidden();
    await expect(page.locator('#loading')).toBeHidden();
  });

  test('successful context load shows consent card with client metadata', async ({ page }) => {
    await stubClerkModule(page);
    await stubContextSuccess(page);

    await page.goto(GRANT_PAGE);

    await expect(page.locator('#consent')).toBeVisible();
    await expect(page.locator('#clientName')).toHaveText('Claude Desktop');
    await expect(page.locator('#clientHost')).toHaveText('api.worldmonitor.app');
    await expect(page.locator('#userEmail')).toHaveText('e2e@worldmonitor.app');
    await expect(page.locator('#loading')).toBeHidden();
    await expect(page.locator('#errorView')).toBeHidden();
    await expect(page.locator('#authorizeBtn')).toBeEnabled();
  });

  test('INVALID_NONCE from context shows terminal error view', async ({ page }) => {
    await stubClerkModule(page);
    await stubContextError(page, 'INVALID_NONCE', 400);

    await page.goto(GRANT_PAGE);

    await expect(page.locator('#errorView')).toBeVisible();
    await expect(page.locator('#errorBody')).toContainText('expired or is invalid');
    await expect(page.locator('#consent')).toBeHidden();
  });

  test('UNKNOWN_CLIENT from context shows terminal error view', async ({ page }) => {
    await stubClerkModule(page);
    await stubContextError(page, 'UNKNOWN_CLIENT', 400);

    await page.goto(GRANT_PAGE);

    await expect(page.locator('#errorView')).toBeVisible();
    await expect(page.locator('#errorBody')).toContainText('no longer registered');
    await expect(page.locator('#consent')).toBeHidden();
  });

  test('INSUFFICIENT_TIER from context shows Pro subscription required error', async ({ page }) => {
    await stubClerkModule(page);
    await stubContextError(page, 'INSUFFICIENT_TIER', 403);

    await page.goto(GRANT_PAGE);

    await expect(page.locator('#errorView')).toBeVisible();
    await expect(page.locator('#errorBody')).toContainText('Pro subscription is required');
    await expect(page.locator('#consent')).toBeHidden();
  });

  test('SERVICE_UNAVAILABLE from context shows temporary error', async ({ page }) => {
    await stubClerkModule(page);
    await stubContextError(page, 'SERVICE_UNAVAILABLE', 503);

    await page.goto(GRANT_PAGE);

    await expect(page.locator('#errorView')).toBeVisible();
    await expect(page.locator('#errorBody')).toContainText('temporarily unavailable');
    await expect(page.locator('#consent')).toBeHidden();
  });

  test('CONFIGURATION_ERROR from context shows temporarily unavailable message', async ({ page }) => {
    await stubClerkModule(page);
    await stubContextError(page, 'CONFIGURATION_ERROR', 500);

    await page.goto(GRANT_PAGE);

    await expect(page.locator('#errorView')).toBeVisible();
    await expect(page.locator('#errorBody')).toContainText('temporarily unavailable');
    await expect(page.locator('#consent')).toBeHidden();
  });

  test('network failure on context shows connection error', async ({ page }) => {
    await stubClerkModule(page);
    await page.route('**/api/internal/mcp-grant-context*', async (route) => {
      await route.abort('connectionrefused');
    });

    await page.goto(GRANT_PAGE);

    await expect(page.locator('#errorView')).toBeVisible();
    await expect(page.locator('#errorBody')).toContainText('Check your connection');
    await expect(page.locator('#consent')).toBeHidden();
  });

  test('authorize click disables button and shows authorizing state', async ({ page }) => {
    await stubClerkModule(page);
    await stubContextSuccess(page);

    // Delay mint response to observe intermediate state
    let resolveMint!: () => void;
    const mintDelay = new Promise<void>((resolve) => { resolveMint = resolve; });
    await page.route('**/api/internal/mcp-grant-mint', async (route) => {
      await mintDelay;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ redirect: 'https://api.worldmonitor.app/oauth/authorize-pro?nonce=test&grant=tok' }),
      });
    });

    await page.goto(GRANT_PAGE);
    await expect(page.locator('#consent')).toBeVisible();

    await page.locator('#authorizeBtn').click();
    await expect(page.locator('#authorizeBtn')).toBeDisabled();
    await expect(page.locator('#authorizeBtn')).toHaveText('Authorizing…');

    resolveMint();
  });

  test('successful mint navigates to api.worldmonitor.app redirect', async ({ page }) => {
    await stubClerkModule(page);
    await stubContextSuccess(page);
    await stubMintSuccess(page);

    await page.goto(GRANT_PAGE);
    await expect(page.locator('#consent')).toBeVisible();

    // Intercept window.location.assign to capture the redirect URL without navigating
    const navigationTarget = page.evaluate(() => {
      return new Promise<string>((resolve) => {
        window.location.assign = ((url: string) => { resolve(url); }) as typeof window.location.assign;
      });
    });

    await page.locator('#authorizeBtn').click();
    const targetUrl = await navigationTarget;

    expect(targetUrl).toContain('https://api.worldmonitor.app/oauth/authorize-pro');
  });

  test('INVALID_NONCE from mint shows terminal error (consent card removed)', async ({ page }) => {
    await stubClerkModule(page);
    await stubContextSuccess(page);
    await stubMintError(page, 'INVALID_NONCE', 400);

    await page.goto(GRANT_PAGE);
    await expect(page.locator('#consent')).toBeVisible();

    await page.locator('#authorizeBtn').click();

    // Terminal error: consent card replaced with errorView
    await expect(page.locator('#errorView')).toBeVisible();
    await expect(page.locator('#errorBody')).toContainText('expired or is invalid');
    await expect(page.locator('#consent')).toBeHidden();
  });

  test('INSUFFICIENT_TIER from mint shows terminal error (consent card removed)', async ({ page }) => {
    await stubClerkModule(page);
    await stubContextSuccess(page);
    await stubMintError(page, 'INSUFFICIENT_TIER', 403);

    await page.goto(GRANT_PAGE);
    await expect(page.locator('#consent')).toBeVisible();

    await page.locator('#authorizeBtn').click();

    await expect(page.locator('#errorView')).toBeVisible();
    await expect(page.locator('#errorBody')).toContainText('Pro subscription is required');
    await expect(page.locator('#consent')).toBeHidden();
  });

  test('SERVICE_UNAVAILABLE from mint shows terminal error view', async ({ page }) => {
    await stubClerkModule(page);
    await stubContextSuccess(page);
    await stubMintError(page, 'SERVICE_UNAVAILABLE', 503);

    await page.goto(GRANT_PAGE);
    await expect(page.locator('#consent')).toBeVisible();

    await page.locator('#authorizeBtn').click();

    await expect(page.locator('#errorView')).toBeVisible();
    await expect(page.locator('#errorBody')).toContainText('temporarily unavailable');
    await expect(page.locator('#consent')).toBeHidden();
  });

  test('network failure on mint shows inline retry error (consent card stays)', async ({ page }) => {
    await stubClerkModule(page);
    await stubContextSuccess(page);
    await stubMintNetworkError(page);

    await page.goto(GRANT_PAGE);
    await expect(page.locator('#consent')).toBeVisible();

    await page.locator('#authorizeBtn').click();

    // Transient error: consent card stays, inline error shown, button re-enabled
    await expect(page.locator('#mintError')).toBeVisible();
    await expect(page.locator('#mintError')).toContainText('Network error');
    await expect(page.locator('#consent')).toBeVisible();
    await expect(page.locator('#errorView')).toBeHidden();
    await expect(page.locator('#authorizeBtn')).toBeEnabled();
    await expect(page.locator('#authorizeBtn')).toHaveText('Authorize');
  });

  test('mint returning invalid redirect host shows terminal error', async ({ page }) => {
    await stubClerkModule(page);
    await stubContextSuccess(page);
    await page.route('**/api/internal/mcp-grant-mint', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ redirect: 'https://evil.example.com/steal?code=abc' }),
      });
    });

    await page.goto(GRANT_PAGE);
    await expect(page.locator('#consent')).toBeVisible();

    await page.locator('#authorizeBtn').click();

    await expect(page.locator('#errorView')).toBeVisible();
    await expect(page.locator('#errorBody')).toContainText('unexpected redirect host');
    await expect(page.locator('#consent')).toBeHidden();
  });

  test('mint returning malformed redirect URL shows terminal error', async ({ page }) => {
    await stubClerkModule(page);
    await stubContextSuccess(page);
    await page.route('**/api/internal/mcp-grant-mint', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ redirect: 'not-a-url' }),
      });
    });

    await page.goto(GRANT_PAGE);
    await expect(page.locator('#consent')).toBeVisible();

    await page.locator('#authorizeBtn').click();

    await expect(page.locator('#errorView')).toBeVisible();
    await expect(page.locator('#errorBody')).toContainText('invalid redirect');
    await expect(page.locator('#consent')).toBeHidden();
  });

  test('mint returning unparseable JSON shows inline retry error', async ({ page }) => {
    await stubClerkModule(page);
    await stubContextSuccess(page);
    await page.route('**/api/internal/mcp-grant-mint', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: 'not json at all',
      });
    });

    await page.goto(GRANT_PAGE);
    await expect(page.locator('#consent')).toBeVisible();

    await page.locator('#authorizeBtn').click();

    // JSON parse failure is transient — consent card stays, inline error shown
    await expect(page.locator('#mintError')).toBeVisible();
    await expect(page.locator('#mintError')).toContainText('Unexpected response');
    await expect(page.locator('#consent')).toBeVisible();
    await expect(page.locator('#authorizeBtn')).toBeEnabled();
  });

  test('401 from context triggers sign-in (consent never renders)', async ({ page }) => {
    // For 401, the page calls openSignIn() — which is stubbed as a no-op.
    // Neither consent nor errorView should be visible; loading stays.
    await stubClerkModule(page);

    // Track whether openSignIn was called
    await page.addInitScript(() => {
      (window as unknown as { __openSignInCalled: boolean }).__openSignInCalled = false;
    });

    // Stub Clerk with an openSignIn that records the call
    await page.route('**/services/clerk*', async (route) => {
      const response = `
        export async function initClerk() {}
        export function getClerkToken() { return Promise.resolve('stub-jwt-token'); }
        export function getCurrentClerkUser() { return { email: 'e2e@worldmonitor.app' }; }
        export function openSignIn() { window.__openSignInCalled = true; }
        export function subscribeClerk(cb) { cb(); }
      `;
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: response,
      });
    });

    // Wait for the context request to complete before asserting
    const contextRequestDone = page.waitForResponse('**/api/internal/mcp-grant-context*');
    await page.route('**/api/internal/mcp-grant-context*', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'UNAUTHENTICATED' }),
      });
    });

    await page.goto(GRANT_PAGE);
    await contextRequestDone;

    // openSignIn was called, neither error view nor consent should appear
    const signInCalled = await page.evaluate(() => (window as unknown as { __openSignInCalled: boolean }).__openSignInCalled);
    expect(signInCalled).toBe(true);
    await expect(page.locator('#consent')).toBeHidden();
    await expect(page.locator('#errorView')).toBeHidden();
  });
});
