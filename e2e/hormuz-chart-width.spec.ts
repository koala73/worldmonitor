import { expect, test } from '@playwright/test';

// The Hormuz Trade Tracker drew each bar chart at a fixed 280px. A one-column
// panel's body is narrower than that after padding, so the chart ran past it
// and the body scrolled sideways; a panel widened to two columns kept the
// 280px chart beside an empty right half.

test.use({ viewport: { width: 1600, height: 900 } });

test('Hormuz bar charts fill the panel body at every width', async ({ page }) => {
  await page.goto('/tests/runtime-harness.html');

  const result = await page.evaluate(async () => {
    await import('/src/styles/main.css');
    const { initI18n } = await import('/src/services/i18n.ts');
    await initI18n();
    const { HormuzPanel } = await import('/src/components/HormuzPanel.ts');

    document.getElementById('runtime-harness')?.remove();
    const host = document.createElement('div');
    host.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr);height:420px';
    document.body.appendChild(host);

    const panel = new HormuzPanel();
    const el = panel.getElement();
    host.appendChild(el);
    const series = Array.from({ length: 30 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, value: 40 + (i % 7) * 10 }));
    const internals = panel as unknown as { data: unknown; showingData: boolean; renderPanel(): void; bindTooltip(): void };
    internals.data = {
      fetchedAt: Date.now(), updatedDate: '2026-09-21', title: 'Analysis', summary: null, paragraphs: [], status: 'open',
      charts: [{ label: 'crude', title: 'Crude oil outbound shipments', series }],
      attribution: { source: 'WTO', url: 'https://datalab.wto.org/' },
    };
    internals.showingData = true;
    internals.bindTooltip(); // fetchData() binds it after the first render

    const measure = async (width: number) => {
      host.style.width = `${width}px`;
      internals.renderPanel();
      // setSafeContent debounces panel content by 150ms.
      await new Promise((r) => setTimeout(r, 350));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const content = el.querySelector<HTMLElement>('.panel-content')!;
      const svg = el.querySelector('.hz-svg')!;
      const body = content.getBoundingClientRect();
      const chart = svg.getBoundingClientRect();
      const style = getComputedStyle(content);
      // The chart row also holds the title line; the chart should span it.
      const row = el.querySelector('.hz-chart')!.getBoundingClientRect();
      const bars = [...el.querySelectorAll('.hbar')].map((b) => b.getBoundingClientRect());
      return {
        overflowX: content.scrollWidth - content.clientWidth,
        chartWidth: Math.round(chart.width),
        rowWidth: Math.round(row.width),
        chartRightPastBody: Math.round(chart.right - (body.right - parseFloat(style.paddingRight))),
        barsOutsideChart: bars.filter((bar) => bar.left < chart.left - 0.5 || bar.right > chart.right + 0.5).length,
      };
    };

    return { narrow: await measure(280), wide: await measure(754) };
  });

  for (const [name, m] of Object.entries(result)) {
    expect(m.overflowX, `${name}: body must not scroll sideways`).toBeLessThanOrEqual(0);
    expect(m.chartRightPastBody, `${name}: chart stays inside the body`).toBeLessThanOrEqual(0);
    expect(Math.abs(m.chartWidth - m.rowWidth), `${name}: chart spans its row`).toBeLessThanOrEqual(2);
    expect(m.barsOutsideChart, `${name}: every hover target stays inside the chart`).toBe(0);
  }

  // A sidebar panel sits right of the map. The tooltip must still appear over
  // the hovered bar, including the rightmost one.
  const bar = await page.evaluate(async () => {
    const host = document.body.lastElementChild as HTMLElement;
    host.style.marginLeft = '700px';
    host.style.width = '754px';
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const bars = document.querySelectorAll('.hbar');
    const r = bars[bars.length - 1]!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(bar.x - 1, bar.y);
  await page.mouse.move(bar.x, bar.y);
  await page.waitForTimeout(200); // the tooltip fades in over 80ms
  const tip = await page.evaluate(() => {
    const t = document.querySelector<HTMLElement>('.hz-tip')!;
    const r = t.getBoundingClientRect();
    const panel = t.closest('.panel')!.getBoundingClientRect();
    return { center: r.left + r.width / 2, bottom: r.bottom, right: r.right, panelRight: panel.right, opacity: getComputedStyle(t).opacity, text: t.textContent };
  });
  expect(tip.opacity).toBe('1');
  expect(tip.text).toContain('10-30');
  expect(Math.abs(tip.center - bar.x), 'tooltip is centred on the hovered bar').toBeLessThanOrEqual(4);
  expect(tip.bottom, 'tooltip sits above the bar').toBeLessThanOrEqual(bar.y);
  expect(tip.right, 'tooltip stays inside the panel').toBeLessThanOrEqual(tip.panelRight);

  // Scrolled so a chart sits at the top of the panel body, there is no room
  // above the bar: the body clips anything above it, so the tooltip flips below.
  const topBar = await page.evaluate(async () => {
    const host = document.body.lastElementChild as HTMLElement;
    host.style.height = '200px';
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const content = document.querySelector<HTMLElement>('.panel-content')!;
    const svg = document.querySelector('.hz-svg')!;
    content.scrollTop += svg.getBoundingClientRect().top - content.getBoundingClientRect().top - 2;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const r = svg.querySelectorAll('.hbar')[5]!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 10, scrolled: content.scrollTop };
  });
  expect(topBar.scrolled, 'the body scrolled the chart to its top edge').toBeGreaterThan(0);
  await page.mouse.move(topBar.x - 1, topBar.y);
  await page.mouse.move(topBar.x, topBar.y);
  await page.waitForTimeout(200);
  const clipped = await page.evaluate(() => {
    const t = document.querySelector<HTMLElement>('.hz-tip')!.getBoundingClientRect();
    const body = document.querySelector('.panel-content')!.getBoundingClientRect();
    return { top: t.top, bottom: t.bottom, bodyTop: body.top, bodyBottom: body.bottom };
  });
  expect(clipped.top, 'tooltip stays below the top of the scrolled body').toBeGreaterThanOrEqual(clipped.bodyTop);
  expect(clipped.bottom, 'tooltip stays above the bottom of the body').toBeLessThanOrEqual(clipped.bodyBottom);
});

