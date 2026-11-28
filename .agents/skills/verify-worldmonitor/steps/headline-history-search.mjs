import { seedProfile, waitForBoot } from './_profile.mjs';

/**
 * Feature: Cmd+K finds a headline the dashboard no longer holds
 * (features/global-search.md, `search-headline-history`).
 *
 * The loaded news is a fixed digest (TEST DATA), so the drive knows which
 * headlines the browser holds. The headline history answers come from:
 *   - by default, fixtures served by page.route (controlled responses);
 *   - with WM_VERIFY_HEADLINE_LIVE=1, the dev server's real handlers, which
 *     need a Redis the run seeded. Never point that at production.
 *
 * Signed out, the browser must ask the 24-hour route, so a headline served
 * three days ago is not listed. WM_VERIFY_MOBILE=1 drives the phone sheet.
 */
const HOUR = 3_600_000;
const QUERY = 'hormuz';
const OLD_TITLE = 'Tanker seized in Strait of Hormuz after patrol boat standoff';
const OLDER_TITLE = 'Hormuz shipping insurers raise war-risk premiums';
const ARCHIVE_ONLY_TITLE = 'Hormuz transit talks collapse in Muscat';
const LOADED_TITLE = 'Hormuz naval drill announced for next week';

function digest(now) {
  // The panel keeps only items from a configured feed, so every loaded item
  // names a real World News publisher.
  const items = [
    { source: 'BBC World', title: LOADED_TITLE },
    { source: 'BBC World', title: 'Central bank holds rates at 4.5% for a third meeting' },
    { source: 'BBC World', title: 'Port strike ends after overnight pay deal' },
  ];
  return {
    categories: {
      politics: {
        items: items.map((item, index) => ({
          ...item,
          link: `https://example.com/test-data/loaded-${index}`,
          publishedAt: now - (index + 1) * 20 * 60_000,
          isAlert: false,
        })),
      },
    },
    feedStatuses: {},
    generatedAt: new Date(now).toISOString(),
  };
}

function historyFixture(now, windowHours) {
  const headlines = [
    { source: 'Reuters World', title: OLD_TITLE, link: 'https://example.com/test-data/hormuz-tanker', publishedAt: now - 6 * HOUR, lastServedAt: now - 5 * HOUR },
    { source: 'Reuters World', title: LOADED_TITLE, link: 'https://example.com/test-data/hormuz-drill-syndicated', publishedAt: now - 2 * HOUR, lastServedAt: now - 5 * HOUR },
    { source: 'BBC World', title: OLDER_TITLE, link: 'https://example.com/test-data/hormuz-insurers', publishedAt: now - 9 * HOUR, lastServedAt: now - 8 * HOUR },
    { source: 'Al Jazeera', title: ARCHIVE_ONLY_TITLE, link: 'https://example.com/test-data/hormuz-talks', publishedAt: now - 74 * HOUR, lastServedAt: now - 72 * HOUR },
  ].filter((headline) => now - headline.lastServedAt <= windowHours * HOUR);
  return { headlines, searchedHeadlines: headlines.length + 1, windowHours, state: 'complete', newestServedAt: now - 5 * HOUR };
}

