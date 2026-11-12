import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { seedAnonymousDashboard } from './bootstrap-request-budget-fixtures';

// Built from the committed ICESat-2 backfill baseline (scripts/data/reservoir-levels-baseline.json)
// through buildSummary in scripts/seed-reservoir-levels.mjs at 2026-11-11T00:00Z, then
// normalizeReservoirLevelsSeed, so it has the exact shape /api/climate/v1/list-reservoir-levels serves.
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/reservoir-levels.json', import.meta.url), 'utf8'));
const EMPTY = { reservoirs: [], fetchedAt: 0, dataAvailable: false, methodology: '' };

async function openDashboard(page: Page, body: unknown, sessionKey: string): Promise<void> {
  await seedAnonymousDashboard(page, 'full', {
    initializeOnce: {
      sessionKey, clearStorage: true,
      localStorage: {
        'worldmonitor-panels': JSON.stringify({
          'reservoir-levels': { name: 'Strategic Water Levels', enabled: true, priority: 1 },
        }),
      },
    },
  });
  await page.route('**/api/**', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/climate/v1/list-reservoir-levels**', (route) => route.fulfill({ json: body }));
  await page.goto('/');
}

test('Strategic Water Levels lists attention first, filters, and opens the reservoir on the map', async ({ page }, testInfo) => {
  await openDashboard(page, FIXTURE, '__reservoir_levels_test__');
  const panel = page.locator('.panel[data-panel="reservoir-levels"]');
  await expect(panel).toBeVisible();
  await panel.scrollIntoViewIfNeeded();
  const rows = panel.locator('button.wl-row');
  await expect(rows).toHaveCount(48);

  const statuses = await rows.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.status));
  const order = ['record_low', 'record_high', 'falling_fast', 'rising_fast', 'low', 'high', 'normal', 'insufficient_history', 'no_recent_data'];
  const ranks = statuses.map((s) => order.indexOf(s!));
  expect(ranks.every((rank, i) => rank >= 0 && (i === 0 || rank >= ranks[i - 1]!))).toBe(true);
  await expect(rows.first()).toHaveAttribute('data-status', 'record_low');
  await expect(rows.last()).toHaveAttribute('data-status', 'no_recent_data');

  const mead = panel.locator('button.wl-row[data-reservoir-id="mead"]');
  await expect(mead.locator('.wl-chip')).toHaveText('Record low');
  await expect(mead.locator('.wl-headline')).toContainText(/−8\.2 m vs usual for September/);
  await expect(mead.locator('.wl-detail')).toContainText(/−5\.3 m in 12 months · measured (6 Sept?|Sep 6) \(/);
  await expect(mead.locator('.wl-place')).toHaveText('United States · Colorado');
  await expect(mead.locator('svg.mini-sparkline')).toHaveCount(1);
  await expect(panel.locator('.wl-footer a[href="https://nsidc.org/data/atl13"]')).toBeVisible();

  await panel.locator('button[data-wl-filter="attention"]').click();
  await expect(panel.locator('button[data-wl-filter="attention"]')).toHaveAttribute('aria-pressed', 'true');
  const attention = await rows.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.status));
  expect(attention.length).toBeGreaterThan(0);
  expect(attention.every((s) => !['normal', 'insufficient_history', 'no_recent_data'].includes(s!))).toBe(true);
  await panel.locator('button[data-wl-filter="transboundary"]').click();
  await expect(panel.locator('button.wl-row[data-reservoir-id="gerd"]')).toBeVisible();
  await expect(panel.locator('button.wl-row[data-reservoir-id="three-gorges"]')).toHaveCount(0);
  await panel.locator('button[data-wl-filter="all"]').click();
  await expect(rows).toHaveCount(48);

  await panel.screenshot({ path: testInfo.outputPath('reservoir-levels-panel.png') });
  await mead.click();
  const popup = page.locator('.map-popup .wl-popup');
  await expect(popup).toBeVisible();
  await expect(popup.locator('.popup-title')).toContainText('Lake Mead');
  await expect(popup).toContainText('above sea level (EGM2008)');
  await expect(popup.locator('.wl-popup-source a[href="https://slideruleearth.io"]')).toHaveCount(1);
  const layers = await page.evaluate(() => JSON.parse(localStorage.getItem('worldmonitor-layers') || '{}'));
  expect(layers.reservoirLevels).toBe(true);
});