// In the sidebar the grid scrolls, not just the panel body. With the panel
// scrolled partly above the grid, the body's top is out of sight, so room
// above the bar inside the body can still be clipped by the grid.
test('the Hormuz tooltip stays inside a scrolled sidebar grid', async ({ page }) => {
  await page.goto('/tests/runtime-harness.html');

  const bar = await page.evaluate(async () => {
    await import('/src/styles/main.css');
    const { initI18n } = await import('/src/services/i18n.ts');
    await initI18n();
    const { HormuzPanel } = await import('/src/components/HormuzPanel.ts');

    document.getElementById('runtime-harness')?.remove();
    const grid = document.createElement('div');
    grid.style.cssText = 'position:absolute;top:120px;left:700px;width:560px;height:360px;overflow:auto;display:grid;grid-template-columns:minmax(0,1fr)';
    const spacer = document.createElement('div');
    spacer.style.height = '300px';
    const host = document.createElement('div');
    host.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr);height:900px';
    grid.append(spacer, host);
    document.body.appendChild(grid);

    const panel = new HormuzPanel();
    host.appendChild(panel.getElement());
    const series = Array.from({ length: 30 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, value: 40 + (i % 7) * 10 }));
    const internals = panel as unknown as { data: unknown; showingData: boolean; renderPanel(): void; bindTooltip(): void };
    internals.data = {
      fetchedAt: Date.now(), updatedDate: '2026-09-21', title: 'Analysis', summary: null, paragraphs: [], status: 'open',
      charts: [{ label: 'crude', title: 'Crude oil outbound shipments', series }],
      attribution: { source: 'WTO', url: 'https://datalab.wto.org/' },
    };
    internals.showingData = true;
    internals.bindTooltip();
    internals.renderPanel();
    await new Promise((r) => setTimeout(r, 350));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    // Scroll the grid until the chart's top edge sits just below the grid's top.
    const svg = panel.getElement().querySelector('.hz-svg')!;
    grid.scrollTop += svg.getBoundingClientRect().top - grid.getBoundingClientRect().top - 2;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const content = panel.getElement().querySelector('.panel-content')!.getBoundingClientRect();
    const gridBox = grid.getBoundingClientRect();
    const r = svg.querySelectorAll('.hbar')[5]!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: Math.max(r.top, gridBox.top) + 10, gridTop: gridBox.top, bodyTop: content.top };
  });
  expect(bar.bodyTop, 'the panel body starts above the visible grid').toBeLessThan(bar.gridTop - 40);

  await page.mouse.move(bar.x - 1, bar.y);
  await page.mouse.move(bar.x, bar.y);
  await page.waitForTimeout(200);
  const tip = await page.evaluate(() => {
    const t = document.querySelector<HTMLElement>('.hz-tip')!;
    return { top: t.getBoundingClientRect().top, opacity: getComputedStyle(t).opacity };
  });
  expect(tip.opacity).toBe('1');
  expect(tip.top, 'tooltip stays below the top of the scrolled grid').toBeGreaterThanOrEqual(bar.gridTop);
});
