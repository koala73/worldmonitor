/**
 * Shared browser-profile seeding for verification drives.
 *
 * The dashboard boots with several first-run overlays (layer warning, PRO
 * banner, mission-preset prompt) that sit on top of the controls a drive needs
 * to click. Dismissing them is exactly what a returning user's localStorage
 * looks like — it is not a test-only bypass of any product gate.
 *
 * Call BEFORE page.goto(). addInitScript re-runs on every navigation, so the
 * seed is guarded by a sessionStorage flag: a reload inside a drive must not
 * wipe the very preference under test.
 */
export async function seedProfile(page, overrides = {}) {
  await page.addInitScript((opts) => {
    if (sessionStorage.getItem('__wm_verify_seeded__')) return;
    localStorage.clear();
    sessionStorage.clear();
    sessionStorage.setItem('__wm_verify_seeded__', '1');
    localStorage.setItem('worldmonitor-variant', opts.variant ?? 'full');
    // First-run overlays that would otherwise steal the click target.
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    for (const [key, value] of Object.entries(opts.localStorage ?? {})) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
  }, overrides);
}

/** Wait for the two readiness markers VITE_E2E=1 stamps on <html>. */
export async function waitForBoot(page, { data = false, timeout = 90_000 } = {}) {
  await page.waitForSelector('html[data-wm-event-handlers-ready="true"]', { timeout });
  if (data) {
    await page.waitForSelector('html[data-wm-initial-data-ready="true"]', { timeout });
  }
}

/**
 * Wait for the map renderer to finish mounting, and report which one won.
 *
 * #mapContainer exists in the shell long before any renderer does, so waiting
 * on the container is a race: MapContainer marks the shell with aria-busy +
 * data-map-renderer-pending, then swaps in one of the mode classes. Returns
 * 'deckgl' | 'globe' | 'svg' — deck.gl is the intended desktop renderer and
 * 'svg' means it fell back (the reason is a [MapContainer] console warning).
 */
export async function waitForMap(page, { timeout = 90_000 } = {}) {
  await page.waitForSelector(
    '#mapContainer.deckgl-mode:not([aria-busy]), #mapContainer.globe-mode:not([aria-busy]), #mapContainer.svg-mode:not([aria-busy])',
    { timeout },
  );
  return page.evaluate(() => {
    const el = document.getElementById('mapContainer');
    if (el?.classList.contains('deckgl-mode')) return 'deckgl';
    if (el?.classList.contains('globe-mode')) return 'globe';
    return 'svg';
  });
}
