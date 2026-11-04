import { expect, test, type Page } from '@playwright/test';
import { seedAnonymousDashboard } from './bootstrap-request-budget-fixtures';

// The Predictions bar gave each side at least 40px, but "No 11%" needs about
// 48px, so a small share's label spilled out of its own segment and the bar's
// rounded edge cut it. The SEC Material Events list kept each filer on one
// line, so "Federal Home Loan Bank of San F…" and "…of Chicago" read the same
// in a 248px column. Every label must sit inside its segment and every filer
// name must show in full, in a 375px column, a 248px column and on a phone.

const CLOSES_AT = Date.parse('2027-12-31T00:00:00Z');

const MARKETS = [
  { id: 'm1', title: 'Will the Fed cut rates at the December meeting?', yesPrice: 0.89 },
  { id: 'm2', title: 'Iran leadership change by December 31?', yesPrice: 0.13 },
  { id: 'm3', title: 'Will Brent close above $90 this year?', yesPrice: 0.87 },
  { id: 'm4', title: 'US recession declared in 2027?', yesPrice: 0.5 },
].map((m) => ({ ...m, volume: 28_800_000, url: `https://polymarket.com/event/${m.id}`, closesAt: CLOSES_AT, category: 'geopolitics', source: 'MARKET_SOURCE_POLYMARKET' }));

const FILERS = [
  'Macquarie Infrastructure Income Opportunities Fund',
  'Federal Home Loan Bank of San Francisco',
  'Federal Home Loan Bank of Chicago',
  'Ryman Hospitality Properties, Inc.',
  'FORTRESS CREDIT REALTY INCOME TRUST',
  'Fortress Net Lease REIT',
];

const EVENTS = FILERS.map((company, i) => ({
  company,
  cik: String(1_000_000 + i),
  form: '8-K',
  accession: `0001-26-00000${i}`,
  filedAtMs: Date.now() - i * 15 * 60_000,
  items: [{ code: '2.03', description: 'Creation of a Direct Financial Obligation' }],
  url: i === FILERS.length - 1 ? '' : `https://www.sec.gov/Archives/edgar/data/${1_000_000 + i}/index.htm`,
}));

const VIEWPORTS = [
  { width: 1920, height: 1200, mobile: false },
  { width: 1366, height: 768, mobile: false },
  { width: 393, height: 852, mobile: true },
];

interface LabelFit { text: string; outside: number }
interface NameFit { text: string; shown: boolean; clippedBy: string }

function measureLabels(page: Page): Promise<{ panel: number; labels: LabelFit[] }> {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('#panelsGrid .panel[data-panel="polymarket"]')!;
    const labels = [...panel.querySelectorAll<HTMLElement>('.prediction-label')].map((label) => {
      const own = label.parentElement!.getBoundingClientRect();
      const bar = label.closest('.prediction-bar')!.getBoundingClientRect();
      const r = label.getBoundingClientRect();
      const outside = Math.max(own.left - r.left, r.right - own.right, bar.left - r.left, r.right - bar.right, 0);
      return { text: label.textContent!.trim(), outside: Math.round(outside * 10) / 10 };
    });
    return { panel: Math.round(panel.getBoundingClientRect().width), labels };
  });
}

