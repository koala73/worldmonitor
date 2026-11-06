import { expect, test, type Page } from '@playwright/test';

// Live Webcams stay click-to-play (#10218: they were most of the live-media
// cost). Before play, each tile was a dark-red box with a small outlined
// "Play" pinned to its bottom edge; on a phone the panel is too short and the
// button sat below the visible area, so the panel offered no way to start.
// The play control is now centred, solid and named for its camera.

async function openWebcams(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
  });
  // No real players: this checks the prompt before any play intent.
  await page.route(/^https?:\/\/(?!(127\.0\.0\.1:4173|localhost:4173)(?:\/|$)).*/i, (route) => route.abort('blockedbyclient'));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const panel = page.locator('.panel[data-panel="live-webcams"]');
  // The panel re-renders while the dashboard boots; retry the scroll until it holds.
  await expect(async () => {
    await panel.scrollIntoViewIfNeeded({ timeout: 2000 });
    await expect(panel.locator('.webcam-preview-tile').first()).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30000 });
}

async function promptLayout(page: Page) {
  return page.locator('.panel[data-panel="live-webcams"]').evaluate((panel) => {
    const content = panel.querySelector<HTMLElement>('.panel-content')!.getBoundingClientRect();
    const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
    const luminance = ([r, g, b]: number[]) => {
      const channel = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
    };
    return [...panel.querySelectorAll<HTMLElement>('.webcam-preview-tile')].map((tile) => {
      const button = tile.querySelector<HTMLButtonElement>('.webcam-preview-play')!;
      const box = button.getBoundingClientRect();
      const tileBox = tile.getBoundingClientRect();
      const style = getComputedStyle(button);
      const bg = rgb(style.backgroundColor);
      const [hi, lo] = [luminance(bg), luminance(rgb(style.color))].sort((a, b) => b - a);
      return {
        city: tile.querySelector('.webcam-preview-title')?.textContent ?? '',
        label: button.getAttribute('aria-label') ?? button.textContent ?? '',
        insideTile: box.top >= tileBox.top - 0.5 && box.bottom <= tileBox.bottom + 0.5,
        insidePanel: box.top >= content.top - 0.5 && box.bottom <= content.bottom + 0.5,
        height: box.height,
        opaque: (bg[3] ?? 1) === 1,
        contrast: (hi! + 0.05) / (lo! + 0.05),
        centred: Math.abs((box.left + box.right) / 2 - (tileBox.left + tileBox.right) / 2) <= 2,
      };
    });
  });
}

for (const [name, use] of [
  ['phone', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }],
  ['desktop', { viewport: { width: 1440, height: 900 } }],
] as const) {
  test.describe(`Live Webcams play prompt on ${name}`, () => {
    test.use(use);

    test('every tile shows a centred, readable play control named for its camera', async ({ page }) => {
      await openWebcams(page);
      const tiles = await promptLayout(page);
      expect(tiles.length).toBeGreaterThan(0);
      for (const tile of tiles) {
        expect(tile.label, tile.city).toContain(tile.city);
        expect(tile.insideTile, `${tile.city}: button inside its tile`).toBe(true);
        expect(tile.insidePanel, `${tile.city}: button inside the visible panel`).toBe(true);
        expect(tile.centred, `${tile.city}: button centred`).toBe(true);
        expect(tile.height, `${tile.city}: tap target`).toBeGreaterThanOrEqual(36);
        expect(tile.opaque, `${tile.city}: solid button`).toBe(true);
        expect(tile.contrast, `${tile.city}: label contrast`).toBeGreaterThanOrEqual(4.5);
      }
    });
  });
}