test('Strategic Water Levels shows the empty state', async ({ page }) => {
  await openDashboard(page, EMPTY, '__reservoir_levels_empty__');
  const panel = page.locator('.panel[data-panel="reservoir-levels"]');
  await expect(panel).toBeVisible();
  // The data loader reads an opt-in panel only once it nears the viewport.
  await panel.scrollIntoViewIfNeeded();
  await expect(panel.locator('.wl-empty')).toHaveText('No readings yet');
  await expect(panel.locator('.wl-footer')).toContainText('Level only, not volume.');
});

test('Water Levels markers follow the layer toggle and open a popup in each renderer', async ({ page }) => {
  test.setTimeout(150_000);
  await page.route('**/api/**', (route) => route.fulfill({ json: {} }));
  await page.goto('/tests/map-harness.html');
  const results = await page.evaluate(async (fixture) => {
    const { toDisplayReservoirLevel } = await import(/* @vite-ignore */ '/src/services/climate/reservoir-levels.ts');
    const reservoirs = fixture.reservoirs.map(toDisplayReservoirLevel);
    const mead = reservoirs.find((r: { id: string }) => r.id === 'mead');
    const modulePaths = ['/src/components/DeckGLMap.ts', '/src/components/Map.ts', '/src/components/GlobeMap.ts'];
    const result = [];
    for (const path of modulePaths) {
      const exports = await import(/* @vite-ignore */ path);
      const Constructor = exports.DeckGLMap ?? exports.MapComponent ?? exports.GlobeMap;
      const container = document.createElement('div');
      container.style.cssText = 'position:fixed;inset:0;width:1000px;height:700px;z-index:9999';
      document.body.append(container);
      const map = new Constructor(container, { view: 'global', layers: { reservoirLevels: true }, timeRange: 'all', zoom: 2, pan: { x: 0, y: 0 } });
      if (map.whenReady) await map.whenReady();
      map.setReservoirLevels(reservoirs);
      const count = () => exports.DeckGLMap
        ? map.buildLayers().find((layer: { id: string }) => layer.id === 'reservoir-levels-layer')?.props.data.length ?? 0
        : exports.GlobeMap ? map.globe.htmlElementsData().filter((item: { _kind: string }) => item._kind === 'reservoirLevel').length
          : container.querySelectorAll('.wl-marker').length;
      const waitFor = async (check: () => boolean, ms = 5000) => {
        const deadline = performance.now() + ms;
        while (!check() && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      };
      await waitFor(() => count() > 0);
      const enabled = count();
      map.setLayers({ reservoirLevels: false });
      await waitFor(() => count() === 0);
      const disabled = count();
      map.setLayers({ reservoirLevels: true });
      await waitFor(() => count() > 0);
      const reenabled = count();
      map.openReservoir(mead);
      // MapPopup mounts on document.body to escape the map's overflow clipping.
      // The globe opens the popup from a timer after its camera rotation settles. Under
      // software WebGL in CI that timer has been measured firing 15 s late, so wait longer.
      await waitFor(() => Boolean(document.querySelector('.map-popup .wl-popup .popup-title')), 40000);
      const popupTitle = document.querySelector('.map-popup .wl-popup .popup-title')?.textContent ?? '';
      document.querySelectorAll('.map-popup').forEach((el) => el.remove());
      result.push({ path, enabled, disabled, reenabled, popupTitle });
      map.destroy();
      container.remove();
    }
    return { total: reservoirs.length, result };
  }, FIXTURE);
  for (const r of results.result) {
    // The SVG renderer cuts overlays outside the projected viewport, so it may draw fewer than all.
    expect(r.enabled, r.path).toBeGreaterThan(r.path.endsWith('/Map.ts') ? 0 : results.total - 1);
    expect(r, r.path).toMatchObject({ disabled: 0, reenabled: r.enabled });
    expect(r.popupTitle, r.path).toContain('Lake Mead');
  }
});
