import { expect, test } from '@playwright/test';
import { seedAnonymousDashboard } from './bootstrap-request-budget-fixtures';

test('German displacement fits individual narrow panels and keeps tab scrolling independent', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await seedAnonymousDashboard(page, 'full', { localStorage: {
    'worldmonitor-panels': JSON.stringify({ displacement: { name: 'Displacement', enabled: true, priority: 0 } }),
    'wm-followed-countries-v1': JSON.stringify({ countries: ['SD'] }),
  } });
  await page.route(/^https?:\/\/(?!(127\.0\.0\.1:\d+|localhost:\d+)(?:\/|$)).*/i, route => route.abort());
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.route('**/api/bootstrap*', route => route.fulfill({ json: { missing: [], data: {} } }));
  await page.route(/get-displacement-summary/, route => route.fulfill({ json: {
    dataAvailable: true, fetchedAt: Date.now(), summary: {
      year: 2025, globalTotals: { refugees: 28500000, asylumSeekers: 9000000, idps: 64200000, stateless: 0, total: 101700000 },
      countries: Array.from({ length: 212 }, (_, i) => ({
        code: i === 0 ? 'SDN' : `fixture-${i}`, name: i === 0 ? 'Sudan' : 'Democratic Republic of the Congo',
        refugees: 1000000, asylumSeekers: 10000, idps: 2000000, stateless: 0,
        totalDisplaced: 3010000, hostRefugees: 100000, hostAsylumSeekers: 1000, hostTotal: 101000,
        location: { latitude: 15, longitude: 30 },
      })), topFlows: [],
    },
  } }));
  await page.route(/get-internal-displacement/, route => route.fulfill({ json: { dataAvailable: true, operations: [{ countryCode: 'SDN', countryName: 'Sudan', operation: 'Test overview', reportingDate: '2026-11-01', totalIdps: 2000000, regions: [], flows: [], reasons: [] }], fetchedAt: Date.now() } }));
  await page.route(/get-cross-border-movements/, route => route.fulfill({ json: { dataAvailable: true, movements: [{ id: 'test-border', name: 'Sudan border movement', countryCode: 'SD', originCode: 'SD', count: 12345, kind: 'outflow', measure: 'stock', asOf: '2026-11-01', source: 'Fixture', sourceUrl: 'https://example.com' }], sources: [] } }));

  await page.goto('/dashboard?lang=de');
  const panel = page.locator('#panelsGrid .panel[data-panel="displacement"]');
  await expect.poll(async () => {
    await panel.scrollIntoViewIfNeeded().catch(() => {});
    return panel.locator('.disp-row').count();
  }).toBeGreaterThan(0);
  await expect(panel.locator('.disp-stat-label').first()).toHaveText('Flüchtlinge');
  const content = panel.locator('.panel-content');
  const grid = panel.locator('.disp-stats-grid');
  const tabs = panel.locator('.panel-tabs');
  await expect(panel.locator('[data-tab="crossBorder"]')).toBeAttached();
  await expect(panel.locator('[data-tab="internal"]')).toBeAttached();
  await panel.locator('[data-tab="origins"]').click();
  await expect(panel.locator('.disp-row')).toHaveCount(30);

  // Resize the individual panel while keeping a desktop viewport. This also
  // exercises the existing panel-body container, rather than a phone breakpoint.
  for (const [width, scale] of [[375, 1], [300, 1], [400, 1], [700, 1], [300, 1.25], [700, 1.25], [375, 1]] as const) {
    await panel.evaluate((el, { width, scale }) => {
      el.style.width = `${width}px`;
      el.style.maxWidth = 'none';
      el.style.gridColumn = '1 / -1';
      el.style.setProperty('--wm-panel-font-scale', `${scale}`);
    }, { width, scale });
    const geometry = await panel.evaluate(el => {
      const selectors = ['.panel-content', '.disp-panel-content', '.disp-stats-grid', '.disp-table', '.panel-tabs'];
      return Object.fromEntries(selectors.map(selector => {
        const node = el.querySelector<HTMLElement>(selector)!;
        return [selector, { width: node.clientWidth, scrollWidth: node.scrollWidth }];
      }));
    });
    await testInfo.attach(`geometry-${width}-${scale}`, { body: JSON.stringify(geometry), contentType: 'application/json' });
    await panel.screenshot({ path: testInfo.outputPath(`displacement-${width}-${scale}.png`) });
    expect.soft(geometry['.panel-content']!.scrollWidth - geometry['.panel-content']!.width, `${width}px: outer scroll`).toBeLessThanOrEqual(1);
    await expect.soft(grid).toHaveCSS('grid-template-columns', width <= 480 ? /^\S+ \S+$/ : /^\S+ \S+ \S+ \S+$/, { timeout: 2000 });
    expect.soft(await grid.locator('.disp-stat-label').evaluateAll(labels => labels.every(el => el.scrollWidth <= el.clientWidth + 1)), `${width}px: metric labels fit`).toBe(true);
    const count = panel.locator('.panel-header > .panel-count');
    await expect(count).toHaveText('212');
    expect.soft(await count.evaluate(el => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const text = range.getBoundingClientRect();
      const badge = el.getBoundingClientRect();
      return text.width > 0 && text.left >= badge.left && text.right <= badge.right && getComputedStyle(el).clipPath === 'none';
    }), `${width}px: count is legible`).toBe(true);
    expect.soft(await panel.locator('.panel-header').evaluate(header => {
      const children = [...header.children].map(el => el.getBoundingClientRect()).filter(r => r.width > 0);
      const bounds = header.getBoundingClientRect();
      return children.every((r, i) => r.left >= bounds.left && r.right <= bounds.right
        && children.slice(i + 1).every(other => Math.min(r.right, other.right) <= Math.max(r.left, other.left) + 1));
    }), `${width}px: header controls fit without overlap`).toBe(true);
  }

  const tableLeft = await panel.locator('.disp-table').evaluate(el => el.getBoundingClientRect().left);
  await tabs.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  expect(await tabs.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
  expect(await content.evaluate(el => el.scrollLeft)).toBe(0);
  expect(await panel.locator('.disp-table').evaluate(el => el.getBoundingClientRect().left)).toBe(tableLeft);
  await panel.locator('[data-tab="internal"]').click();
  await expect(panel.locator('[data-tab="internal"]')).toHaveAttribute('aria-selected', 'true');
  await panel.locator('[data-tab="hosts"]').click();
  await expect(panel.locator('.disp-row')).toHaveCount(30);
  const followed = panel.locator('.wm-followed-only-chip');
  await expect(followed).toHaveAccessibleName(/Show only your followed countries/);
  await followed.focus();
  await page.keyboard.press('Enter');
  await expect(panel.locator('.disp-row')).toHaveCount(1);
  await followed.click();
  await expect(panel.locator('.disp-row')).toHaveCount(30);
  await content.evaluate(el => { el.scrollTop = el.scrollHeight; });
  expect(await content.evaluate(el => el.scrollTop)).toBeGreaterThan(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await panel.evaluate(el => { el.style.width = ''; });
  await expect(grid).toHaveCSS('grid-template-columns', /^\S+ \S+$/);
  expect(await content.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await content.evaluate(el => { el.scrollTop = 0; });
  await panel.screenshot({ path: testInfo.outputPath('displacement-phone.png') });
  await page.reload();
  await expect.poll(async () => {
    await panel.scrollIntoViewIfNeeded().catch(() => {});
    return panel.locator('.disp-stat-box').count();
  }).toBe(4);
  await expect(grid).toHaveCSS('grid-template-columns', /^\S+ \S+$/);
  expect(await content.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
});
