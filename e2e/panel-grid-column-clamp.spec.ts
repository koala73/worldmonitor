import { expect, test } from '@playwright/test';

// The sidebar grid is repeat(auto-fill, minmax(280px, 1fr)). When it is too
// narrow for the span a wide or resized panel asks for, CSS adds implicit
// columns instead of clamping the span. At 1366px the sidebar fits one
// 280px column, and Live Webcams (span 2) added a second implicit one, so every
// other panel was squeezed into 280px or narrower and its body scrolled
// sideways. Chrome lists implicit tracks in the computed template, so the
// resize handle counted them as real columns and offered spans the grid
// could not hold.

test.use({ viewport: { width: 1600, height: 900 } });

test('panel spans never add columns the sidebar grid has no room for', async ({ page }) => {
  await page.goto('/tests/runtime-harness.html');

  const result = await page.evaluate(async () => {
    await import('/src/styles/main.css');
    const { initI18n } = await import('/src/services/i18n.ts');
    await initI18n();
    const { Panel } = await import('/src/components/Panel.ts');

    document.getElementById('runtime-harness')?.remove();
    const grid = document.createElement('div');
    grid.className = 'panels-grid';
    grid.id = 'panelsGrid';
    document.body.appendChild(grid);

    const frames = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); };
    const panels = [
      new Panel({ id: 'probe-wide', title: 'Wide', className: 'panel-wide' }),
      new Panel({ id: 'probe-a', title: 'A' }),
      new Panel({ id: 'probe-b', title: 'B' }),
      new Panel({ id: 'probe-c', title: 'C' }),
    ];
    for (const p of panels) grid.appendChild(p.getElement());

    const snap = async (contentWidth: number) => {
      grid.style.width = `${contentWidth}px`;
      grid.style.boxSizing = 'content-box';
      await frames();
      return {
        tracks: getComputedStyle(grid).gridTemplateColumns.split(/\s+/).length,
        widths: panels.map((p) => Math.round(p.getElement().getBoundingClientRect().width)),
        colMax: panels.map((p) => p.getElement().querySelector('.panel-col-resize-handle')?.getAttribute('aria-valuemax') ?? null),
      };
    };

    const oneColumn = await snap(532);
    const threeColumns = await snap(860);
    panels[1]!.getElement().classList.add('col-span-3');
    const twoColumns = await snap(600);
    return { oneColumn, threeColumns, twoColumns };
  });

  // One 280px column fits: every panel fills the grid, none is squeezed.
  expect(result.oneColumn.tracks, 'no implicit column beside the only real one').toBe(1);
  expect(result.oneColumn.widths).toEqual([532, 532, 532, 532]);
  expect(result.oneColumn.colMax.slice(1), 'a one-column grid offers no wider span').toEqual(['1', '1', '1']);

  // Room for three columns: the wide panel spans two again.
  expect(result.threeColumns.tracks).toBe(3);
  expect(result.threeColumns.widths[0]).toBeGreaterThan(result.threeColumns.widths[1]! * 1.9);

  // Two columns: a saved three-column span stops at two instead of adding a third.
  expect(result.twoColumns.tracks, 'a span-3 panel must not add a third column').toBe(2);
  expect(result.twoColumns.widths[1]).toBe(600);
});
