import { seedProfile, waitForBoot } from './_profile.mjs';

/**
 * Feature: settings overlay (features/panel-settings.md).
 * Proves the real user path — open Settings, enable a panel, Save — puts the
 * panel on the LIVE dashboard with no reload.
 */
const PANEL_KEY = process.env.WM_VERIFY_PANEL ?? 'threat-timeline';

export default async function ({ page, base, shot, log, expectVisible }) {
  await seedProfile(page, {
    localStorage: {
      // The free tier clamps to FREE_MAX_PANELS and the full variant already
      // defaults over that, so a free profile has no headroom and the modal
      // refuses the toggle with a cap toast. wm-pro-key is the product's own
      // legacy tester-session path, not a test-only bypass.
      'wm-pro-key': 'wm-verify-panel-settings',
      // Boot this one panel disabled so enabling it is an observable change.
      'worldmonitor-panels': JSON.stringify({
        [PANEL_KEY]: { name: PANEL_KEY, enabled: false, priority: 1 },
      }),
    },
  });
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page);

  const panelSelector = `#panelsGrid .panel[data-panel="${PANEL_KEY}"]`;
  await expectVisible('#panelsGrid .panel');
  const before = await page.locator(panelSelector).count();
  log(`before: ${PANEL_KEY} mounted = ${before}`);
  if (before !== 0) throw new Error(`${PANEL_KEY} was expected to boot disabled, found ${before} on the grid`);
  await shot('dashboard-without-panel');

  await (await expectVisible('#unifiedSettingsBtn')).click();
  await (await expectVisible('#us-tab-panels')).click();
  await shot('settings-panels-tab');

  const toggle = page.locator(`#usPanelToggles .panel-toggle-item[data-panel="${PANEL_KEY}"]`);
  await toggle.waitFor({ state: 'visible', timeout: 30_000 });
  await toggle.click();
  await page
    .locator(`#usPanelToggles .panel-toggle-item.active[data-panel="${PANEL_KEY}"]`)
    .waitFor({ state: 'visible', timeout: 15_000 });
  log(`toggle is active after the click`);

  const save = page.locator('.panels-save-layout');
  await save.waitFor({ state: 'visible', timeout: 15_000 });
  await save.click();
  await page.locator('.unified-settings-close').click();
  log('saved and closed the settings overlay — no reload from here on');

  await page.locator(panelSelector).waitFor({ state: 'visible', timeout: 30_000 });
  await shot('panel-live-on-dashboard');

  // Side effect: the choice must also be persisted, or it evaporates on reload.
  const persisted = await page.evaluate((key) => {
    const raw = localStorage.getItem('worldmonitor-panels');
    if (!raw) return null;
    try {
      return JSON.parse(raw)[key] ?? null;
    } catch {
      return 'unparseable';
    }
  }, PANEL_KEY);
  log('persisted preference:', JSON.stringify(persisted));
  if (!persisted || persisted === 'unparseable' || persisted.enabled !== true) {
    throw new Error(`panel preference was not persisted as enabled: ${JSON.stringify(persisted)}`);
  }

  return { panel: PANEL_KEY, persisted };
}
