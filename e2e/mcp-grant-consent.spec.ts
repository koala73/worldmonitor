import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * MCP Grant Consent Page — DOM-behavioural coverage (#5654).
 *
 * Drives the /mcp-grant consent page with stubbed Clerk auth and stubbed
 * /api/internal/mcp-grant-{context,mint} endpoints, asserting which DOM state
 * each denial shape produces.
 *
 * The assertions that carry this suite are `#retryContextBtn` and `#errorTitle`.
 * `showErrorView` and `showRetryableContextView` both hide `#consent`, both show
 * `#errorView`, and both write the same `verdict.message` into `#errorBody` — so
 * without those two locators a terminal/retryable swap in `routeGrantContextDenial`
 * passes every assertion in this file, which is exactly the false-passing wiring
 * guard #5654 asks to close.
 *
 * Stubbing strategy:
 *   - The Clerk service module is intercepted to provide a minimal stub
 *     (signed-in user, no-op sign-in, stable token).
 *   - /api/internal/mcp-grant-{context,mint} are route-intercepted per test.
 *   - The api.worldmonitor.app redirect target is route-intercepted so the
 *     success path never performs a live cross-origin navigation out of CI.
 *     `window.location.assign` CANNOT be patched from page script — Location's
 *     members are [LegacyUnforgeable], so the assignment silently no-ops and the
 *     real navigation happens anyway. Intercept the request, not the method.
 */

const GRANT_PAGE = '/mcp-grant?nonce=test-nonce-e2e';
const GRANT_REDIRECT =
  'https://api.worldmonitor.app/oauth/authorize-pro?nonce=test-nonce-e2e&grant=signed-token';

/** Redirects the apex page must refuse. Each one defeats a different weakening
 *  of the `target.origin !== 'https://api.worldmonitor.app'` guard: a bare
 *  hostname compare, an `endsWith` suffix match, an `includes`/`startsWith`
 *  substring match, and a missing scheme check. A single evil.example.com case
 *  is rejected by every one of those weakenings, so it cannot tell a correct
 *  guard from a broken one. */
const HOSTILE_REDIRECTS: ReadonlyArray<[label: string, redirect: string]> = [
  ['unrelated host', 'https://evil.example.com/steal?grant=stolen'],
  ['prefix lookalike', 'https://api.worldmonitor.app.evil.example/oauth/authorize-pro?grant=stolen'],
  ['userinfo spoof', 'https://api.worldmonitor.app@evil.example/oauth/authorize-pro?grant=stolen'],
  ['suffix lookalike', 'https://evilworldmonitor.app/oauth/authorize-pro?grant=stolen'],
  ['scheme downgrade', 'http://api.worldmonitor.app/oauth/authorize-pro?grant=stolen'],
  ['non-http scheme', 'javascript:alert(document.domain)'],
];

/**
 * Intercept the Clerk service module to provide a stub that looks like a
 * signed-in Pro user. This avoids needing real Clerk credentials.
 *
 * `subscribeClerk` invokes its callback synchronously, matching Clerk's own
 * addListener, which fires immediately with current state. That makes
 * `bootstrap()` issue two overlapping context loads and so exercises the
 * `contextLoadGeneration` staleness guard rather than papering over it — which
 * is why assertions here must never assume a single request.
 */
async function stubClerkModule(
  page: Page,
  opts: { trackSignIn?: boolean } = {},
): Promise<void> {
  const openSignInBody = opts.trackSignIn ? 'window.__openSignInCalled = true;' : '';
  await page.route('**/services/clerk*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `
        export async function initClerk() {}
        export function getClerkToken() { return Promise.resolve('stub-jwt-token'); }
        export function getCurrentClerkUser() { return { email: 'e2e@worldmonitor.app' }; }
        export function openSignIn() { ${openSignInBody} }
        export function subscribeClerk(cb) {
          window.__emitClerkSubscription = cb;
          cb();
          return () => {
            if (window.__emitClerkSubscription === cb) delete window.__emitClerkSubscription;
          };
        }
      `,
    });
  });
}

async function emitClerkSubscription(page: Page): Promise<void> {
  await page.evaluate(() => {
    const emit = (window as unknown as { __emitClerkSubscription?: () => void })
      .__emitClerkSubscription;
    if (!emit) throw new Error('Clerk subscription callback was not registered');
    emit();
  });
}

/**
 * Observe the consent/error visibility invariant across an asynchronous Clerk
 * reentry. Waiting for the mocked response alone is insufficient: the response
 * event fires before the page has parsed the body and routed the denial.
 */
async function expectConsentPreservedAcrossClerkRefresh(page: Page): Promise<void> {
  await page.evaluate(() => {
    const consent = document.getElementById('consent');
    const errorView = document.getElementById('errorView');
    if (!consent || !errorView) throw new Error('Grant views were not rendered');

    const wasDestroyed = (): boolean => consent.hidden || !errorView.hidden;
    let destroyed = wasDestroyed();
    const observer = new MutationObserver(() => {
      destroyed ||= wasDestroyed();
    });
    observer.observe(consent, { attributes: true, attributeFilter: ['hidden'] });
    observer.observe(errorView, { attributes: true, attributeFilter: ['hidden'] });

    (
      window as unknown as {
        __finishConsentPreservationWatch?: () => boolean;
      }
    ).__finishConsentPreservationWatch = () => {
      observer.takeRecords();
      observer.disconnect();
      return destroyed || wasDestroyed();
    };
  });

  const deniedRefresh = page.waitForResponse(
    (response) =>
      response.url().includes('/api/internal/mcp-grant-context') && response.status() === 503,
  );
  await emitClerkSubscription(page);
  await deniedRefresh;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );

  const consentWasDestroyed = await page.evaluate(() => {
    const finish = (
      window as unknown as {
        __finishConsentPreservationWatch?: () => boolean;
      }
    ).__finishConsentPreservationWatch;
    if (!finish) throw new Error('Consent preservation observer was not registered');
    delete (
      window as unknown as {
        __finishConsentPreservationWatch?: () => boolean;
      }
    ).__finishConsentPreservationWatch;
    return finish();
  });

  expect(consentWasDestroyed).toBe(false);
  await expect(page.locator('#consent')).toBeVisible();
  await expect(page.locator('#errorView')).toBeHidden();
}

/**
 * Intercept the api.worldmonitor.app redirect target. Returns a getter for the
 * URLs the page actually tried to navigate to, so a test can assert both that
 * the success path navigates and that a refused redirect navigates nowhere.
 */
async function interceptGrantRedirect(
  page: Page,
): Promise<() => string[]> {
  const requested: string[] = [];
  await page.route('https://api.worldmonitor.app/**', async (route) => {
    requested.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html><body>stub redirect target</body></html>',
    });
  });
  return () => requested;
}

function stubContextSuccess(page: Page): Promise<void> {
  return page.route('**/api/internal/mcp-grant-context*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ client_name: 'Claude Desktop', redirect_host: 'api.worldmonitor.app' }),
    });
  });
}

function stubContextError(
  page: Page,
  error: string,
  status: number,
  headers?: Record<string, string>,
): Promise<void> {
  return page.route('**/api/internal/mcp-grant-context*', async (route) => {
    await route.fulfill({
      status,
      contentType: 'application/json',
      headers,
      body: JSON.stringify({ error, error_description: `Test: ${error}` }),
    });
  });
}

async function stubContextSuccessThenRetryable(
  page: Page,
): Promise<{ useRetryableDenial: () => void }> {
  let retryable = false;
  await page.route('**/api/internal/mcp-grant-context*', async (route) => {
    if (retryable) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        headers: { 'Retry-After': '60' },
        body: JSON.stringify({ error: 'SERVICE_UNAVAILABLE' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ client_name: 'Claude Desktop', redirect_host: 'api.worldmonitor.app' }),
    });
  });
  return { useRetryableDenial: () => { retryable = true; } };
}

function expectMintRequestContract(route: Route): void {
  const request = route.request();
  expect(request.method()).toBe('POST');
  expect(request.headers().authorization).toBe('Bearer stub-jwt-token');
  expect(request.headers()['content-type']).toContain('application/json');
  expect(request.postDataJSON()).toEqual({ nonce: 'test-nonce-e2e' });
}

function stubMintSuccess(page: Page): Promise<void> {
  return page.route('**/api/internal/mcp-grant-mint', async (route) => {
    expectMintRequestContract(route);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ redirect: GRANT_REDIRECT }),
    });
  });
}

function stubMintError(
  page: Page,
  error: string | undefined,
  status: number,
  headers?: Record<string, string>,
): Promise<void> {
  return page.route('**/api/internal/mcp-grant-mint', async (route) => {
    expectMintRequestContract(route);
    await route.fulfill({
      status,
      contentType: 'application/json',
      headers,
      body: JSON.stringify(error ? { error, error_description: `Test: ${error}` } : {}),
    });
  });
}

function stubMintNetworkError(page: Page): Promise<void> {
  return page.route('**/api/internal/mcp-grant-mint', async (route) => {
    expectMintRequestContract(route);
    await route.abort('connectionrefused');
  });
}

function stubMintRedirect(
  page: Page,
  redirect: string,
): Promise<void> {
  return page.route('**/api/internal/mcp-grant-mint', async (route) => {
    expectMintRequestContract(route);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ redirect }),
    });
  });
}

test.describe('MCP grant consent page (#5654)', () => {
  test('missing nonce shows terminal error view', async ({ page }) => {
    await stubClerkModule(page);
    await page.goto('/mcp-grant');

    await expect(page.locator('#errorView')).toBeVisible();
    await expect(page.locator('#errorTitle')).toHaveText('Missing authorization parameter');
    await expect(page.locator('#errorBody')).toContainText('Missing authorization parameter');
    await expect(page.locator('#retryContextBtn')).toBeHidden();
    await expect(page.locator('#consent')).toBeHidden();
    await expect(page.locator('#loading')).toBeHidden();
  });

  test('successful context load shows consent card with client metadata', async ({ page }) => {
    await stubClerkModule(page);
    const contextAuth: (string | undefined)[] = [];
    await page.route('**/api/internal/mcp-grant-context*', async (route) => {
      contextAuth.push(route.request().headers().authorization);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          client_name: 'Claude Desktop',
          redirect_host: 'api.worldmonitor.app',
        }),
      });
    });

    await page.goto(GRANT_PAGE);

    await expect(page.locator('#consent')).toBeVisible();
    await expect(page.locator('#clientName')).toHaveText('Claude Desktop');
    await expect(page.locator('#clientHost')).toHaveText('api.worldmonitor.app');
    await expect(page.locator('#userEmail')).toHaveText('e2e@worldmonitor.app');
    await expect(page.locator('#loading')).toBeHidden();
    await expect(page.locator('#errorView')).toBeHidden();
    await expect(page.locator('#authorizeBtn')).toBeEnabled();

    // authedFetch must attach the Clerk JWT; a regression to a bare fetch()
    // would fail closed in production but is invisible to a stub that ignores
    // headers.
    expect(contextAuth.length).toBeGreaterThan(0);
    for (const header of contextAuth) expect(header).toBe('Bearer stub-jwt-token');
  });

  // Terminal context denials: consent is replaced, the heading names the actual
  // failure, and NO manual retry is offered. The `#retryContextBtn` hidden
  // assertion is what distinguishes these from the retryable case below.
  const TERMINAL_CONTEXT_CASES: ReadonlyArray<
    [code: string, status: number, title: string, body: string]
  > = [
    ['INVALID_NONCE', 400, 'Authorization request expired', 'expired or is invalid'],
    ['UNKNOWN_CLIENT', 400, 'Unknown OAuth client', 'no longer registered'],
    ['INSUFFICIENT_TIER', 403, 'Pro subscription required', 'Pro subscription is required'],
    [
      'CONFIGURATION_ERROR',
      500,
      'Authorization temporarily unavailable',
      'MCP authorization is temporarily unavailable',
    ],
  ];

  for (const [code, status, title, body] of TERMINAL_CONTEXT_CASES) {
    test(`${code} from context shows terminal error view without a retry action`, async ({
      page,
    }) => {
      await stubClerkModule(page);
      await stubContextError(page, code, status);

      await page.goto(GRANT_PAGE);

      await expect(page.locator('#errorView')).toBeVisible();
      await expect(page.locator('#errorTitle')).toHaveText(title);
      await expect(page.locator('#errorBody')).toContainText(body);
      await expect(page.locator('#retryContextBtn')).toBeHidden();
      await expect(page.locator('#consent')).toBeHidden();
    });
  }

  test('SERVICE_UNAVAILABLE from context exhausts its retry then offers a manual retry', async ({
    page,
  }) => {
    await stubClerkModule(page);
    // Retry-After: 1 keeps the in-page auto-retry wait to ~1s. Omitting the
    // header would fall back to DEFAULT_GRANT_RETRY_SECONDS (5s) of real,
    // unmocked wall clock. Note Retry-After: 0 does NOT work — it fails
    // retryableGrantDelayMs's `parsed > 0` guard and falls back to the same 5s.
    await stubContextError(page, 'SERVICE_UNAVAILABLE', 503, { 'Retry-After': '1' });

    await page.goto(GRANT_PAGE);

    await expect(page.locator('#errorView')).toBeVisible();
    await expect(page.locator('#errorTitle')).toHaveText('Authorization temporarily unavailable');
    await expect(page.locator('#errorBody')).toContainText('temporarily unavailable');
    await expect(page.locator('#consent')).toBeHidden();
    // The whole point of the retryable branch: the user gets a way out. This is
    // the ONLY DOM difference from the terminal CONFIGURATION_ERROR case above,
    // which renders an identical heading.
    await expect(page.locator('#retryContextBtn')).toBeVisible();
  });

  test('a long Retry-After surfaces the wait instead of blocking on it', async ({ page }) => {
    await stubClerkModule(page);
    // Above MAX_INLINE_GRANT_WAIT_MS (10s) the page must NOT hold a spinner; it
    // names the delay and hands the decision back.
    await stubContextError(page, 'SERVICE_UNAVAILABLE', 503, { 'Retry-After': '60' });

    await page.goto(GRANT_PAGE);

    await expect(page.locator('#errorView')).toBeVisible();
    await expect(page.locator('#errorBody')).toContainText('Try again in about 60 seconds');
    await expect(page.locator('#retryContextBtn')).toBeVisible();
    await expect(page.locator('#consent')).toBeHidden();
  });

  test('the manual retry button reloads the context and renders consent', async ({ page }) => {
    await stubClerkModule(page);
    let failContext = true;
    await page.route('**/api/internal/mcp-grant-context*', async (route) => {
      if (failContext) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          headers: { 'Retry-After': '1' },
          body: JSON.stringify({ error: 'SERVICE_UNAVAILABLE' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          client_name: 'Claude Desktop',
          redirect_host: 'api.worldmonitor.app',
        }),
      });
    });

    await page.goto(GRANT_PAGE);
    await expect(page.locator('#retryContextBtn')).toBeVisible();

    failContext = false;
    await page.locator('#retryContextBtn').click();

    await expect(page.locator('#consent')).toBeVisible();
    await expect(page.locator('#errorView')).toBeHidden();
  });

  test('network failure on context shows connection error with a retry action', async ({
    page,
  }) => {
    await stubClerkModule(page);
    await page.route('**/api/internal/mcp-grant-context*', async (route) => {
      await route.abort('connectionrefused');
    });

    await page.goto(GRANT_PAGE);

    await expect(page.locator('#errorView')).toBeVisible();
    await expect(page.locator('#errorBody')).toContainText('Check your connection');
    await expect(page.locator('#retryContextBtn')).toBeVisible();
    await expect(page.locator('#consent')).toBeHidden();
  });

  test('authorize click disables button and shows authorizing state', async ({ page }) => {
    await stubClerkModule(page);
    await stubContextSuccess(page);
    const requestedRedirects = await interceptGrantRedirect(page);

    // Delay mint response to observe intermediate state
    let resolveMint!: () => void;
    const mintDelay = new Promise<void>((resolve) => {
      resolveMint = resolve;
    });
    await page.route('**/api/internal/mcp-grant-mint', async (route) => {
      expectMintRequestContract(route);
      await mintDelay;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ redirect: GRANT_REDIRECT }),
      });
    });

    await page.goto(GRANT_PAGE);
    await expect(page.locator('#consent')).toBeVisible();

    await page.locator('#authorizeBtn').click();
    await expect(page.locator('#authorizeBtn')).toBeDisabled();
    await expect(page.locator('#authorizeBtn')).toHaveText('Authorizing…');

    // Release the mint and let the resulting navigation settle INSIDE the test.
    // Returning here would leave a cross-origin request to the production host
    // racing page teardown.
    resolveMint();
    await page.waitForURL(/^https:\/\/api\.worldmonitor\.app\//);
    expect(requestedRedirects()).toHaveLength(1);
  });

  test('Clerk refresh preserves consent while mint is in flight', async ({ page }) => {
    await stubClerkModule(page);
    const context = await stubContextSuccessThenRetryable(page);
    const requestedRedirects = await interceptGrantRedirect(page);

    let resolveMint!: () => void;
    const mintDelay = new Promise<void>((resolve) => {
      resolveMint = resolve;
    });
    await page.route('**/api/internal/mcp-grant-mint', async (route) => {
      expectMintRequestContract(route);
      await mintDelay;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ redirect: GRANT_REDIRECT }),
      });
    });

    await page.goto(GRANT_PAGE);
    await expect(page.locator('#consent')).toBeVisible();

    await page.locator('#authorizeBtn').click();
    await expect(page.locator('#authorizeBtn')).toBeDisabled();
    await expect(page.locator('#authorizeBtn')).toHaveText('Authorizing…');

    context.useRetryableDenial();
    await expectConsentPreservedAcrossClerkRefresh(page);
    await expect(page.locator('#authorizeBtn')).toBeDisabled();
    await expect(page.locator('#authorizeBtn')).toHaveText('Authorizing…');

    resolveMint();
    await page.waitForURL(/^https:\/\/api\.worldmonitor\.app\//);
    expect(requestedRedirects()).toHaveLength(1);
  });

  test('successful mint navigates to the api.worldmonitor.app redirect', async ({ page }) => {
    await stubClerkModule(page);
    await stubContextSuccess(page);
    await stubMintSuccess(page);
    const requestedRedirects = await interceptGrantRedirect(page);

    await page.goto(GRANT_PAGE);
    await expect(page.locator('#consent')).toBeVisible();

    await page.locator('#authorizeBtn').click();
    await page.waitForURL(/^https:\/\/api\.worldmonitor\.app\//);

    // Assert the ORIGIN, not a substring: `toContain` would also be satisfied by
    // https://api.worldmonitor.app.evil.example/...
    const target = new URL(page.url());
    expect(target.origin).toBe('https://api.worldmonitor.app');
    expect(target.pathname).toBe('/oauth/authorize-pro');
    expect(target.searchParams.get('grant')).toBe('signed-token');
    expect(requestedRedirects()).toHaveLength(1);
  });

  // Terminal mint denials replace the consent card outright.
  const TERMINAL_MINT_CASES: ReadonlyArray<
    [label: string, code: string | undefined, status: number, title: string, body: string]
  > = [
    [
      'INVALID_NONCE',
      'INVALID_NONCE',
      400,
      'Authorization request expired',
      'expired or is invalid',
    ],
    [
      'INSUFFICIENT_TIER',
      'INSUFFICIENT_TIER',
      403,
      'Pro subscription required',
      'Pro subscription is required',
    ],
    // A bare 503 with no readable code is an intermediary talking, not the
    // handshake — classifyGrantDenial keeps it terminal precisely so an unknown
    // failure never becomes a retry loop.
    [
      'unrecognised failure',
      undefined,
      503,
      'Authorization failed',
      'could not be completed',
    ],
  ];

  for (const [label, code, status, title, body] of TERMINAL_MINT_CASES) {
    test(`${label} from mint replaces the consent card`, async ({ page }) => {
      await stubClerkModule(page);
      await stubContextSuccess(page);
      await stubMintError(page, code, status);

      await page.goto(GRANT_PAGE);
      await expect(page.locator('#consent')).toBeVisible();

      await page.locator('#authorizeBtn').click();

      await expect(page.locator('#errorView')).toBeVisible();
      await expect(page.locator('#errorTitle')).toHaveText(title);
      await expect(page.locator('#errorBody')).toContainText(body);
      await expect(page.locator('#consent')).toBeHidden();
    });
  }

  test('SERVICE_UNAVAILABLE from mint keeps consent and parks Authorize in cooldown', async ({
    page,
  }) => {
    await stubClerkModule(page);
    const context = await stubContextSuccessThenRetryable(page);
    // #5622: a transient entitlement failure must NOT destroy a still-valid
    // consent card. The nonce is still good and the same click would succeed a
    // moment later, so the card stays and the button comes back after the delay
    // the server asked for.
    // 3s, not 1s: the cooldown assertions below have to land inside the window,
    // and a 1s budget leaves no headroom on a loaded CI machine.
    await stubMintError(page, 'SERVICE_UNAVAILABLE', 503, { 'Retry-After': '3' });

    await page.goto(GRANT_PAGE);
    await expect(page.locator('#consent')).toBeVisible();

    await page.locator('#authorizeBtn').click();

    await expect(page.locator('#mintError')).toBeVisible();
    await expect(page.locator('#mintError')).toContainText('temporarily unavailable');
    await expect(page.locator('#consent')).toBeVisible();
    await expect(page.locator('#errorView')).toBeHidden();
    await expect(page.locator('#authorizeBtn')).toBeDisabled();
    await expect(page.locator('#authorizeBtn')).toHaveText('Retry shortly…');

    context.useRetryableDenial();
    await expectConsentPreservedAcrossClerkRefresh(page);
    await expect(page.locator('#authorizeBtn')).toBeDisabled();
    await expect(page.locator('#authorizeBtn')).toHaveText('Retry shortly…');

    // ...and the cooldown actually expires rather than stranding the button.
    await expect(page.locator('#authorizeBtn')).toBeEnabled();
    await expect(page.locator('#authorizeBtn')).toHaveText('Authorize');
  });

  test('a long Retry-After on mint names the wait and hands the button straight back', async ({
    page,
  }) => {
    await stubClerkModule(page);
    await stubContextSuccess(page);
    await stubMintError(page, 'SERVICE_UNAVAILABLE', 503, { 'Retry-After': '60' });

    await page.goto(GRANT_PAGE);
    await expect(page.locator('#consent')).toBeVisible();

    await page.locator('#authorizeBtn').click();

    await expect(page.locator('#mintError')).toContainText('Try again in about 60 seconds');
    await expect(page.locator('#consent')).toBeVisible();
    await expect(page.locator('#errorView')).toBeHidden();
    await expect(page.locator('#authorizeBtn')).toBeEnabled();
    await expect(page.locator('#authorizeBtn')).toHaveText('Authorize');
  });

  test('network failure on mint shows inline retry error (consent card stays)', async ({
    page,
  }) => {
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

  for (const [label, redirect] of HOSTILE_REDIRECTS) {
    test(`mint returning a ${label} redirect is refused and navigates nowhere`, async ({
      page,
    }) => {
      await stubClerkModule(page);
      await stubContextSuccess(page);
      await stubMintRedirect(page, redirect);
      const requestedRedirects = await interceptGrantRedirect(page);

      await page.goto(GRANT_PAGE);
      await expect(page.locator('#consent')).toBeVisible();

      await page.locator('#authorizeBtn').click();

      await expect(page.locator('#errorView')).toBeVisible();
      await expect(page.locator('#errorTitle')).toHaveText('Unexpected redirect host');
      await expect(page.locator('#errorBody')).toContainText('unexpected redirect host');
      await expect(page.locator('#consent')).toBeHidden();
      // The grant token rides in the redirect's query string, so "refused" has
      // to mean no request left the browser.
      expect(requestedRedirects()).toHaveLength(0);
      expect(page.url()).toContain('/mcp-grant');
    });
  }

  test('mint returning malformed redirect URL shows terminal error', async ({ page }) => {
    await stubClerkModule(page);
    await stubContextSuccess(page);
    await stubMintRedirect(page, 'not-a-url');

    await page.goto(GRANT_PAGE);
    await expect(page.locator('#consent')).toBeVisible();

    await page.locator('#authorizeBtn').click();

    await expect(page.locator('#errorView')).toBeVisible();
    await expect(page.locator('#errorTitle')).toHaveText('Invalid redirect');
    await expect(page.locator('#errorBody')).toContainText('invalid redirect');
    await expect(page.locator('#consent')).toBeHidden();
  });

  test('mint returning unparseable JSON shows inline retry error', async ({ page }) => {
    await stubClerkModule(page);
    await stubContextSuccess(page);
    await page.route('**/api/internal/mcp-grant-mint', async (route) => {
      expectMintRequestContract(route);
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
    await page.addInitScript(() => {
      (window as unknown as { __openSignInCalled: boolean }).__openSignInCalled = false;
    });
    await stubClerkModule(page, { trackSignIn: true });
    await stubContextError(page, 'UNAUTHENTICATED', 401);

    await page.goto(GRANT_PAGE);

    // Poll rather than read once. `waitForResponse` is NOT a usable sync point
    // here: bootstrap issues two overlapping context loads, the first of which
    // is discarded by the generation guard without ever calling openSignIn, and
    // the surviving one only reaches it after a further body parse.
    await page.waitForFunction(
      () => (window as unknown as { __openSignInCalled: boolean }).__openSignInCalled === true,
    );

    // #consent and #errorView are `hidden` in the static markup, so these two
    // only mean anything once the assertion above proves the page's JS ran.
    await expect(page.locator('#consent')).toBeHidden();
    await expect(page.locator('#errorView')).toBeHidden();
  });
});
