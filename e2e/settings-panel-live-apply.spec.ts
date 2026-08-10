import { expect, test, type Page } from '@playwright/test';

/**
 * The Settings modal must apply a panel toggle to the LIVE dashboard on Save.
 *
 * Regression guard for the split-brain `applyPanelSettings()`: the settings
 * save path (EventHandlerManager) had its own copy that only re-toggled panels
 * already mounted in `ctx.panels`, while the deferred-mount bookkeeping added
 * in #4367 lives in PanelLayoutManager's copy. A panel that boots disabled is
 * parked in `deferredPanelMounts` with no shell and no IntersectionObserver, so
 * the settings copy had nothing to toggle — enabling it did nothing until a
 * page reload re-ran createPanels().
 */

/** A full-variant panel, seeded disabled below so it boots into deferredPanelMounts. */
const PANEL_KEY = 'threat-timeline';
const PANEL_SELECTOR = `.panel[data-panel="${PANEL_KEY}"]`;

async function seedDashboard(page: Page): Promise<void> {
  await page.addInitScript((panelKey) => {
    // Seed once per tab: addInitScript re-runs on every navigation, and a
    // re-seed on reload would wipe the very preference under test.
    if (sessionStorage.getItem('__settings_live_apply_seeded__')) return;
    localStorage.clear();
    sessionStorage.clear();
    sessionStorage.setItem('__settings_live_apply_seeded__', '1');
    localStorage.setItem('worldmonitor-variant', 'full');
    // Pro: the free tier clamps to FREE_MAX_PANELS (40) and the full variant
    // already defaults over that, so a free profile has zero headroom and the
    // modal would refuse the toggle with a cap toast before reaching the bug.
    localStorage.setItem('wm-pro-key', 'e2e-live-apply');
    // Overlays that would otherwise steal the click target.
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    // Partial map: App merges every other ALL_PANELS key at its variant default.
    localStorage.setItem('worldmonitor-panels', JSON.stringify({
      [panelKey]: { name: 'Threat Timeline', enabled: false, priority: 1 },
    }));
  }, PANEL_KEY);
}

test('enabling a panel in Settings shows it on the dashboard without a reload', async ({ page }) => {
  await seedDashboard(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

  const settingsBtn = page.locator('#unifiedSettingsBtn');
  await expect(settingsBtn).toBeVisible({ timeout: 60_000 });
  // Boot is far enough along that the grid has real panels, so a later absence
  // of PANEL_SELECTOR means "disabled", not "not created yet".
  await expect(page.locator('#panelsGrid .panel').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(PANEL_SELECTOR)).toHaveCount(0);

  await settingsBtn.click();
  await page.locator('#us-tab-panels').click();

  const toggle = page.locator(`#usPanelToggles .panel-toggle-item[data-panel="${PANEL_KEY}"]`);
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  await expect(toggle).not.toHaveClass(/\bactive\b/);
  await toggle.click();
  await expect(toggle).toHaveClass(/\bactive\b/);

  const save = page.locator('.panels-save-layout');
  await expect(save).toBeEnabled();
  await save.click();
  await page.locator('.unified-settings-close').click();

  // No reload between the Save click and this assertion.
  await expect(page.locator(PANEL_SELECTOR)).toBeVisible({ timeout: 30_000 });
});