export default async function ({ page, context, base, shot, log, expectVisible }) {
  const mobile = process.env.WM_VERIFY_MOBILE === '1';
  const live = process.env.WM_VERIFY_HEADLINE_LIVE === '1';
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 });
  const now = Date.now();

  const searchRequests = [];
  await page.route('**/api/news/v1/list-feed-digest*', (route) => route.fulfill({ json: digest(now) }));
  await page.route('**/api/news/v1/search-headline*', async (route) => {
    const url = new URL(route.request().url());
    const archive = url.pathname.endsWith('/search-headline-archive');
    searchRequests.push({ path: url.pathname, query: url.searchParams.get('query'), variant: url.searchParams.get('variant'), lang: url.searchParams.get('lang') });
    if (live) return route.continue();
    return route.fulfill({ json: historyFixture(now, archive ? 168 : 24) });
  });
  // The article link opens in a new tab; keep that tab off the network.
  await context.route('https://example.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<title>test data article</title>' }));

  await seedProfile(page, {
    localStorage: { 'worldmonitor-panels': JSON.stringify({ politics: { name: 'World News', enabled: true, priority: 0 } }) },
  });
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page);
  log(`TEST DATA drive: ${live ? 'headline history from the dev handlers' : 'headline history from page.route fixtures'}; mobile=${mobile}`);

  // The loaded set is exactly what the digest fixture served, and the older
  // headline is not in it. A news panel loads its items when it scrolls into
  // view, so bring World News on screen and wait for the loaded headline.
  const panel = page.locator('#panelsGrid .panel[data-panel="politics"]');
  if (mobile) await page.locator('[data-mobile-tab="panels"]').click().catch(() => {});
  const deadline = Date.now() + 90_000;
  for (;;) {
    await panel.scrollIntoViewIfNeeded().catch(() => {});
    if (await panel.getByText(LOADED_TITLE).first().isVisible().catch(() => false)) break;
    if (Date.now() > deadline) throw new Error('the digest fixture never rendered in World News');
    await page.waitForTimeout(500);
  }
  if (await panel.getByText(OLD_TITLE).count() > 0) throw new Error('the older headline is on the dashboard; the drive would prove nothing');
  log(`World News holds "${LOADED_TITLE}" and does not hold "${OLD_TITLE}"`);
  await shot(mobile ? 'mobile-loaded-news' : 'desktop-loaded-news');
  await page.evaluate(() => window.scrollTo(0, 0));

  const REAL_RESULT = '.search-overlay .search-result-item[data-index]';
  if (mobile) await page.locator('[data-mobile-tab="search"]').click();
  else await (await expectVisible('#searchBtn')).click();
  const input = await expectVisible('.search-overlay .search-input');
  await input.pressSequentially(QUERY, { delay: 30 });

  const oldRow = page.locator(REAL_RESULT).filter({ hasText: OLD_TITLE });
  await oldRow.waitFor({ state: 'visible', timeout: 30_000 });
  const rows = await page.evaluate((selector) => [...document.querySelectorAll(selector)].map((row) => ({
    title: row.querySelector('.search-result-title')?.textContent?.trim() ?? '',
    subtitle: row.querySelector('.search-result-subtitle')?.textContent?.trim() ?? '',
    type: row.querySelector('.search-result-type')?.textContent?.trim() ?? '',
  })), REAL_RESULT);
  log('rows:', JSON.stringify(rows));
  // The Signals channel leaves out panel commands, so the headlines lead the list.
  await page.locator('.search-overlay [data-search-scope="signals"]').click();
  await oldRow.waitFor({ state: 'visible', timeout: 30_000 });
  await shot(mobile ? 'mobile-old-headline-found' : 'desktop-old-headline-found');
  await page.locator('.search-overlay [data-search-scope="all"]').click();

  // Publisher and age are on screen, on a phone too (the sheet hides other subtitles).
  if (!(await oldRow.locator('.search-result-subtitle').isVisible())) {
    throw new Error('publisher and age are not visible on the older headline');
  }
  const old = rows.find((row) => row.title === OLD_TITLE);
  if (!old || !/^Reuters World · 6 hours ago$/.test(old.subtitle)) {
    throw new Error(`the older headline must show publisher and age, got ${JSON.stringify(old)}`);
  }
  if (old.type !== 'News') throw new Error(`plain type label expected, got "${old.type}"`);
  const loadedRows = rows.filter((row) => row.title === LOADED_TITLE);
  if (loadedRows.length !== 1 || loadedRows[0].subtitle !== 'BBC World') {
    throw new Error(`a headline both loaded and in the history must be listed once, as the loaded row: ${JSON.stringify(loadedRows)}`);
  }
  if (rows.some((row) => row.title === ARCHIVE_ONLY_TITLE)) {
    throw new Error('a signed-out search listed a headline served three days ago');
  }
  if (!mobile && !rows.some((row) => row.title === OLDER_TITLE)) {
    throw new Error('the second history headline is missing on desktop');
  }
  const paths = [...new Set(searchRequests.map((request) => request.path))];
  if (paths.length !== 1 || paths[0] !== '/api/news/v1/search-headlines') {
    throw new Error(`a signed-out browser must ask only the 24-hour route, asked ${JSON.stringify(paths)}`);
  }
  const forQuery = searchRequests.filter((request) => request.query === QUERY);
  log('signed-out requests:', JSON.stringify(searchRequests));
  if (forQuery.length === 0) throw new Error('the typed query was never sent');

  // Words in another order than the title has them: the server matches, the row stays.
  await input.fill('');
  await input.pressSequentially('tanker hormuz standoff', { delay: 30 });
  // Wait for the list to answer the new query: the loaded headline does not
  // hold these words, so it leaves; the older one comes back from the server.
  await page.locator(REAL_RESULT).filter({ hasText: LOADED_TITLE }).waitFor({ state: 'hidden', timeout: 30_000 });
  await oldRow.waitFor({ state: 'visible', timeout: 30_000 });
  await shot(mobile ? 'mobile-words-in-any-order' : 'desktop-words-in-any-order');

  // Selecting it opens the article in a new tab and leaves the dashboard where it was.
  const [article] = await Promise.all([context.waitForEvent('page', { timeout: 30_000 }), oldRow.click()]);
  await article.waitForLoadState('domcontentloaded').catch(() => {});
  const opened = article.url();
  if (opened !== 'https://example.com/test-data/hormuz-tanker') throw new Error(`opened ${opened}`);
  if (!page.url().includes('/dashboard')) throw new Error('the dashboard navigated away');
  log(`selecting the headline opened ${opened} in a new tab`);
  await article.close();

  return { live, mobile, rows: rows.length, requests: searchRequests.length };
}
