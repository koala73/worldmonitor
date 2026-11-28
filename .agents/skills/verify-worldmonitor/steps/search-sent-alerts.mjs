import { seedProfile, waitForBoot } from './_profile.mjs';

/**
 * Feature: "Alerts sent to you" in global search (features/global-search.md).
 *
 * A headline the user was alerted on must be findable in ⌘K after the
 * dashboard no longer has it loaded. This drive:
 *   1. searches for the headline as an anonymous visitor and proves the loaded
 *      news does not contain it (no result);
 *   2. signs in a Pro test account, opens the palette again, types the same
 *      headline and finds it under "Alerts sent to you";
 *   3. selects it and proves the article opens in a new tab;
 *   4. repeats the search on a phone-sized viewport.
 *
 * Controlled inputs, both test data:
 *   - ListSentAlerts is answered by this step (`page.route`), so no Redis or
 *     relay is involved. The step records that the request carried a bearer.
 *   - The signed-in Pro account is a fake Clerk instance installed through
 *     clerk.ts's own `__setClerkInstanceForTests` seam; a local dev server has
 *     no Clerk key.
 *
 * Not proven here: the relay writing the record, and the gateway's real auth.
 * tests/notification-relay-sent-alerts.test.mjs and
 * server/__tests__/gateway-list-sent-alerts.test.ts cover those.
 */
const ALERT_TITLE = 'Test alert: Zubrowka parliament dissolved after confidence vote';
const ALERT_LINK = 'https://news.example.test/world/zubrowka-parliament';
const OTHER_TITLE = 'Test alert: Central bank of Atlantis cuts rates to zero';
// Entity rows only: a headline's words can also match panel commands, which
// list first under their own heading.
const RESULT = '.search-results .search-result-item[data-index]:not(.command-item)';

const SENT_ALERTS = {
  state: 'ok',
  alerts: [
    { title: OTHER_TITLE, source: 'Test Wire', link: 'https://news.example.test/markets/atlantis-rates', sentAt: Date.now() - 20 * 60_000 },
    { title: ALERT_TITLE, source: 'Test Wire', link: ALERT_LINK, sentAt: Date.now() - 3 * 3_600_000 },
  ],
};

/** Install a signed-in Pro test account and refresh the app's auth snapshot. */
async function signInTestProAccount(page) {
  await page.evaluate(async () => {
    const payload = btoa(JSON.stringify({ sub: 'user_verify', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }));
    const token = `e30.${payload}.verify`;
    const clerk = await import('/src/services/clerk.ts');
    clerk.__setClerkInstanceForTests({
      user: {
        id: 'user_verify',
        fullName: 'Verify Pro',
        firstName: 'Verify',
        primaryEmailAddress: { emailAddress: 'verify@example.test' },
        imageUrl: null,
        publicMetadata: { plan: 'pro' },
      },
      session: { id: 'sess_verify', getToken: async () => token },
      addListener: (callback) => { callback(); return () => {}; },
    });
    const auth = await import('/src/services/auth-state.ts');
    auth.subscribeAuthState(() => {});
    if (auth.getAuthState().user?.id !== 'user_verify') throw new Error('test account did not sign in');
  });
}

async function typeQuery(page, inputSelector, query) {
  const input = page.locator(inputSelector);
  await input.waitFor({ state: 'visible', timeout: 15_000 });
  await input.fill('');
  await input.pressSequentially(query, { delay: 8 });
  return input;
}

/** Wait until the palette has rendered the results for `query` (the search is debounced). */
async function waitForSearched(page, query) {
  await page.waitForFunction(
    // The status line ends with the query it describes ("2 results for <query>").
    (needle) => (document.querySelector('.search-results-status')?.textContent ?? '').toLowerCase().trim().endsWith(needle),
    query.toLowerCase(),
    { timeout: 15_000 },
  );
}

/** The rows under the "Alerts sent to you" heading, up to the next heading. */
function alertSection(rows) {
  const start = rows.indexOf('[Alerts sent to you]');
  if (start < 0) return [];
  const rest = rows.slice(start + 1);
  const end = rest.findIndex((row) => row.startsWith('['));
  return end < 0 ? rest : rest.slice(0, end);
}

async function readRows(page) {
  return page.evaluate(() => [...document.querySelectorAll('.search-results > *')].map((el) => (
    el.classList.contains('search-section-header')
      ? `[${el.textContent?.trim()}]`
      : `${el.querySelector('.search-result-title')?.textContent?.trim() ?? el.textContent?.trim()} | ${el.querySelector('.search-result-subtitle')?.textContent?.trim() ?? ''} | ${el.querySelector('.search-result-type')?.textContent?.trim() ?? ''}`
  )));
}

