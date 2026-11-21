import { seedProfile, waitForBoot } from './_profile.mjs';

/**
 * #10054: the Climate News card's on-demand translate control, and its
 * localized relative time. Drives the real user path: pick German in
 * Settings -> Language, enable the panel, then press the card's 文 button.
 */
const PANEL_KEY = 'climate-news';

export default async function ({ page, base, shot, log, expectVisible }) {
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
            title: 'Arctic sea ice hits a record winter low',
            summary: 'Researchers report the lowest winter maximum in the satellite record.',
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
  await page.route('**/summarize-article**', async (route) => {
    const body = route.request().postData() ?? '';
    const german = body.includes('ice') || body.includes('Arctic') || body.includes('sea')
      ? 'Arktisches Meereis erreicht ein Rekordtief'
      : 'Forschende berichten vom niedrigsten Wintermaximum der Satellitenaufzeichnung.';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ summary: german, text: german, translation: german }),
    });
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

  const time = await card.locator('.climate-news-card__time').first().textContent();
  const title = await card.locator('.climate-news-card__title').first().textContent();
  log('relative time as rendered:', JSON.stringify(time));
  log('published title:', JSON.stringify(title));
  if (/\d+[mhd] ago|just now/.test(time ?? '')) {
    throw new Error(`relative time is still an English literal: ${time}`);
  }

  const button = card.locator('.climate-news-card__translate').first();
  await button.waitFor({ state: 'visible', timeout: 30_000 });
  await shot('climate-news-de-before-translate');

  await button.click();
  await card.locator('.climate-news-card__translate.translated').waitFor({ state: 'visible', timeout: 30_000 });
  const translated = await card.locator('.climate-news-card__title').first().textContent();
  log('title after translate:', JSON.stringify(translated));
  if (translated === title) throw new Error('title did not change after translate');
  await shot('climate-news-de-after-translate');

  // Second press restores exactly what the source published.
  await button.click();
  const restored = await card.locator('.climate-news-card__title').first().textContent();
  log('title after second press:', JSON.stringify(restored));
  if (restored !== title) throw new Error(`original not restored: ${restored}`);
  await shot('climate-news-de-restored');

  return { time, title, translated, restored };
}
