import { expect, test, type Page } from '@playwright/test';
import { seedAnonymousDashboard } from './bootstrap-request-budget-fixtures';

// A news item's source row carries the publisher, credibility, corroboration,
// alert and category badges. The row must keep every badge inside the panel
// at every panel column width: 375px on a 1920px desktop, 248px on a 1366px
// laptop, and the phone layout. A badge past the panel edge is clipped and
// never seen.

const VIEWPORTS = [
  { width: 1920, height: 1200, mobile: false },
  { width: 1366, height: 768, mobile: false },
  { width: 375, height: 812, mobile: true },
];

// The digest keeps only items from a configured feed, so every item names a
// real politics publisher. A long publisher name, a developing story, an
// alert and a military classification give the row its longest badge set.
const THREAT = { level: 'THREAT_LEVEL_HIGH', category: 'military', confidence: 0.9, source: 'keyword' };
const STORY = { firstSeen: Date.now() - 3_600_000, mentionCount: 3, sourceCount: 1, phase: 'STORY_PHASE_DEVELOPING' };
const ITEMS = [
  { source: 'BBC World', title: 'Army launches missile strike on naval base after drone attack', isAlert: true, threat: THREAT, storyMeta: STORY },
  { source: 'BBC World', title: 'Central bank raises rates as inflation climbs for a third month', isAlert: true, threat: THREAT },
  { source: 'BBC World', title: 'Government issues warning to armed groups ahead of the election', isAlert: false },
];

function digest(): string {
  return JSON.stringify({
    categories: {
      politics: {
        items: ITEMS.map((item, i) => ({ ...item, link: `https://example.com/politics/${i}`, publishedAt: Date.now() - i * 60_000 })),
      },
    },
    feedStatuses: {},
    generatedAt: new Date().toISOString(),
  });
}

interface RowFit { rows: number; badges: number; pastEdge: string[]; panel: number }

function measure(page: Page): Promise<RowFit> {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('#panelsGrid .panel[data-panel="politics"]')!;
    const content = panel.querySelector<HTMLElement>('.panel-content')!;
    const right = content.getBoundingClientRect().right - parseFloat(getComputedStyle(content).paddingRight);
    const rows = [...content.querySelectorAll<HTMLElement>('.item-source')];
    const children = rows.flatMap((row) => [...row.children]);
    return {
      rows: rows.length,
      badges: children.length,
      pastEdge: children
        .filter((child) => child.getBoundingClientRect().right > right + 0.5)
        .map((child) => (child.textContent ?? '').trim().slice(0, 24)),
      panel: Math.round(panel.getBoundingClientRect().width),
    };
  });
}

test('news source rows keep every badge inside the panel', async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      colorScheme: 'dark',
      isMobile: viewport.mobile,
      hasTouch: viewport.mobile,
    });
    const page = await context.newPage();
    const settings = { politics: { name: 'World News', enabled: true, priority: 0 } };
    await seedAnonymousDashboard(page, 'full', { localStorage: { 'worldmonitor-panels': JSON.stringify(settings) } });
    await page.route(/^https?:\/\/(?!(127\.0\.0\.1:4173|localhost:4173)(?:\/|$)).*/i, (route) => route.abort());
    await page.route('**/api/**', (route) => route.fulfill({ json: {} }));
    await page.route('**/api/bootstrap*', (route) => route.fulfill({ json: { missing: [], data: {} } }));
    await page.route('**/api/news/v1/list-feed-digest*', (route) => route.fulfill({ contentType: 'application/json', body: digest() }));

    await page.goto('/dashboard');
    const panel = page.locator('#panelsGrid .panel[data-panel="politics"]');
    // The panel paints flat rows first and swaps in clustered rows once
    // clustering finishes; only the clustered rows carry the category badge.
    await expect
      .poll(async () => {
        await panel.scrollIntoViewIfNeeded().catch(() => {});
        return panel.locator('.item.clustered .item-source').count();
      }, { message: `politics clustered rows at ${viewport.width}px`, timeout: 90_000 })
      .toBe(ITEMS.length);
    await expect(panel.locator('.item.clustered .category-tag')).toHaveCount(2);
    await expect(panel.locator('.item.clustered .alert-tag')).toHaveCount(2);
    await panel.screenshot({ path: testInfo.outputPath(`politics-${viewport.width}.png`) });
    const m = await measure(page);
    const label = `politics at ${viewport.width}px (panel ${m.panel}px, ${m.badges} badges)`;
    expect(m.badges, `${label}: badges rendered`).toBeGreaterThanOrEqual(ITEMS.length * 4);
    expect.soft(m.pastEdge, `${label}: badges past the panel edge`).toEqual([]);
    await context.close();
  }
});
