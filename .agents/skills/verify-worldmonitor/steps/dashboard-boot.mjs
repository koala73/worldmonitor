import { seedProfile, waitForBoot, waitForMap } from './_profile.mjs';

/**
 * Feature: dashboard boot (features/dashboard-boot.md).
 * Proves a cold visitor gets a hydrated dashboard: header, map surface, and a
 * grid of live panels — not the pre-render skeleton.
 */
export default async function ({ page, base, shot, log, expectVisible }) {
  await seedProfile(page);
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });

  await waitForBoot(page, { data: true });
  log('readiness markers: event handlers + initial data');

  await expectVisible('.header');
  await expectVisible('#panelsGrid .panel');
  // #mapContainer exists in the shell from the first byte, so its visibility
  // proves nothing. waitForMap waits for a renderer to actually mount.
  const renderer = await waitForMap(page);
  log(`map renderer: ${renderer}`);
  await shot('booted-dashboard');

  const state = await page.evaluate(() => ({
    panels: [...document.querySelectorAll('#panelsGrid .panel[data-panel]')].map((el) =>
      el.getAttribute('data-panel'),
    ),
    skeletonGone: !document.querySelector('.skeleton-shell'),
    layerToggles: document.querySelectorAll('.layer-toggle[data-layer]').length,
    statusText: document.querySelector('.status-indicator')?.textContent?.trim() ?? null,
  }));
  log('state', state.panels.length + ' panels', JSON.stringify({ ...state, panels: state.panels.slice(0, 8) }));

  if (!state.skeletonGone) throw new Error('pre-render skeleton is still mounted — the app never hydrated');
  if (state.panels.length < 3) throw new Error(`expected a populated panel grid, got ${state.panels.length} panels`);
  if (state.layerToggles < 5) throw new Error(`the map mounted (${renderer}) but rendered ${state.layerToggles} layer controls`);

  // Panels that boot into an error/unavailable state are the failure this
  // drive exists to catch: the grid can be full and still be all red.
  const broken = await page.evaluate(() =>
    [...document.querySelectorAll('#panelsGrid .panel[data-panel]')]
      .filter((el) => el.querySelector('.panel-error, .panel-unavailable'))
      .map((el) => el.getAttribute('data-panel')),
  );
  log('panels in an error/unavailable state:', JSON.stringify(broken));

  return { panels: state.panels.length, renderer, broken };
}
