import { seedProfile, waitForBoot } from './_profile.mjs';

const PANEL_KEY = 'climate-news';
const TITLE = 'Arctic sea ice hits a record winter low';
const SUMMARY = 'Researchers report the lowest winter maximum in the satellite record.';
const TRANSLATED_TITLE = 'Arktisches Meereis erreicht ein Rekordtief';
const TRANSLATED_SUMMARY = 'Forschende berichten vom niedrigsten Wintermaximum der Satellitenaufzeichnung.';

export default async function ({ page, base, shot, log }) {
  await seedProfile(page, {
    localStorage: {
      'wm-pro-key': 'wm-verify-climate-translate',
      'wm-locale-explicit': 'de',
    },
  });

  // No seeded Redis locally, so the climate feed answers unavailable. Serve
  // two fixture cards instead: the control under test is the card's button,
  // not the feed.
  const PUBLISHED_AT = Date.now() - 2 * 60 * 60 * 1000;
  await page.route('**/api/climate/v1/list-climate-news**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            title: TITLE,
            summary: SUMMARY,
            sourceName: 'Carbon Brief',
            url: 'https://example.org/arctic',
            publishedAt: PUBLISHED_AT,
          },
          {
            title: 'UNEP warns emissions gap is widening',
            summary: 'The annual review finds pledges still short of the 1.5C pathway.',
            sourceName: 'UNEP',
            url: 'https://example.org/unep',
            publishedAt: PUBLISHED_AT - 3 * 60 * 60 * 1000,
          },
        ],
      }),
    });
  });

  // The provider call behind translateText. Stubbed with fixed German text so
  // the screenshot shows the real UI path on controlled data rather than
  // whatever a local provider happens to return.
  let providerUnavailable = false;
  const translations = new Map([[TITLE, TRANSLATED_TITLE], [SUMMARY, TRANSLATED_SUMMARY]]);
  await page.route('**/summarize-article**', async (route) => {
    const request = route.request().postDataJSON();
    const summary = !providerUnavailable && request.mode === 'translate' && request.variant === 'de'
      ? translations.get(request.headlines[0])
      : undefined;
    await route.fulfill({ json: { summary: summary ?? '', fallback: !summary } });
  });

  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });

  // The app writes the FULL panel map at boot, and the full variant lands at
  // the free cap of 40 enabled panels, so the Settings toggle refuses a 41st
  // with a cap toast. Make room in the app's own store, then reload: this is
  // setup for the control under test, which is clicked by hand below.
  await page.evaluate((key) => {
    const map = JSON.parse(localStorage.getItem('worldmonitor-panels') ?? '{}');
    let freed = 0;
    for (const [name, value] of Object.entries(map)) {
      if (freed >= 6) break;
      if (name !== key && value?.enabled) { value.enabled = false; freed += 1; }
    }
    if (map[key]) map[key].enabled = true;
    localStorage.setItem('worldmonitor-panels', JSON.stringify(map));
  }, PANEL_KEY);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });

  const panel = page.locator(`#panelsGrid .panel[data-panel="${PANEL_KEY}"]`);
  await panel.waitFor({ state: 'visible', timeout: 60_000 });
  await panel.scrollIntoViewIfNeeded();

  const card = panel.locator('.climate-news-card').first();
  await card.waitFor({ state: 'visible', timeout: 60_000 });

  const time = await card.locator('.climate-news-card__time').textContent();
  if (time !== 'vor 2 Stunden') throw new Error(`unexpected German relative time: ${time}`);

  const title = card.locator('.climate-news-card__title');
  const summary = card.locator('.climate-news-card__summary');
  const link = card.getByRole('link');
  const button = card.locator('button');
  await shot('climate-news-de-before-translate', { locator: panel });

  await link.focus();
  await page.keyboard.press('Tab');
  if (!await button.evaluate((el) => el === document.activeElement)) {
    throw new Error('Tab did not move from the article link to the translate button');
  }
  await page.keyboard.press('Enter');
  await card.getByRole('button', { name: 'Restore original text' }).waitFor();
  const translated = await title.textContent();
  const translatedSummary = await summary.textContent();
  if (translated !== TRANSLATED_TITLE || translatedSummary !== TRANSLATED_SUMMARY) {
    throw new Error(`unexpected translations: ${translated}, ${translatedSummary}`);
  }
  await shot('climate-news-de-after-translate', { locator: panel });

  await page.keyboard.press('Enter');
  await card.getByRole('button', { name: 'Translate', exact: true }).waitFor();
  if (await title.textContent() !== TITLE || await summary.textContent() !== SUMMARY) {
    throw new Error('original title and summary were not restored');
  }
  await shot('climate-news-de-restored', { locator: panel });

  providerUnavailable = true;
  await button.click();
  const status = card.getByRole('status');
  await status.filter({ hasText: /\S/ }).waitFor();
  if (await title.textContent() !== TITLE || await summary.textContent() !== SUMMARY) {
    throw new Error('failed translation changed the published text');
  }
  await shot('climate-news-de-provider-unavailable', { locator: panel });

  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  await shot('climate-news-de-mobile-provider-unavailable', { locator: panel });

  log('relative time and translated fields:', { time, translated, translatedSummary });
  return { time, translated, translatedSummary, restored: TITLE, failure: await status.textContent() };
}
