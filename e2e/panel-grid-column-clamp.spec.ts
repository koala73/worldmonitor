import { expect, test } from '@playwright/test';

// The sidebar grid is repeat(auto-fill, minmax(270px, 1fr)). When it is too
// narrow for the span a wide or resized panel asks for, CSS adds implicit
// columns instead of clamping the span. At 1366px the sidebar (532px) fits one
// column, and Live News and Live Webcams (span 2) added a second implicit one,
// so every other panel was squeezed into 280px or 248px and several bodies
// scrolled sideways. At 1440px (562px) two 270px columns fit, by design.
// Chrome lists implicit tracks in the computed template, so the resize handle
// counted them as real columns and offered spans the grid could not hold.

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
    const twoAt1440 = await snap(562);
    const threeColumns = await snap(860);
    panels[1]!.getElement().classList.add('col-span-3');
    const twoColumns = await snap(600);
    return { oneColumn, twoAt1440, threeColumns, twoColumns };
  });

  // One column fits at 1366: every panel fills the grid, none is squeezed.
  expect(result.oneColumn.tracks, 'no implicit column beside the only real one').toBe(1);
  expect(result.oneColumn.widths).toEqual([532, 532, 532, 532]);
  expect(result.oneColumn.colMax.slice(1), 'a one-column grid offers no wider span').toEqual(['1', '1', '1']);

  // The 1440 sidebar holds two equal columns, and the wide panel spans both.
  expect(result.twoAt1440.tracks).toBe(2);
  expect(result.twoAt1440.widths).toEqual([562, 279, 279, 279]);
  expect(result.twoAt1440.colMax.slice(1)).toEqual(['2', '2', '2']);

  // Room for three columns: the wide panel spans two again.
  expect(result.threeColumns.tracks).toBe(3);
  expect(result.threeColumns.widths[0]).toBeGreaterThan(result.threeColumns.widths[1]! * 1.9);

  // Two columns: a saved three-column span stops at two instead of adding a third.
  expect(result.twoColumns.tracks, 'a span-3 panel must not add a third column').toBe(2);
  expect(result.twoColumns.widths[1]).toBe(600);
});

test('a drag that does not change the span keeps the saved wider span', async ({ page }) => {
  await page.goto('/tests/runtime-harness.html');

  const result = await page.evaluate(async () => {
    await import('/src/styles/main.css');
    const { initI18n } = await import('/src/services/i18n.ts');
    await initI18n();
    localStorage.setItem('worldmonitor-panel-col-spans', JSON.stringify({ 'probe-saved': 3 }));
    const { Panel } = await import('/src/components/Panel.ts');

    document.getElementById('runtime-harness')?.remove();
    const grid = document.createElement('div');
    grid.className = 'panels-grid';
    grid.style.width = '532px';
    grid.style.boxSizing = 'content-box';
    document.body.appendChild(grid);
    const panel = new Panel({ id: 'probe-saved', title: 'Saved' });
    grid.appendChild(panel.getElement());
    for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r));

    const el = panel.getElement();
    const handle = el.querySelector<HTMLElement>('.panel-col-resize-handle')!;
    const box = handle.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x + 6, clientY: y }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x + 6, clientY: y }));
    const afterDrag = el.classList.contains('col-span-3');

    grid.style.width = '860px';
    for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r));
    return {
      afterDrag,
      widened: Math.round(el.getBoundingClientRect().width),
      saved: localStorage.getItem('worldmonitor-panel-col-spans'),
    };
  });

  expect(result.afterDrag, 'a sub-step drag must not overwrite the requested span').toBe(true);
  expect(result.widened, 'the panel spans three columns once the grid has room').toBe(860);
  expect(JSON.parse(result.saved ?? '{}')['probe-saved']).toBe(3);
});

for (const width of [820, 940, 1180, 1439]) {
  test(`the stacked plugin grid stays scrollable and single-column at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 660 });
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      await import('/src/styles/base-layer.css');
      await import('/src/styles/plugin.css');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const { Panel } = await import('/src/components/Panel.ts');

      document.getElementById('runtime-harness')?.remove();
      document.body.classList.add('plugin-body');
      const root = document.createElement('div');
      root.id = 'pluginRoot';
      root.className = 'main-content';
      const map = document.createElement('section');
      map.id = 'mapSection';
      map.className = 'map-section';
      const mapContainer = document.createElement('div');
      mapContainer.id = 'mapContainer';
      map.appendChild(mapContainer);
      root.appendChild(map);
      const grid = document.createElement('div');
      grid.className = 'panels-grid';
      grid.id = 'panelsGrid';
      root.appendChild(grid);
      document.body.appendChild(root);
      const panels = [new Panel({ id: 'plugin-a', title: 'A' }), new Panel({ id: 'plugin-b', title: 'B' })];
      for (const p of panels) grid.appendChild(p.getElement());
      for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r));

      const handle = panels[0]!.getElement().querySelector<HTMLElement>('.panel-col-resize-handle')!;
      const colMax = handle.getAttribute('aria-valuemax');
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r));
      return {
        gridWidth: Math.round(grid.getBoundingClientRect().width),
        colMax,
        tracks: getComputedStyle(grid).gridTemplateColumns.split(/\s+/).length,
        spanClass: panels[0]!.getElement().className.match(/col-span-\d/)?.[0] ?? null,
        overflow: getComputedStyle(root).overflow,
        rootHeight: root.clientHeight,
        contentHeight: root.scrollHeight,
      };
    });

    expect(result.gridWidth, 'wide enough that the 270px formula would claim two columns').toBeGreaterThan(560);
    expect(result.colMax).toBe('1');
    expect(result.spanClass).toBeNull();
    expect(result.tracks).toBe(1);
    expect(result.overflow).toBe('visible');
    expect(result.rootHeight).toBeGreaterThan(720);
    expect(result.contentHeight).toBeLessThanOrEqual(result.rootHeight + 1);
    await page.locator('[data-panel="plugin-b"]').scrollIntoViewIfNeeded();
    await expect(page.locator('[data-panel="plugin-b"]')).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`plugin-stacked-${width}.png`) });
  });
}
