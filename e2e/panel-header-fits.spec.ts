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

interface BadgeBox { width: number; height: number; fontSize: string; title: string }

// The freshness badge needs mapped sources and a health poll, so the probe adds
// one to the politics header. Both badges then render through the real
// stylesheet: dots below a 300px column, full pills above it.
function measureBadges(page: Page): Promise<{ freshness: BadgeBox; live: BadgeBox }> {
  return page.evaluate(() => {
    const left = document.querySelector<HTMLElement>('#panelsGrid .panel[data-panel="politics"] .panel-header-left')!;
    let probe = left.querySelector<HTMLElement>('[data-freshness-probe]');
    if (!probe) {
      probe = document.createElement('span');
      probe.className = 'panel-freshness-badge panel-freshness-fresh';
      probe.dataset.freshnessProbe = '';
      probe.textContent = '5m ago';
      probe.title = 'Updated 5 minutes ago';
      probe.style.display = 'inline-flex';
      left.appendChild(probe);
    }
    const box = (el: HTMLElement): BadgeBox => {
      const r = el.getBoundingClientRect();
      return { width: Math.round(r.width), height: Math.round(r.height), fontSize: getComputedStyle(el).fontSize, title: el.title };
    };
    return { freshness: box(probe), live: box(document.querySelector<HTMLElement>('#panelsGrid .panel[data-panel="politics"] .panel-data-badge.live')!) };
  });
}

function measure(page: Page): Promise<HeaderFit> {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('#panelsGrid .panel[data-panel="politics"]')!;
    const header = panel.querySelector<HTMLElement>('.panel-header')!;
    const title = header.querySelector<HTMLElement>('.panel-title')!;
    const items = [...header.querySelectorAll<HTMLElement>('.panel-title, .panel-header-left > *, .panel-header > *:not(.panel-header-left)')]
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => ({ name: el.className.toString().split(' ')[0], rect: el.getBoundingClientRect() }));
    const overlaps: string[] = [];
    items.forEach((a, i) => {
      for (const b of items.slice(i + 1)) {
        if (Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left) > 2) overlaps.push(`${a.name} x ${b.name}`);
      }
    });
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
    const badges = await measureBadges(page);
    if (m.panel <= 300) {
      for (const [name, b] of Object.entries(badges)) {
        expect.soft({ width: b.width, height: b.height, fontSize: b.fontSize }, `${label}: ${name} badge is a dot`).toEqual({ width: 8, height: 8, fontSize: '0px' });
        expect.soft(b.title, `${label}: ${name} dot has a hover label`).not.toBe('');
      }
    } else {
      for (const [name, b] of Object.entries(badges)) {
        expect.soft(b.width, `${label}: ${name} badge keeps its text`).toBeGreaterThan(20);
      }
    }
    await context.close();
  }
});
