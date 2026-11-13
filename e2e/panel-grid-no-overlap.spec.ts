import { expect, test } from '@playwright/test';

// The #5332 CLS pins give these panels a fixed height (380px, or 764px for the
// two-row defaults). The grid's implicit rows resolve to 200px, so a pin must
// also reserve enough rows or the next panel paints over its lower half.
const PINNED_PANELS = [
  'threat-timeline',
  'strategic-posture',
  'gdelt-intel',
  'energy-complex',
  'global-procurement',
  'intel',
  'cascade',
  'politics',
];

const VIEWPORTS = [
  { width: 1920, height: 1200 },
  { width: 1600, height: 866 },
  { width: 1280, height: 800 },
];

test('pinned dashboard panels do not overlap their grid neighbours', async ({ page }) => {
  test.setTimeout(180_000);

  await page.addInitScript((panels: string[]) => {
    if (sessionStorage.getItem('__panel_overlap_e2e_init__')) return;
    localStorage.setItem('worldmonitor-variant', 'full');
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
    const settings = JSON.parse(localStorage.getItem('worldmonitor-panels') || '{}');
    for (const id of panels) settings[id] = { name: id, enabled: true, priority: 1 };
    localStorage.setItem('worldmonitor-panels', JSON.stringify(settings));
    sessionStorage.setItem('__panel_overlap_e2e_init__', '1');
  }, PINNED_PANELS);

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

    // Mount every pinned panel, so the check measures real panels and not the
    // deferred shells that stand in for them below the fold.
    // The shell is replaced by a new element when the panel mounts, so each
    // poll re-queries the element instead of holding a handle that detaches.
    for (const id of PINNED_PANELS) {
      await expect
        .poll(
          () => page.evaluate((panelId: string) => {
            const panel = document.querySelector<HTMLElement>(`#panelsGrid > .panel[data-panel="${panelId}"]`);
            if (!panel) return 'missing';
            panel.scrollIntoView({ block: 'center' });
            return panel.dataset.deferredPanel === 'true' ? 'deferred' : 'mounted';
          }, id),
          { message: `${id} did not mount`, timeout: 60_000 },
        )
        .toBe('mounted');
    }

    // The resize separator reports the rows on screen, not the span-2 class.
    await expect(
      page.locator('#panelsGrid > .panel[data-panel="threat-timeline"] .panel-resize-handle'),
    ).toHaveAttribute('aria-valuenow', '4');

    await expect
      .poll(
        () => page.evaluate(() => {
          const panels = Array.from(
            document.querySelectorAll<HTMLElement>('#panelsGrid > .panel[data-panel]'),
          ).filter(panel => getComputedStyle(panel).display !== 'none');
          const rects = panels.map(panel => ({
            id: panel.dataset.panel ?? '?',
            rect: panel.getBoundingClientRect(),
          }));
          const overlaps: string[] = [];
          for (let i = 0; i < rects.length; i++) {
            for (let j = i + 1; j < rects.length; j++) {
              const a = rects[i]!.rect;
              const b = rects[j]!.rect;
              const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
              const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
              if (x > 2 && y > 2) overlaps.push(`${rects[i]!.id} x ${rects[j]!.id} (${Math.round(y)}px)`);
            }
          }
          return overlaps;
        }),
        {
          message: `Overlapping dashboard panels at ${viewport.width}x${viewport.height}`,
          timeout: 20_000,
        },
      )
      .toEqual([]);
  }
});
