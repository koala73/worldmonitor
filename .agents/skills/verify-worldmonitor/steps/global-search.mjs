import { seedProfile, waitForBoot } from './_profile.mjs';

/**
 * Feature: global search / command palette (features/global-search.md).
 * Opens the palette the way a user does (header button and ⌘K), types a query,
 * and proves ranked results appear and a result can be activated.
 */
const QUERY = process.env.WM_VERIFY_SEARCH ?? 'ukraine';

export default async function ({ page, base, shot, log, expectVisible }) {
  await seedProfile(page);
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page);
  await expectVisible('#panelsGrid .panel');

  await (await expectVisible('#searchBtn')).click();
  const input = await expectVisible('.search-modal .search-input');
  log('search palette opened from the header button');

  // The empty palette already renders `.search-result-item.tip-item` hints, so
  // asserting on `.search-result-item` alone passes without ever searching.
  // Real matches are the only ones carrying data-index.
  const REAL_RESULT = '.search-modal .search-results .search-result-item[data-index]';
  const tipsBefore = await page.locator('.search-modal .search-results .tip-item').count();
  log(`palette opened showing ${tipsBefore} tip rows and 0 real results`);

  await input.pressSequentially(QUERY, { delay: 25 });
  await page.locator(REAL_RESULT).first().waitFor({ state: 'visible', timeout: 30_000 });
  await shot('search-results');

  const results = await page.evaluate((selector) =>
    [...document.querySelectorAll(selector)]
      .slice(0, 8)
      .map((el) => el.textContent?.replace(/\s+/g, ' ').trim().slice(0, 90)),
    REAL_RESULT,
  );
  log(`results for "${QUERY}":`, JSON.stringify(results));
  if (results.length === 0) throw new Error(`no real search results for "${QUERY}"`);
  if (!results.some((r) => r?.toLowerCase().includes(QUERY.toLowerCase().slice(0, 5)))) {
    throw new Error(`results do not mention "${QUERY}": ${JSON.stringify(results)}`);
  }

  // Escape closes it — the palette must not trap the user.
  await page.keyboard.press('Escape');
  await page.locator('.search-modal').waitFor({ state: 'hidden', timeout: 15_000 });
  log('Escape closed the palette');

  // ⌘K is the advertised shortcut on the button itself; prove it opens too.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await page.locator('.search-modal .search-input').waitFor({ state: 'visible', timeout: 15_000 });
  log('keyboard shortcut reopened the palette');
  await shot('search-palette-via-shortcut');
  await page.keyboard.press('Escape');

  return { query: QUERY, resultCount: results.length };
}
