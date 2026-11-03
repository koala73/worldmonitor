import { expect, test, type Page } from '@playwright/test';
import { seedAnonymousDashboard } from './bootstrap-request-budget-fixtures';

// The happy theme pads each Human Progress chart by 16px a side, but the chart
// sized its SVG from the whole panel body, so every chart ran 32px past its box
// and the panel scrolled sideways. The fixed tick count also crowded the
// enlarged axis years together in narrow columns.

const VIEWPORTS = [
  { width: 1920, height: 1200, fontScale: 1 },
  { width: 1366, height: 768, fontScale: 1 },
  { width: 1280, height: 800, fontScale: 1 },
  { width: 1920, height: 1200, fontScale: 2 },
];

interface ChartFit {
  panel: number;
  bodyOverflow: number;
  charts: { overflow: number; overlaps: string[] }[];
}

function measure(page: Page): Promise<ChartFit> {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('#panelsGrid .panel[data-panel="progress"]')!;
    const body = panel.querySelector<HTMLElement>('.panel-content')!;
    const charts = [...panel.querySelectorAll<HTMLElement>('.progress-chart-container')].map((chart) => {
      const style = getComputedStyle(chart);
      const innerRight = chart.getBoundingClientRect().right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth);
      const svg = chart.querySelector('svg')!;
      const labels = [...svg.querySelectorAll<SVGTextElement>('g.tick text')]
        .filter((text) => /^\d{4}$/.test(text.textContent ?? ''))
        .map((text) => ({ text: text.textContent!, rect: text.getBoundingClientRect() }))
        .sort((a, b) => a.rect.left - b.rect.left);
      const overlaps: string[] = [];
      for (let i = 1; i < labels.length; i++) {
        const previous = labels[i - 1]!;
        const current = labels[i]!;
        if (current.rect.left < previous.rect.right + 2) overlaps.push(`${previous.text}/${current.text}`);
      }
      return { overflow: Math.round(svg.getBoundingClientRect().right - innerRight), overlaps };
    });
    return {
      panel: Math.round(panel.getBoundingClientRect().width),
      bodyOverflow: body.scrollWidth - body.clientWidth,
      charts,
    };
  });
}

test('Human Progress charts fit their box and keep axis years apart', async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  for (const { fontScale, ...viewport } of VIEWPORTS) {
    const context = await browser.newContext({ viewport, colorScheme: 'dark' });
    const page = await context.newPage();
    await seedAnonymousDashboard(page, 'happy', {
      localStorage: {
        'worldmonitor-panels': JSON.stringify({ progress: { name: 'Human Progress', enabled: true, priority: 0 } }),
        'wm-font-scale': String(fontScale),
      },
    });
    await page.route(/^https?:\/\/(?!(127\.0\.0\.1:4173|localhost:4173)(?:\/|$)).*/i, (route) => route.abort());
    await page.route('**/api/**', (route) => route.fulfill({ json: {} }));
    await page.route('**/api/bootstrap*', (route) => route.fulfill({ json: { missing: [], data: {} } }));

    await page.goto('/dashboard');
    const panel = page.locator('#panelsGrid .panel[data-panel="progress"]');
    await expect
      .poll(async () => {
        await panel.scrollIntoViewIfNeeded().catch(() => {});
        return panel.locator('.progress-chart-container svg').count();
      }, { message: `progress charts at ${viewport.width}px, ${fontScale * 100}% text`, timeout: 90_000 })
      .toBeGreaterThan(0);
    await panel.screenshot({ path: testInfo.outputPath(`progress-${viewport.width}-${fontScale * 100}.png`) });

    const fit = await measure(page);
    const label = `${viewport.width}px, ${fontScale * 100}% text (panel ${fit.panel}px)`;
    expect.soft(fit.bodyOverflow, `${label}: panel body scrolls sideways`).toBeLessThanOrEqual(0);
    fit.charts.forEach((chart, index) => {
      expect.soft(chart.overflow, `${label}: chart ${index + 1} runs past its box`).toBeLessThanOrEqual(0);
      expect.soft(chart.overlaps, `${label}: chart ${index + 1} axis years overlap`).toEqual([]);
    });
    await context.close();
  }
});
