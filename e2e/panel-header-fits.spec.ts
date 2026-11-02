import { expect, test, type Page } from '@playwright/test';
import { seedAnonymousDashboard } from './bootstrap-request-budget-fixtures';

// A panel header holds the title, status badges and controls in one row. In a
// 248px dashboard column (a 1366px laptop) the fixed-size badges spilled under
// the controls and the title shrank to nothing. The title must stay readable
// and nothing in the header may overlap at any column width.

const VIEWPORTS = [
  { width: 1920, height: 1200 },
  { width: 1366, height: 768 },
];

const ITEMS = [
  { source: 'BBC World', title: 'Army launches missile strike on naval base after drone attack', isAlert: true },
  { source: 'BBC World', title: 'Central bank raises rates as inflation climbs for a third month', isAlert: false },
  { source: 'BBC World', title: 'Government issues warning to armed groups ahead of the election', isAlert: false },
];

function digest(): string {
  return JSON.stringify({
    categories: { politics: { items: ITEMS.map((item, i) => ({ ...item, link: `https://example.com/politics/${i}`, publishedAt: Date.now() - i * 60_000 })) } },
    feedStatuses: {},
    generatedAt: new Date().toISOString(),
  });
}

interface HeaderFit { panel: number; title: string; titleClipped: boolean; overlaps: string[] }

function measure(page: Page): Promise<HeaderFit> {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('#panelsGrid .panel[data-panel="politics"]')!;
    const header = panel.querySelector<HTMLElement>('.panel-header')!;
    const title = header.querySelector<HTMLElement>('.panel-title')!;
    const items = [...header.querySelectorAll<HTMLElement>('.panel-title, .panel-header-left > *, .panel-header > *:not(.panel-header-left)')]
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => ({ name: el.className.toString().split(' ')[0], rect: el.getBoundingClientRect() }));
    const overlaps: string[] = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i].rect, b = items[j].rect;
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2) overlaps.push(`${items[i].name} x ${items[j].name}`);
      }
    }
    return {
      panel: Math.round(panel.getBoundingClientRect().width),
      title: title.textContent ?? '',
      titleClipped: title.scrollWidth > title.clientWidth + 1,
      overlaps,
    };
  });
}

test('panel headers keep the title readable with nothing overlapping', async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ viewport, colorScheme: 'dark' });
    const page = await context.newPage();
    const settings = { politics: { name: 'World News', enabled: true, priority: 0 } };
    await seedAnonymousDashboard(page, 'full', { localStorage: { 'worldmonitor-panels': JSON.stringify(settings) } });
    await page.route(/^https?:\/\/(?!(127\.0\.0\.1:4173|localhost:4173)(?:\/|$)).*/i, (route) => route.abort());
    await page.route('**/api/**', (route) => route.fulfill({ json: {} }));
    await page.route('**/api/bootstrap*', (route) => route.fulfill({ json: { missing: [], data: {} } }));
    await page.route('**/api/news/v1/list-feed-digest*', (route) => route.fulfill({ contentType: 'application/json', body: digest() }));

    await page.goto('/dashboard');
    const panel = page.locator('#panelsGrid .panel[data-panel="politics"]');
    await expect
      .poll(async () => {
        await panel.scrollIntoViewIfNeeded().catch(() => {});
        return panel.locator('.item.clustered').count();
      }, { message: `politics rows at ${viewport.width}px`, timeout: 90_000 })
      .toBe(ITEMS.length);
    await panel.locator('.panel-header').screenshot({ path: testInfo.outputPath(`header-${viewport.width}.png`) });
    const m = await measure(page);
    const label = `politics header at ${viewport.width}px (panel ${m.panel}px)`;
    expect.soft(m.titleClipped, `${label}: title "${m.title}" is clipped`).toBe(false);
    expect.soft(m.overlaps, `${label}: overlapping header items`).toEqual([]);
    await context.close();
  }
});
