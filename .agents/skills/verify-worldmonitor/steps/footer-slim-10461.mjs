import { seedProfile, waitForBoot } from './_profile.mjs';

export default async function ({ page, base, shot, log, expectVisible }) {
  await seedProfile(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });

  const footer = page.locator('.site-footer');
  await expectVisible('.site-footer');
  const box = await footer.boundingBox();
  log('desktop-footer-height', box?.height ?? null);
  if (!box || box.height > 28) {
    throw new Error(`desktop footer height ${box?.height} exceeds 28px`);
  }
  await expectVisible('.site-footer-meta');
  if (await page.locator('.site-footer nav').count()) {
    throw new Error('compact footer must not keep the old site nav');
  }
  await shot('desktop-footer-1440');

  await page.setViewportSize({ width: 940, height: 660 });
  await page.waitForTimeout(200);
  const midBox = await footer.boundingBox();
  log('mid-footer-height', midBox?.height ?? null);
  if (!midBox || midBox.height > 28) {
    throw new Error(`940px footer height ${midBox?.height} exceeds 28px`);
  }
  await shot('desktop-footer-940');

  await page.locator('#unifiedSettingsBtn').click();
  await expectVisible('.dashboard-chrome-links');
  await expectVisible('.dashboard-site-links-row');
  await expectVisible('.legal-links-row');
  const linksInView = await page.locator('.dashboard-site-links-row').evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  });
  if (!linksInView) throw new Error('Settings site links must be in the viewport on open');
  for (const href of ['/countries/', '/chokepoints/', '/crises/', '/tools/', '/accuracy/']) {
    const count = await page.locator(`.dashboard-site-links-row a[href$="${href}"]`).count();
    if (count !== 1) throw new Error(`Settings missing site link ${href}`);
  }
  await shot('settings-site-links');
  await page.locator('.unified-settings-close').click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const mobileHidden = await footer.isHidden();
  log('mobile-footer-hidden', mobileHidden);
  if (!mobileHidden) throw new Error('mobile footer should stay visually collapsed');
  await page.locator('[data-mobile-tab="more"]').click();
  await expectVisible('.mobile-menu-footer-links');
  for (const path of ['/countries/', '/chokepoints/', '/crises/', '/tools/', '/accuracy/']) {
    const count = await page.locator(`.mobile-menu-footer-links a[href*="${path}"]`).count();
    if (count !== 1) throw new Error(`More menu missing ${path}`);
  }
  await shot('mobile-more-links');
}
