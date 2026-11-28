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

/** Wait out the wrapper's zoom glide and the markers' own transitions, so one sample is one settled frame. */
const settled = (page: Page) => page.evaluate(async () => {
  const wrapper = document.querySelector('.map-wrapper')!;
  // Finite ones only: pulsing markers elsewhere in the layer never finish.
  const finite = () => wrapper.getAnimations({ subtree: true })
    .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity);
  for (let running = finite(); running.length; running = finite()) {
    await Promise.allSettled(running.map((animation) => animation.finished));
  }
});

async function sample(page: Page) {
  await settled(page);
  const boxes = await visibleText(page);
  const overlaps: string[] = [];
  boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => {
    const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (x > 0.5 && y > 0.5) overlaps.push(`${a.text} / ${b.text}`);
  }));
  // Map.ts sizes each title box at 4.8px per character; the rendered title must match.
  const misSized = boxes.filter((b) => b.title && Math.abs(b.width - [...b.text].length * 4.8) > 1).map((b) => `${b.text} ${b.width.toFixed(1)}px`);
  const hiddenIcons = await page.locator('#mapOverlays .nat-event-icon').evaluateAll((els) =>
    els.filter((el) => !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })).length);
  return { overlaps, misSized, hiddenIcons, titles: boxes.filter((b) => b.title).map((b) => b.text).sort() };
}

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

for (const font of ['mono', 'system'] as const) {
  test(`natural event labels never print on top of each other, at any zoom (${font} font)`, async ({ page }) => {
    await page.goto('/tests/mobile-map-integration-harness.html?mobile=1');
    await page.waitForFunction(() => (window as unknown as { __mobileMapIntegrationHarness: Harness }).__mobileMapIntegrationHarness?.ready);
    // The settings font choice; labels must keep the font their boxes were sized for.
    // The system run also raises the text-size setting, which must not reach map labels.
    if (font === 'system') await page.evaluate(() => {
      document.documentElement.dataset.font = 'system';
      document.documentElement.style.setProperty('--wm-font-scale', '1.5');
    });
    const harness = (fn: string, ...args: unknown[]) => page.evaluate(({ fn, args }) => {
      const h = (window as unknown as { __mobileMapIntegrationHarness: Record<string, (...a: unknown[]) => void> }).__mobileMapIntegrationHarness;
      h[fn]!(...args);
    }, { fn, args });

    // Built just below the title zoom: titles must appear when zoom crosses it,
    // even though 1.99999 and 2 round to the same CSS zoom key.
    await harness('setOverlayViewport', -57, -42);
    await harness('setOverlayZoom', 1.99999);
    await harness('setNaturalEvents', ICEBERGS);
    await expect(page.locator('#mapOverlays .nat-event-marker')).toHaveCount(6);
    await expect.poll(async () => (await sample(page)).titles).toEqual([]);

    const visits: Array<{ zoom: number; titles: string[] }> = [];
    // 2 crosses the title zoom; 2.7 is the phone start; back to 2 pulls them
    // together; 8 pulls them apart.
    for (const zoom of [2, 2.7, 2, 8]) {
      await harness('setOverlayZoom', zoom);
      // One settled frame: no overlaps, titles at their sized width, the largest
      // iceberg's name shown and every icon visible.
      let titles: string[] = [];
      await expect.poll(async () => {
        const frame = await sample(page);
        titles = frame.titles;
        return { overlaps: frame.overlaps, misSized: frame.misSized, hiddenIcons: frame.hiddenIcons, hasLargest: frame.titles.includes('Iceberg A81') };
      }, { message: `zoom ${zoom}` }).toEqual({ overlaps: [], misSized: [], hiddenIcons: 0, hasLargest: true });
      visits.push({ zoom, titles });
      await expect(page.locator('#mapOverlays .nat-event-icon')).toHaveCount(6);
    }
    const [first2, at27, second2, at8] = visits.map((visit) => visit.titles);
    // Zooming back out restores the same selection as the first visit to 2.
    expect(second2).toEqual(first2);
    // Names hidden in a crowd come back once zooming in separates the icebergs.
    expect(at8!.length).toBeGreaterThan(at27!.length);

    // Only icons take taps: label text and the marker column never do, and a
    // zoom-hidden layer takes no taps at all.
    const taps = await page.evaluate(() => {
      const at = (x: number, y: number) => document.elementFromPoint(x, y);
      const centre = (el: Element) => { const b = el.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2] as const; };
      // Magnitude rows sit below the icon's 44px touch area, so they also probe
      // the bare column. An icon's touch area may reach under a title.
      const text = [...document.querySelectorAll('#mapOverlays .nat-event-texted :is(.nat-event-label, .nat-event-magnitude)')]
        .filter((el) => el.getBoundingClientRect().width > 0)
        .filter((el) => { const hit = at(...centre(el)); return !!hit?.closest('.nat-event-marker') && !hit.closest('.nat-event-icon'); }).length;
      // A point beside each icon, outside its box but inside its 44px touch area.
      const probes = [...document.querySelectorAll<HTMLElement>('#mapOverlays .nat-event-icon')].flatMap((icon) => {
        const b = icon.getBoundingClientRect();
        const point = [b.x - 2, b.y + b.height / 2] as const;
        return b.width / 2 + 2 < 22 && at(...point)?.closest('.nat-event-icon') === icon ? [point] : [];
      });
      document.querySelector('.map-wrapper')!.setAttribute('data-layer-hidden-natural', 'true');
      const hidden = probes.filter((point) => at(...point)?.closest('.nat-event-marker')).length;
      return { text, touchAreasShown: probes.length > 0, hidden };
    });
    // Hidden, nothing in a marker may take the tap, the icon's touch area included.
    expect(taps).toEqual({ text: 0, touchAreasShown: true, hidden: 0 });
  });
}
