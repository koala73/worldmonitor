import { expect, test, type Page } from '@playwright/test';
import { seedAnonymousDashboard } from './bootstrap-request-budget-fixtures';
import { FORECAST_ACCURACY_AUDIT } from '../shared/forecast-accuracy-audit';

// #8984: the four-column forecast row needs ~270px beside the title. The row
// must lay out from the table's width, so every card keeps a readable title
// and no data column runs past the row, in narrow and wide panels alike.

const PANEL = '#panelsGrid .panel[data-panel="forecast"]';
const STACK_BELOW = 440;

const FORECASTS = [
  { id: 'fc-e2e-1', title: 'Will the ECB announce no change at the October 2026 meeting of its Governing Council?', domain: 'political', probability: 0.89, trend: 'stable', scoredHorizons: ['h24', 'd7', 'd30'] },
  { id: 'fc-e2e-2', title: 'Active armed conflict: Ukraine', domain: 'conflict', probability: 0.62, trend: 'rising', simulationAdjustment: 0.05, simPathConfidence: 0.8 },
  { id: 'fc-e2e-3', title: 'Supply chain disruption risk: Strait of Hormuz shipping lanes', domain: 'supply_chain', probability: 0.34, trend: 'falling' },
  { id: 'fc-e2e-4', title: 'Cyber threat concentration: France', domain: 'cyber', probability: 0.16, trend: 'stable' },
].map((f) => ({ region: 'Global', signals: [], ...f }));

const SCORECARD = {
  schemaVersion: 2,
  generatedAt: Date.parse('2026-10-05T06:00:00Z'),
  rollingWindowDays: 180,
  methodology: '',
  totals: { entries: 240, resolved: 60, pending: 150, pendingJudge: 30, scored: 55, void: 5, voidRate: 5 / 60, publicationCoverage: 0.9 },
  overall: { count: 55, brier: 0.19, logScore: -0.5 },
  byDomain: [],
  byGenerationOrigin: [],
  calibration: [],
  skill: { count: 42, brier: 0.182, logScore: -0.51, excludedScored: 13, excludedOrigins: [], yesCount: 13 },
  publishedByDomain: [
    { domain: 'conflict', count: 45, brier: 0.2134, yesCount: 15 },
    { domain: 'political', count: 31, brier: 0.19, yesCount: 9 },
  ],
  familyOutcomes: [
    { forecastId: 'fc-e2e-2', outcome: 'VOID', voidReason: 'count_source_window_not_retained' },
    { forecastId: 'fc-e2e-3', outcome: 'YES' },
    { forecastId: 'fc-e2e-3', outcome: 'NO' },
  ],
  receipts: [],
  degraded: false,
  stale: false,
  error: '',
};

interface CardMeasure { title: number; badge: number; horizons: number | null; past: number; h: number }
interface TableMeasure { tableContent: number; display: string; cards: CardMeasure[] }

function measure(page: Page): Promise<TableMeasure> {
  return page.evaluate((sel) => {
    const panel = document.querySelector(sel)!;
    const table = panel.querySelector('.fc-prob-table')!;
    const width = (el: Element | null) => (el ? el.getBoundingClientRect().width : 0);
    const cards = [...panel.querySelectorAll('.fc-prob-item')].map((item) => {
      const row = item.querySelector('.fc-prob-row')!;
      const right = row.getBoundingClientRect().right;
      const past = Math.max(
        row.scrollWidth - row.clientWidth,
        ...['.fc-bar-wrap', '.fc-prob-pct', '.fc-trend-text', '.fc-domain-tag'].map((s) => item.querySelector(s)!.getBoundingClientRect().right - right),
      );
      const horizons = item.querySelector('.fc-horizons > summary');
      const labelRight = item.querySelector('.fc-prob-label')!.getBoundingClientRect().right;
      const horizonsPast = horizons ? horizons.getBoundingClientRect().right - labelRight : 0;
      return { title: width(item.querySelector('.fc-forecast-title')), badge: width(item.querySelector('.fc-reliability')), horizons: horizons ? width(horizons) : null, past: Math.max(past, horizonsPast), h: item.getBoundingClientRect().height };
    });
    return { tableContent: table.clientWidth, display: getComputedStyle(panel.querySelector('.fc-prob-row')!).display, cards };
  }, PANEL);
}

