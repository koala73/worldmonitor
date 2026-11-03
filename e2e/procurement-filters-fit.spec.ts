import { expect, test, type Page } from '@playwright/test';
import { seedAnonymousDashboard } from './bootstrap-request-budget-fixtures';

// The Global Procurement filter bar has eight controls. It must keep every
// control inside the panel at the default 375px dashboard column, at the
// 248px laptop column and on a phone; a control past the panel edge sits
// behind a sideways scroll nobody sees.

const VIEWPORTS = [
  { width: 1920, height: 1200, mobile: false },
  { width: 1366, height: 768, mobile: false },
  { width: 375, height: 812, mobile: true },
];

const TENDERS = {
  tenders: [],
  nextCursor: '',
  fetchedAt: '2026-11-02T12:00:00.000Z',
  dataAvailable: true,
  availability: 'empty',
  sourceStatuses: [],
  total: 0,
  appliedFilters: [],
  countryCoverage: 'not_requested',
};

interface Fit { panel: number; controls: number; pastEdge: string[]; sideways: number }

function measure(page: Page): Promise<Fit> {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('#panelsGrid .panel[data-panel="global-procurement"]')!;
    const content = panel.querySelector<HTMLElement>('.panel-content')!;
    const form = panel.querySelector<HTMLElement>('.global-procurement-controls')!;
    const right = content.getBoundingClientRect().right;
    const controls = [...form.children] as HTMLElement[];
    return {
      panel: Math.round(panel.getBoundingClientRect().width),
      controls: controls.length,
      pastEdge: controls
        .filter((control) => control.getBoundingClientRect().right > right + 0.5)
        .map((control) => (control as HTMLInputElement).name || control.className),
      sideways: content.scrollWidth - content.clientWidth,
    };
  });
}

test('procurement filters fit the panel at every column width', async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      colorScheme: 'dark',
      isMobile: viewport.mobile,
      hasTouch: viewport.mobile,
    });
    const page = await context.newPage();
    const settings = { 'global-procurement': { name: 'Global Procurement', enabled: true, priority: 0 } };
    await seedAnonymousDashboard(page, 'full', {
      localStorage: { 'worldmonitor-panels': JSON.stringify(settings), 'wm-pro-key': 'wm-test-procurement' },
    });
    await page.route(/^https?:\/\/(?!(127\.0\.0\.1:4173|localhost:4173)(?:\/|$)).*/i, (route) => route.abort());
    await page.route('**/api/**', (route) => route.fulfill({ json: {} }));
    await page.route('**/api/bootstrap*', (route) => route.fulfill({ json: { missing: [], data: {} } }));
    await page.route('**/api/economic/v1/list-global-tenders*', (route) => route.fulfill({ json: TENDERS }));

    await page.goto('/dashboard');
    const panel = page.locator('#panelsGrid .panel[data-panel="global-procurement"]');
    await expect
      .poll(async () => {
        await panel.scrollIntoViewIfNeeded().catch(() => {});
        return panel.locator('.global-procurement-controls > *').count();
      }, { message: `procurement controls at ${viewport.width}px`, timeout: 90_000 })
      .toBe(8);
    await panel.screenshot({ path: testInfo.outputPath(`procurement-${viewport.width}.png`) });
    const m = await measure(page);
    const label = `procurement at ${viewport.width}px (panel ${m.panel}px)`;
    expect.soft(m.pastEdge, `${label}: controls past the panel edge`).toEqual([]);
    expect.soft(m.sideways, `${label}: sideways scroll`).toBeLessThanOrEqual(0);
    await context.close();
  }
});
