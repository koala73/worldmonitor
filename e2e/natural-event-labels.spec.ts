import { expect, test, type Page } from '@playwright/test';
import type { NaturalEvent } from '../src/types';

type Harness = {
  ready: boolean;
  setOverlayZoom: (zoom: number) => void;
  setOverlayViewport: (lat: number, lon: number) => void;
  setNaturalEvents: (events: NaturalEvent[]) => void;
};

// Six open EONET icebergs off South Georgia (2026-11-18), a few degrees apart.
// At phone zoom their titles and areas printed on top of each other.
const iceberg = (id: string, lat: number, lon: number, magnitude: number): NaturalEvent => ({
  id, title: `Iceberg ${id}`, category: 'seaLakeIce', categoryTitle: 'Sea and Lake Ice',
  lat, lon, date: new Date('2026-11-18T00:00:00Z'), magnitude, magnitudeUnit: 'NM^2', closed: false,
});
const ICEBERGS = [
  iceberg('A85', -55.94, -45.95, 30), iceberg('A83', -58.98, -48.45, 84), iceberg('D35', -59.8, -43.29, 90),
  iceberg('D33B', -55.19, -39.34, 252), iceberg('A81', -55.48, -34.36, 700), iceberg('D32', -56.65, -39.35, 54),
];

/** Visible title and area texts that overlap another one on screen. */
const overlappingText = (page: Page) => page.evaluate(() => {
  const boxes = [...document.querySelectorAll<HTMLElement>('#mapOverlays .nat-event-label, #mapOverlays .nat-event-magnitude')]
    .filter((el) => el.checkVisibility())
    .map((el) => ({ text: el.textContent, r: el.getBoundingClientRect() }));
  const pairs: string[] = [];
  boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => {
    const x = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
    const y = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
    if (x > 0.5 && y > 0.5) pairs.push(`${a.text} / ${b.text}`);
  }));
  return pairs;
});
const visibleTitles = (page: Page) => page.locator('#mapOverlays .nat-event-label').evaluateAll((els) =>
  els.filter((el) => el.checkVisibility()).map((el) => el.textContent).sort());

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

test('natural event labels never print on top of each other, at any zoom', async ({ page }) => {
  await page.goto('/tests/mobile-map-integration-harness.html?mobile=1');
  await page.waitForFunction(() => (window as unknown as { __mobileMapIntegrationHarness: Harness }).__mobileMapIntegrationHarness?.ready);
  const harness = (fn: string, ...args: unknown[]) => page.evaluate(({ fn, args }) => {
    const h = (window as unknown as { __mobileMapIntegrationHarness: Record<string, (...a: unknown[]) => void> }).__mobileMapIntegrationHarness;
    h[fn]!(...args);
  }, { fn, args });

  await harness('setOverlayViewport', -57, -42);
  await harness('setNaturalEvents', ICEBERGS);
  await expect(page.locator('#mapOverlays .nat-event-marker')).toHaveCount(6);

  const shown: Record<number, number> = {};
  // 2.7 is the phone start; zooming out pulls them together, in pulls them apart.
  for (const zoom of [2.7, 2, 8]) {
    await harness('setOverlayZoom', zoom);
    await expect.poll(() => overlappingText(page), { message: `zoom ${zoom}` }).toEqual([]);
    // The largest iceberg keeps its name; every marker keeps its icon.
    const titles = await visibleTitles(page);
    expect(titles, `zoom ${zoom}`).toContain('Iceberg A81');
    shown[zoom] = titles.length;
    await expect(page.locator('#mapOverlays .nat-event-icon')).toHaveCount(6);
  }
  // Names hidden in a crowd come back once zooming in separates the icebergs.
  expect(shown[8]).toBeGreaterThan(shown[2.7]!);
});
