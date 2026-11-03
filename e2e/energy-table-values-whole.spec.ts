import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { seedAnonymousDashboard } from './bootstrap-request-budget-fixtures';

// The energy registry tables gave their long name column most of the width, so
// short values broke mid-value: "2025-11-" over "01", "Crude" over "hub",
// "19.8" over "Mtpa". A value cell may wrap only between its parts, a name only
// between words, and no table may scroll sideways out of its column.

const FIXTURES = JSON.parse(readFileSync(new URL('./fixtures/energy-tables.json', import.meta.url), 'utf8')) as {
  pipelines: { pipelines: unknown[] };
  storage: { facilities: unknown[] };
  shortages: { shortages: unknown[] };
};

const PANELS = [
  { key: 'fuel-shortages', rows: FIXTURES.shortages.shortages.length, valueColumns: [1] },
  { key: 'pipeline-status', rows: FIXTURES.pipelines.pipelines.length, valueColumns: [1, 2] },
  { key: 'storage-facility-map', rows: FIXTURES.storage.facilities.length, valueColumns: [1, 2] },
] as const;

// Panel text scales with the font-size setting (90% to 200%), so the layout
// must follow the text, not a fixed column width.
const VIEWPORTS = [
  { width: 1920, height: 1200, fontScale: 1 },
  { width: 1845, height: 1100, fontScale: 1 },
  { width: 1366, height: 768, fontScale: 1 },
  { width: 1920, height: 1200, fontScale: 1.25 },
  { width: 1920, height: 1200, fontScale: 2 },
];

interface TableFit { panel: number; table: number; host: number; split: string[]; brokenWords: string[] }

function measure(page: Page, key: string, valueColumns: readonly number[]): Promise<TableFit> {
  return page.evaluate(({ key, valueColumns }) => {
    const panel = document.querySelector<HTMLElement>(`#panelsGrid .panel[data-panel="${key}"]`)!;
    const table = panel.querySelector<HTMLTableElement>('table')!;
    const split: string[] = [];
    const brokenWords: string[] = [];
    const lineCount = (range: Range) => {
      const tops: number[] = [];
      for (const rect of range.getClientRects()) {
        if (rect.width > 0 && !tops.some((top) => Math.abs(top - rect.top) < 4)) tops.push(rect.top);
      }
      return tops.length;
    };
    for (const row of table.querySelectorAll('tbody tr')) {
      for (const index of valueColumns) {
        const cell = row.children[index];
        if (!cell) continue;
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          if (lineCount(range) > 1) split.push(node.textContent.trim());
        }
      }
      // A name may wrap between words or at a hyphen, never inside a word.
      const name = row.querySelector('[class$="-name"]');
      for (const node of name?.childNodes ?? []) {
        if (node.nodeType !== Node.TEXT_NODE) continue;
        for (const match of node.textContent!.matchAll(/[^\s-]+/g)) {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          if (lineCount(range) > 1) brokenWords.push(match[0]);
        }
      }
    }
    return {
      panel: Math.round(panel.getBoundingClientRect().width),
      table: Math.round(table.scrollWidth),
      host: Math.round(table.parentElement!.clientWidth),
      split,
      brokenWords,
    };
  }, { key, valueColumns });
}

test('energy table values and names stay whole inside their column', async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  for (const viewport of VIEWPORTS) {
    const { fontScale, ...size } = viewport;
    const context = await browser.newContext({ viewport: size, colorScheme: 'dark' });
    const page = await context.newPage();
    const settings = Object.fromEntries(PANELS.map(({ key }) => [key, { name: key, enabled: true, priority: 0 }]));
    await seedAnonymousDashboard(page, 'full', {
      localStorage: { 'worldmonitor-panels': JSON.stringify(settings), 'wm-font-scale': String(fontScale) },
    });
    await page.route(/^https?:\/\/(?!(127\.0\.0\.1:4173|localhost:4173)(?:\/|$)).*/i, (route) => route.abort());
    await page.route('**/api/**', (route) => route.fulfill({ json: {} }));
    await page.route('**/api/bootstrap*', (route) => route.fulfill({ json: { missing: [], data: {} } }));
    await page.route(/list-pipelines/, (route) => route.fulfill({ json: FIXTURES.pipelines }));
    await page.route(/list-storage-facilities/, (route) => route.fulfill({ json: FIXTURES.storage }));
    await page.route(/list-fuel-shortages/, (route) => route.fulfill({ json: FIXTURES.shortages }));

    await page.goto('/dashboard');
    for (const { key, rows, valueColumns } of PANELS) {
      const panel = page.locator(`#panelsGrid .panel[data-panel="${key}"]`);
      await expect
        .poll(async () => {
          await panel.scrollIntoViewIfNeeded().catch(() => {});
          return panel.locator('tbody tr').count();
        }, { message: `${key} rows at ${viewport.width}px, ${fontScale * 100}% text`, timeout: 90_000 })
        .toBe(rows);
      await panel.screenshot({ path: testInfo.outputPath(`${key}-${viewport.width}-${fontScale * 100}.png`) });
      const fit = await measure(page, key, valueColumns);
      const label = `${key} at ${viewport.width}px, ${fontScale * 100}% text (panel ${fit.panel}px)`;
      expect.soft(fit.split, `${label}: values broken across lines`).toEqual([]);
      expect.soft(fit.brokenWords, `${label}: name words broken mid-word`).toEqual([]);
      expect.soft(fit.table, `${label}: table wider than its column`).toBeLessThanOrEqual(fit.host + 1);
    }
    await context.close();
  }
});
