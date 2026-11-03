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
    const internals = panel as unknown as { data: unknown; showingData: boolean; renderPanel(): void };
    internals.data = {
      fetchedAt: Date.now(), updatedDate: '2026-09-21', title: 'Analysis', summary: null, paragraphs: [], status: 'open',
      charts: [{ label: 'crude', title: 'Crude oil outbound shipments', series }],
      attribution: { source: 'WTO', url: 'https://datalab.wto.org/' },
    };
    internals.showingData = true;

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
      const bar = el.querySelector('.hbar')!.getBoundingClientRect();
      return {
        overflowX: content.scrollWidth - content.clientWidth,
        chartWidth: Math.round(chart.width),
        rowWidth: Math.round(row.width),
        chartRightPastBody: Math.round(chart.right - (body.right - parseFloat(style.paddingRight))),
        barInsideChart: bar.left >= chart.left - 0.5 && bar.right <= chart.right + 0.5,
      };
    };

    return { narrow: await measure(280), wide: await measure(754) };
  });

  for (const [name, m] of Object.entries(result)) {
    expect(m.overflowX, `${name}: body must not scroll sideways`).toBeLessThanOrEqual(0);
    expect(m.chartRightPastBody, `${name}: chart stays inside the body`).toBeLessThanOrEqual(0);
    expect(Math.abs(m.chartWidth - m.rowWidth), `${name}: chart spans its row`).toBeLessThanOrEqual(2);
    expect(m.barInsideChart, `${name}: hover targets scale with the bars`).toBe(true);
  }
});