// A name is shown in full when its text sits inside every ancestor that clips
// it, up to the panel's scroll box, and the visible text is the whole name.
function measureNames(page: Page, names: string[]): Promise<{ panel: number; names: NameFit[] }> {
  return page.evaluate((names) => {
    const panel = document.querySelector<HTMLElement>('#panelsGrid .panel[data-panel="material-events"]')!;
    const content = panel.querySelector<HTMLElement>('.panel-content')!;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    const fits: NameFit[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent!.trim();
      if (!names.includes(text)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
      let clippedBy = '';
      for (let el = node.parentElement; el && el !== content.parentElement; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
        const box = el.getBoundingClientRect();
        const ellipsis = style.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1;
        const lineClamped = style.webkitLineClamp !== 'none' && el.scrollHeight > el.clientHeight + 1;
        const outsideX = style.overflowX !== 'visible' && rects.some((rect) => rect.left < box.left - 0.5 || rect.right > box.right + 0.5);
        const outsideY = !['auto', 'scroll', 'visible'].includes(style.overflowY) && rects.some((rect) => rect.top < box.top - 0.5 || rect.bottom > box.bottom + 0.5);
        if (ellipsis || lineClamped || outsideX || outsideY) {
          clippedBy = `${el.tagName.toLowerCase()} ${Math.round(box.width)}px${ellipsis ? ' ellipsis' : ''}${lineClamped ? ' line-clamp' : ''}`;
          break;
        }
      }
      fits.push({ text, shown: rects.length > 0, clippedBy });
    }
    return { panel: Math.round(panel.getBoundingClientRect().width), names: fits };
  }, names);
}

test('prediction labels and SEC filer names are never clipped', async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  for (const viewport of VIEWPORTS) {
    const { mobile, ...size } = viewport;
    const context = await browser.newContext({ viewport: size, colorScheme: 'dark', isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage();
    await seedAnonymousDashboard(page, 'full', {
      localStorage: {
        'worldmonitor-panels': JSON.stringify({
          polymarket: { name: 'Predictions', enabled: true, priority: 0 },
          'material-events': { name: 'SEC Material Events', enabled: true, priority: 0 },
        }),
      },
    });
    await page.route(/^https?:\/\/(?!(127\.0\.0\.1:4173|localhost:4173)(?:\/|$)).*/i, (route) => route.abort());
    await page.route('**/api/**', (route) => route.fulfill({ json: {} }));
    await page.route('**/api/bootstrap*', (route) => route.fulfill({ json: { missing: [], data: {} } }));
    await page.route(/list-prediction-markets/, (route) => route.fulfill({ json: { markets: MARKETS, fetchedAt: Date.now(), dataAvailable: true } }));
    await page.route(/list-material-events/, (route) => route.fulfill({ json: { events: EVENTS, unavailable: false, fetchedAtMs: Date.now() } }));

    await page.goto('/dashboard');
    const variant = `${viewport.width}${mobile ? '-phone' : ''}`;

    const predictions = page.locator('#panelsGrid .panel[data-panel="polymarket"]');
    await expect
      .poll(async () => {
        await predictions.scrollIntoViewIfNeeded().catch(() => {});
        return predictions.locator('.prediction-bar').count();
      }, { message: `prediction bars at ${variant}`, timeout: 90_000 })
      .toBe(MARKETS.length);
    await predictions.screenshot({ path: testInfo.outputPath(`polymarket-${variant}.png`) });
    const bars = await measureLabels(page);
    expect(bars.labels).toHaveLength(MARKETS.length * 2);
    expect.soft(
      bars.labels.filter((label) => label.outside > 0.5),
      `polymarket at ${variant} (panel ${bars.panel}px): labels outside their segment`,
    ).toEqual([]);

    const filings = page.locator('#panelsGrid .panel[data-panel="material-events"]');
    await expect
      .poll(async () => {
        await filings.scrollIntoViewIfNeeded().catch(() => {});
        return filings.getByText('8-K', { exact: true }).count();
      }, { message: `material events at ${variant}`, timeout: 90_000 })
      .toBe(EVENTS.length);
    await filings.screenshot({ path: testInfo.outputPath(`material-events-${variant}.png`) });
    const names = await measureNames(page, FILERS);
    expect(names.names.map((name) => name.text).sort()).toEqual([...FILERS].sort());
    expect.soft(
      names.names.filter((name) => !name.shown || name.clippedBy),
      `material-events at ${variant} (panel ${names.panel}px): filer names cut short`,
    ).toEqual([]);
    for (const company of FILERS.slice(0, -1)) {
      await expect.soft(filings.getByRole('link', { name: company, exact: true })).toBeVisible();
    }
    await context.close();
  }
});
