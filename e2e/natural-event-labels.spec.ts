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

/** Title and area texts a viewer can see: rendered, not transparent, and inside the map. */
const visibleText = (page: Page) => page.evaluate(() => {
  const map = document.getElementById('mapOverlays')!.closest<HTMLElement>('.map-container, #mapContainer') ?? document.body;
  const view = map.getBoundingClientRect();
  return [...document.querySelectorAll<HTMLElement>('#mapOverlays .nat-event-label, #mapOverlays .nat-event-magnitude')]
    .filter((el) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
    .map((el) => {
      const r = el.getBoundingClientRect();
      const left = Math.max(r.left, view.left), right = Math.min(r.right, view.right);
      const top = Math.max(r.top, view.top), bottom = Math.min(r.bottom, view.bottom);
      return { title: el.classList.contains('nat-event-label'), text: el.textContent ?? '', width: r.width, left, right, top, bottom };
    })
    .filter((b) => b.right > b.left && b.bottom > b.top);
});

async function sample(page: Page) {
  const boxes = await visibleText(page);
  const overlaps: string[] = [];
  boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => {
    const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (x > 0.5 && y > 0.5) overlaps.push(`${a.text} / ${b.text}`);
  }));
  // Map.ts sizes each title box at 4.8px per character; the rendered title must match.
  const misSized = boxes.filter((b) => b.title && Math.abs(b.width - [...b.text].length * 4.8) > 1).map((b) => `${b.text} ${b.width.toFixed(1)}px`);
  return { overlaps, misSized, titles: boxes.filter((b) => b.title).map((b) => b.text).sort() };
}

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

for (const font of ['mono', 'system'] as const) {
  test(`natural event labels never print on top of each other, at any zoom (${font} font)`, async ({ page }) => {
    await page.goto('/tests/mobile-map-integration-harness.html?mobile=1');
    await page.waitForFunction(() => (window as unknown as { __mobileMapIntegrationHarness: Harness }).__mobileMapIntegrationHarness?.ready);
    // The settings font choice; labels must keep the font their boxes were sized for.
    if (font === 'system') await page.evaluate(() => { document.documentElement.dataset.font = 'system'; });
    const harness = (fn: string, ...args: unknown[]) => page.evaluate(({ fn, args }) => {
      const h = (window as unknown as { __mobileMapIntegrationHarness: Record<string, (...a: unknown[]) => void> }).__mobileMapIntegrationHarness;
      h[fn]!(...args);
    }, { fn, args });

    // Built below the title zoom: titles must appear when zoom later crosses it.
    await harness('setOverlayViewport', -57, -42);
    await harness('setOverlayZoom', 1.5);
    await harness('setNaturalEvents', ICEBERGS);
    await expect(page.locator('#mapOverlays .nat-event-marker')).toHaveCount(6);
    await expect.poll(async () => (await sample(page)).titles).toEqual([]);

    const shown: Record<number, number> = {};
    // 2.7 is the phone start; zooming out pulls them together, in pulls them apart.
    for (const zoom of [2.7, 2, 8]) {
      await harness('setOverlayZoom', zoom);
      // Markers animate their scale for 0.2s after a zoom change, so wait for the settled frame.
      await expect.poll(async () => {
        const { overlaps, misSized } = await sample(page);
        return { overlaps, misSized };
      }, { message: `zoom ${zoom}` }).toEqual({ overlaps: [], misSized: [] });
      const { titles } = await sample(page);
      // The largest iceberg keeps its name; every marker keeps its icon.
      expect(titles, `zoom ${zoom}`).toContain('Iceberg A81');
      shown[zoom] = titles.length;
      await expect(page.locator('#mapOverlays .nat-event-icon')).toHaveCount(6);
    }
    // Names hidden in a crowd come back once zooming in separates the icebergs.
    expect(shown[8]).toBeGreaterThan(shown[2.7]!);
  });
}