export default async function ({ page, context, base, shot, log, expectVisible }) {
  const requests = [];
  await context.route('**/api/news/v1/list-sent-alerts*', async (route) => {
    requests.push({ authorization: route.request().headers().authorization ?? '' });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SENT_ALERTS) });
  });
  await context.route('https://news.example.test/**', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<title>Test article</title><h1>Test article</h1>',
  }));

  await seedProfile(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });
  await expectVisible('#panelsGrid .panel');

  // 1. Anonymous: the headline is not in the loaded news, so search finds nothing.
  await (await expectVisible('#searchBtn')).click();
  await typeQuery(page, '.search-modal .search-input', ALERT_TITLE);
  await waitForSearched(page, ALERT_TITLE);
  if (await page.locator(RESULT).count() !== 0) throw new Error('the alert headline must not be in the loaded news');
  if (await page.locator('[data-search-section="alerts"]').count() !== 0) throw new Error('an anonymous visitor must see no alerts section');
  if (requests.length !== 0) throw new Error('an anonymous visitor must not request alert history');
  log('anonymous: no result for the alerted headline, and no alert-history request');
  await shot('desktop-before-not-found');
  await page.keyboard.press('Escape');
  await page.locator('.search-modal').waitFor({ state: 'hidden', timeout: 15_000 });

  // 2. Signed-in Pro account: the same headline is found under "Alerts sent to you".
  await signInTestProAccount(page);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await typeQuery(page, '.search-modal .search-input', ALERT_TITLE);
  // The alert request starts when the palette opens and can answer mid-typing,
  // so wait for the results of the whole query before reading rows.
  await waitForSearched(page, ALERT_TITLE);
  await page.locator('[data-search-section="alerts"]').waitFor({ state: 'visible', timeout: 15_000 });
  const desktopRows = await readRows(page);
  log('desktop rows:', JSON.stringify(desktopRows));
  const [desktopAlert, ...otherDesktopAlerts] = alertSection(desktopRows);
  if (otherDesktopAlerts.length !== 0) throw new Error(`only the searched alert should match: ${JSON.stringify(desktopRows)}`);
  if (!desktopAlert?.startsWith(`${ALERT_TITLE} | Test Wire · Sent `)) throw new Error(`alert row missing publisher or sent time: ${desktopAlert}`);
  if (!desktopAlert.includes('news.example.test') || !desktopAlert.endsWith('| Alert')) throw new Error(`alert row missing link host or type: ${desktopAlert}`);
  if (requests.length !== 1 || !requests[0].authorization.startsWith('Bearer ')) throw new Error(`expected one bearer-authenticated request, saw ${JSON.stringify(requests)}`);
  await shot('desktop-alert-found');

  // A shorter query lists both alerts ahead of ordinary results.
  await typeQuery(page, '.search-modal .search-input', 'test alert');
  await waitForSearched(page, 'test alert');
  const sectionRows = alertSection(await readRows(page));
  log('alerts for "test alert":', JSON.stringify(sectionRows));
  if (sectionRows.length !== 2 || !sectionRows[0].startsWith(OTHER_TITLE)) throw new Error(`both alerts should list, newest first: ${JSON.stringify(sectionRows)}`);
  await shot('desktop-alert-section');

  // 3. Selecting the alert opens the article in a new tab.
  await typeQuery(page, '.search-modal .search-input', ALERT_TITLE);
  await waitForSearched(page, ALERT_TITLE);
  const [article] = await Promise.all([
    context.waitForEvent('page', { timeout: 15_000 }),
    page.locator(RESULT).first().click(),
  ]);
  await article.waitForLoadState('domcontentloaded');
  if (article.url() !== ALERT_LINK) throw new Error(`article tab opened ${article.url()}`);
  if (await article.evaluate(() => window.opener !== null)) throw new Error('the article tab must not get a window.opener');
  log('selecting the alert opened', article.url(), 'in a new tab with no opener');
  await article.close();
  await page.locator('.search-modal').waitFor({ state: 'hidden', timeout: 15_000 });

  // 4. Phone viewport: the bottom sheet lists the alert too.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });
  await signInTestProAccount(page);
  // The phone layout opens search from the bottom tab bar.
  await (await expectVisible('[data-mobile-tab="search"]')).click();
  await typeQuery(page, '.search-sheet .search-input', ALERT_TITLE);
  await waitForSearched(page, ALERT_TITLE);
  await page.locator('.search-sheet [data-search-section="alerts"]').waitFor({ state: 'visible', timeout: 15_000 });
  const mobileRows = await readRows(page);
  log('mobile rows:', JSON.stringify(mobileRows));
  if (!alertSection(mobileRows)[0]?.startsWith(ALERT_TITLE)) throw new Error(`mobile sheet did not list the alert: ${JSON.stringify(mobileRows)}`);
  await shot('mobile-alert-found');

  return { desktopRows, mobileRows, requests: requests.length };
}