const SIZES = [
  { name: '1280 default', width: 1280 },
  { name: '1280 two-column panel', width: 1280, colSpan: 2 },
  { name: '390 mobile', width: 390 },
  { name: '1440', width: 1440 },
  { name: '1024', width: 1024 },
];

test('forecast rows keep titles readable and data inside the row at every panel width', async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  const modes = new Set<string>();
  let horizonCards = 0;
  for (const size of SIZES) {
    const context = await browser.newContext({ viewport: { width: size.width, height: 900 }, colorScheme: 'dark' });
    const page = await context.newPage();
    await seedAnonymousDashboard(page, 'full', size.colSpan ? { localStorage: { 'worldmonitor-panel-col-spans': JSON.stringify({ forecast: size.colSpan }) } } : {});
    await page.route(/^https?:\/\/(?!(127\.0\.0\.1:4173|localhost:4173)(?:\/|$)).*/i, (route) => route.abort());
    await page.route('**/api/**', (route) => route.fulfill({ json: {} }));
    await page.route('**/api/bootstrap*', (route) => route.fulfill({ json: { missing: [], data: { forecasts: { predictions: FORECASTS, generatedAt: Date.now() } } } }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route(/get-forecast-scorecard/, async (route) => {
      await gate;
      await route.fulfill({ json: SCORECARD });
    });

    await page.goto('/dashboard');
    await expect(page.locator('html')).toHaveAttribute('data-wm-initial-data-ready', 'true', { timeout: 90_000 });
    await page.locator(PANEL).scrollIntoViewIfNeeded();
    await expect(page.locator(`${PANEL} .fc-prob-item`)).toHaveCount(FORECASTS.length, { timeout: 60_000 });
    // The audit badge (#8990) needs no scorecard, so it renders without a pending placeholder.
    await expect(page.locator(`${PANEL} .fc-card-meta.fc-reliability-pending`)).toHaveCount(FORECAST_ACCURACY_AUDIT ? 0 : FORECASTS.length);
    const loading = await measure(page);
    release();
    await expect(page.locator(`${PANEL} a.fc-reliability`)).toHaveCount(FORECASTS.length, { timeout: 30_000 });
    const loaded = await measure(page);
    await page.locator(`${PANEL} .fc-prob-table`).evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.locator(PANEL).screenshot({ path: testInfo.outputPath(`forecast-rows-${size.width}${size.colSpan ? '-span2' : ''}.png`) });

    const label = `${size.name} (table ${loaded.tableContent}px)`;
    modes.add(loaded.display);
    horizonCards += loaded.cards.filter((card) => card.horizons !== null).length;
    loaded.cards.forEach((card, i) => {
      expect(card.title, `${label} card ${i} title`).toBeGreaterThanOrEqual(50);
      expect(card.badge, `${label} card ${i} badge`).toBeGreaterThan(0);
      if (card.horizons !== null) expect(card.horizons, `${label} card ${i} scored horizons`).toBeGreaterThanOrEqual(50);
      expect(card.past, `${label} card ${i} overflow`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(card.h - loading.cards[i]!.h), `${label} card ${i} height shift`).toBeLessThanOrEqual(0.5);
    });

    expect(loaded.display, `${label} layout`).toBe(loaded.tableContent < STACK_BELOW ? 'flex' : 'grid');

    const voidCard = page.locator(`${PANEL} .fc-prob-item`).filter({ has: page.locator('details.fc-res-void') });
    const toggleBefore = await voidCard.locator('.fc-toggle-row').evaluate((el) => (el as HTMLElement).style.display);
    await voidCard.locator('details.fc-res-void > summary').click();
    await expect(voidCard.locator('details.fc-res-void'), `${label} VOID disclosure`).toHaveJSProperty('open', true);
    expect(await voidCard.locator('.fc-toggle-row').evaluate((el) => (el as HTMLElement).style.display), `${label} VOID click guard`).toBe(toggleBefore);

    const first = page.locator(`${PANEL} .fc-prob-item`).first();
    await first.locator('.fc-prob-row').click({ position: { x: 20, y: 12 } });
    expect(await first.locator('.fc-toggle-row').evaluate((el) => (el as HTMLElement).style.display), `${label} row click`).toBe('flex');

    await context.close();
  }
  expect(horizonCards, 'a card with scored horizons was measured').toBeGreaterThan(0);
  expect([...modes].sort(), 'both the stacked and the four-column layouts were exercised').toEqual(['flex', 'grid']);
});
