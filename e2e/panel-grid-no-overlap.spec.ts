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

// A Pro-locked panel shows only a lock card (about 150px). Keeping its
// two-row or four-row slot left a block of empty space above the panels below
// it, so a signed-out visitor saw Supply Chain start mid-column.
const LOCKED_PANELS = ['global-procurement', 'trade-policy'];

test('Pro-locked panels shrink to one grid row', async ({ page }) => {
  test.setTimeout(120_000);

  await page.addInitScript((panels: string[]) => {
    if (sessionStorage.getItem('__locked_footprint_e2e_init__')) return;
    localStorage.setItem('worldmonitor-variant', 'full');
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
    const settings = JSON.parse(localStorage.getItem('worldmonitor-panels') || '{}');
    for (const id of panels) settings[id] = { name: id, enabled: true, priority: 1 };
    localStorage.setItem('worldmonitor-panels', JSON.stringify(settings));
    sessionStorage.setItem('__locked_footprint_e2e_init__', '1');
  }, LOCKED_PANELS);
  // A shell can be replaced by its panel before the poll below sees it.
  // Measure each shell while it is attached: when it is inserted and each
  // time its class changes (the gating pass adds the lock class). A replaced
  // shell is then judged on its last measurement, with the same bounds as a
  // live one.
  await page.addInitScript(() => {
    type Shell = { height: number; rowMin: number; removed: boolean };
    const shells: Record<string, Shell> = {};
    (window as unknown as { __lockedShells: Record<string, Shell> }).__lockedShells = shells;
    const measure = (el: Element) => {
      if (!(el instanceof HTMLElement) || !el.classList.contains('panel-deferred-shell') || !el.isConnected) return;
      const id = el.dataset.panel;
      if (!id) return;
      const rowMin = parseFloat(getComputedStyle(el).getPropertyValue('--dashboard-panel-row-min')) || 200;
      shells[id] = { height: el.getBoundingClientRect().height, rowMin, removed: false };
    };
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') measure(record.target as Element);
        for (const node of record.addedNodes) measure(node as Element);
        for (const node of record.removedNodes) {
          if (!(node instanceof HTMLElement) || !node.classList.contains('panel-deferred-shell')) continue;
          const entry = node.dataset.panel ? shells[node.dataset.panel] : undefined;
          if (entry) entry.removed = true;
        }
      }
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

  // Once gating has run, a locked panel's deferred shell must already have the
  // one-row footprint, so mounting the locked panel into it moves nothing.
  await expect
    .poll(
      () => page.evaluate((panels: string[]) => {
        // Every panel needs a shell measurement: live, or the last one taken
        // before its shell was replaced. A panel never seen as a shell fails.
        const recorded = (window as unknown as { __lockedShells: Record<string, { height: number; rowMin: number; removed: boolean }> }).__lockedShells;
        const judge = (id: string, height: number, rowMin: number) =>
          height > 0 && height <= rowMin + 1 ? 'one row' : `${id} shell ${Math.round(height)}px`;
        const shells = panels.map((id) => {
          const shell = document.querySelector<HTMLElement>(`#panelsGrid > .panel-deferred-shell[data-panel="${id}"]`);
          if (shell) {
            const rowMin = parseFloat(getComputedStyle(shell).getPropertyValue('--dashboard-panel-row-min')) || 200;
            return judge(id, shell.getBoundingClientRect().height, rowMin);
          }
          const last = recorded[id];
          if (!last?.removed) return `${id} has no deferred shell`;
          return judge(id, last.height, last.rowMin);
        });
        return shells.find((s) => s !== 'one row') ?? 'one row';
      }, LOCKED_PANELS),
      { message: 'locked panel shells reserve one row', timeout: 30_000 },
    )
    .toBe('one row');

  for (const id of LOCKED_PANELS) {
    await expect
      .poll(
        () => page.evaluate((panelId: string) => {
          const panel = document.querySelector<HTMLElement>(`#panelsGrid > .panel[data-panel="${panelId}"]`);
          if (!panel) return 'missing';
          panel.scrollIntoView({ block: 'center' });
          if (panel.dataset.deferredPanel === 'true') return 'deferred';
          if (!panel.classList.contains('panel-is-locked')) return 'unlocked';
          const card = panel.querySelector<HTMLElement>('.panel-locked-state');
          if (!card) return 'no lock card';
          const slot = panel.getBoundingClientRect();
          const cardBox = card.getBoundingClientRect();
          // A hidden panel measures 0x0 and would pass the size checks below.
          if (!slot.width || !slot.height || !cardBox.width || !cardBox.height) return 'not rendered';
          const rowMin = parseFloat(getComputedStyle(panel).getPropertyValue('--dashboard-panel-row-min')) || 200;
          const cardBottom = card.getBoundingClientRect().bottom;
          if (cardBottom > slot.bottom + 1) return `lock card clipped (${Math.round(cardBottom - slot.bottom)}px)`;
          return slot.height <= rowMin + 1 ? 'one row' : `slot ${Math.round(slot.height)}px`;
        }, id),
        { message: `${id} locked footprint`, timeout: 60_000 },
      )
      .toBe('one row');
  }
});
