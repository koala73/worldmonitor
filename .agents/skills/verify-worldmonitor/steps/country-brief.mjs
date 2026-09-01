import { seedProfile, waitForBoot } from './_profile.mjs';

/**
 * Feature: country brief / deep dive (features/country-brief.md).
 * Drives the shareable deep link a user actually receives — /dashboard?country=UA —
 * and proves the brief slides in with that country's content, then closes.
 */
const COUNTRY = process.env.WM_VERIFY_COUNTRY ?? 'UA';

export default async function ({ page, base, shot, log, expectVisible }) {
  await seedProfile(page);
  await page.goto(`${base}/dashboard?country=${COUNTRY}`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page);
  await expectVisible('#panelsGrid .panel');

  const panel = page.locator('#country-deep-dive-panel');
  await panel.waitFor({ state: 'attached', timeout: 90_000 });
  // aria-hidden is the accessible open/closed state; visibility proves it is
  // actually on screen rather than parked off-canvas by the slide-in transform.
  await page.waitForFunction(() => {
    const el = document.getElementById('country-deep-dive-panel');
    if (!el) return false;
    return el.getAttribute('aria-hidden') === 'false'
      && getComputedStyle(el).visibility === 'visible';
  }, undefined, { timeout: 90_000 });
  log('country brief is open and visible');
  await shot('country-brief-open');

  const content = await page.evaluate(() => {
    const el = document.getElementById('deep-dive-content');
    return {
      chars: el?.textContent?.replace(/\s+/g, ' ').trim().length ?? 0,
      heading: el?.querySelector('h1, h2, .country-brief-title, .deep-dive-title')?.textContent?.trim() ?? null,
      sections: el?.querySelectorAll('section, .brief-section').length ?? 0,
    };
  });
  log('brief content', JSON.stringify(content));
  if (content.chars < 200) {
    throw new Error(`country brief rendered an effectively empty body (${content.chars} chars)`);
  }

  // The URL is the shareable artifact: getShareUrl() re-adds ?country=<code>
  // while the brief is visible. That write is debounced (250 ms) and competes
  // with map-driven syncs, so poll rather than reading it once.
  await page.waitForFunction(
    (code) => new URL(window.location.href).searchParams.get('country') === code,
    COUNTRY,
    { timeout: 15_000 },
  ).catch(() => {
    throw new Error(`?country=${COUNTRY} never reappeared in the URL; got ${page.url()}`);
  });
  log('url carries the country deep link:', page.url());

  await page.locator('#deep-dive-close').click();
  await page.waitForFunction(() => {
    const el = document.getElementById('country-deep-dive-panel');
    return !el || el.getAttribute('aria-hidden') === 'true';
  }, undefined, { timeout: 30_000 });
  log('country brief closed');
  await shot('country-brief-closed');

  return { country: COUNTRY, ...content };
}
