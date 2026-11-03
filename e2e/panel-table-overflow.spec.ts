import { expect, test, type Page } from '@playwright/test';
import { seedAnonymousDashboard } from './bootstrap-request-budget-fixtures';

// A table must fit its panel, or scroll inside it with a visible cue. The
// panel body scrolls sideways without a visible scrollbar on touch screens and
// on macOS, so a wider table silently hides its last columns (the energy status
// pill, the UCDP actors, the climate and radiation severity). Narrow panels
// occur on phones and in the desktop sidebar, where a column can be 214px.

const PANELS = ['energy-disruptions', 'ucdp-events', 'climate', 'radiation-watch'] as const;
const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 360, height: 740 },
];

const DESCRIPTION = 'Drone strikes on Tynda and Bamovsk pumping stations; four-day throughput reduction to Daqing.';
const ENERGY_DISRUPTIONS = {
  fetchedAt: '2026-11-01T00:00:00Z',
  classifierVersion: 'e2e',
  upstreamUnavailable: false,
  events: [
    { id: 'ed-1', assetId: 'progress-urengoy-uzhhorod', assetType: 'pipeline', eventType: 'commercial', startAt: '2025-01-01', endAt: '', capacityOfflineBcmYr: 15, capacityOfflineMbd: 0, causeChain: ['commercial', 'sanction'], shortDescription: DESCRIPTION, countries: ['UA', 'RU'] },
    { id: 'ed-2', assetId: 'espo', assetType: 'pipeline', eventType: 'sabotage', startAt: '2025-08-14', endAt: '2025-08-18', capacityOfflineBcmYr: 0, capacityOfflineMbd: 1.6, causeChain: ['sabotage', 'war'], shortDescription: DESCRIPTION, countries: ['RU'] },
    { id: 'ed-3', assetId: 'venezuela-anzoategui-puerto-la-cruz', assetType: 'pipeline', eventType: 'maintenance', startAt: '2025-06-01', endAt: '2025-06-30', capacityOfflineBcmYr: 0, capacityOfflineMbd: 0.2, causeChain: ['maintenance'], shortDescription: 'Planned shutdown to install higher-efficiency pumps.', countries: ['DE'] },
  ].map((e) => ({ sources: [], classifierVersion: 'e2e', classifierConfidence: 0.9, lastEvidenceUpdate: e.startAt, ...e })),
};

const UCDP_EVENTS = {
  pagination: { nextCursor: '', totalCount: 3 },
  events: [
    { id: 'u-1', country: 'Yemen (North Yemen)', sideA: 'Government of Yemen (North Yemen)', sideB: 'Ansarallah', deathsBest: 1234, deathsLow: 1000, deathsHigh: 1500 },
    { id: 'u-2', country: 'Democratic Republic of Congo (Zaire)', sideA: 'Government of DR Congo (Zaire)', sideB: 'M23', deathsBest: 12, deathsLow: 10, deathsHigh: 40 },
    { id: 'u-3', country: 'Ukraine', sideA: 'Government of Russia (Soviet Union)', sideB: 'Government of Ukraine', deathsBest: 2, deathsLow: 2, deathsHigh: 2 },
  ].map((e) => ({ dateStart: Date.parse('2026-09-30'), dateEnd: Date.parse('2026-09-30'), location: { latitude: 15, longitude: 44 }, violenceType: 'UCDP_VIOLENCE_TYPE_STATE_BASED', sourceOriginal: 'e2e', ...e })),
};

const CLIMATE_ANOMALIES = {
  pagination: { nextCursor: '', totalCount: 3 },
  anomalies: [
    { zone: 'Western Antarctic Ice Sheet', tempDelta: 3.5, precipDelta: 2.9, severity: 'ANOMALY_SEVERITY_MODERATE', type: 'ANOMALY_TYPE_WARM' },
    { zone: 'Southern Africa', tempDelta: 3.3, precipDelta: -2.4, severity: 'ANOMALY_SEVERITY_MODERATE', type: 'ANOMALY_TYPE_DRY' },
    { zone: 'Middle East', tempDelta: 7.8, precipDelta: 0.8, severity: 'ANOMALY_SEVERITY_EXTREME', type: 'ANOMALY_TYPE_WARM' },
  ].map((a) => ({ location: { latitude: 0, longitude: 0 }, period: '2026-10', ...a })),
};

const RADIATION_OBSERVATIONS = {
  fetchedAt: Date.parse('2026-11-01T00:00:00Z'),
  dataAvailable: true,
  epaCount: 3, safecastCount: 0, anomalyCount: 1, elevatedCount: 1, spikeCount: 0,
  corroboratedCount: 0, lowConfidenceCount: 1, conflictingCount: 0, convertedFromCpmCount: 1,
  observations: [
    { id: 'r-1', locationName: 'Albany', value: 56, baselineValue: 49.2, delta: 6.8, zScore: 2.6, severity: 'RADIATION_SEVERITY_ELEVATED', confidence: 'RADIATION_CONFIDENCE_MEDIUM', convertedFromCpm: true },
    { id: 'r-2', locationName: 'Boston', value: 67.6, baselineValue: 66.1, delta: 1.5, zScore: 0.4, severity: 'RADIATION_SEVERITY_NORMAL', confidence: 'RADIATION_CONFIDENCE_HIGH', convertedFromCpm: false },
    { id: 'r-3', locationName: 'Salt Lake City', value: 102.3, baselineValue: 99.4, delta: 2.9, zScore: 0.9, severity: 'RADIATION_SEVERITY_NORMAL', confidence: 'RADIATION_CONFIDENCE_LOW', convertedFromCpm: true },
  ].map((o) => ({
    source: 'RADIATION_SOURCE_EPA_RADNET', contributingSources: ['RADIATION_SOURCE_EPA_RADNET'], country: 'US',
    location: { latitude: 42, longitude: -73 }, unit: 'nSv/h', observedAt: Date.now() - 3_600_000,
    freshness: 'RADIATION_FRESHNESS_LIVE', corroborated: false, conflictingSources: false, sourceCount: 1, ...o,
  })),
};

const GROCERY_COUNTRIES = ['US', 'GB', 'DE', 'FR', 'JP', 'BR', 'IN', 'ZA', 'AE', 'LB'];
const GROCERY_BASKET = {
  fetchedAt: '2026-11-01T00:00:00Z',
  cheapestCountry: 'IN',
  mostExpensiveCountry: 'GB',
  upstreamUnavailable: false,
  wowAvgPct: 0,
  wowAvailable: false,
  prevFetchedAt: '',
  countries: GROCERY_COUNTRIES.map((code, i) => ({
    code, name: `Country ${code}`, currency: 'USD', flag: code, totalUsd: 20 + i, fxRate: 1, wowPct: 0,
    items: ['rice', 'eggs', 'milk'].map((itemId, j) => ({ itemId, itemName: itemId, unit: '1 kg', localPrice: 2 + i + j, usdPrice: 2 + i + j, available: true })),
  })),
};

async function routeFixtures(page: Page): Promise<void> {
  await page.route(/^https?:\/\/(?!(127\.0\.0\.1:4173|localhost:4173)(?:\/|$)).*/i, (route) => route.abort());
  await page.route('**/api/**', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/bootstrap*', (route) => route.fulfill({ json: { missing: [], data: {} } }));
  await page.route(/list-energy-disruptions/, (route) => route.fulfill({ json: ENERGY_DISRUPTIONS }));
  await page.route(/list-ucdp-events/, (route) => route.fulfill({ json: UCDP_EVENTS }));
  await page.route(/list-climate-anomalies/, (route) => route.fulfill({ json: CLIMATE_ANOMALIES }));
  await page.route(/list-radiation-observations/, (route) => route.fulfill({ json: RADIATION_OBSERVATIONS }));
  await page.route(/list-grocery-basket-prices/, (route) => route.fulfill({ json: GROCERY_BASKET }));
}

interface Overflow { panel: number; table: number; content: [number, number]; cellsPastPanel: string[] }

function measure(page: Page, id: string): Promise<Overflow> {
  return page.evaluate((panelId) => {
    const panel = document.querySelector<HTMLElement>(`#panelsGrid .panel[data-panel="${panelId}"]`)!;
    const content = panel.querySelector<HTMLElement>('.panel-content')!;
    const table = panel.querySelector('table')!;
    const right = content.getBoundingClientRect().right;
    const cellsPastPanel = [...table.querySelectorAll('th, td')]
      .filter((cell) => cell.getBoundingClientRect().right > right + 0.5)
      .map((cell) => (cell.textContent ?? '').trim().slice(0, 24));
    return {
      panel: Math.round(panel.getBoundingClientRect().width),
      table: Math.round(table.getBoundingClientRect().width),
      content: [content.scrollWidth, content.clientWidth] as [number, number],
      cellsPastPanel,
    };
  }, id);
}

test('panel tables fit the panel at phone width', async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ viewport, colorScheme: 'dark', isMobile: true, hasTouch: true });
    const page = await context.newPage();
    // Priority 0 keeps these panels inside the free tier's 40-panel cap, which
    // keeps the lowest priorities and breaks ties by key.
    const settings = Object.fromEntries(PANELS.map((id) => [id, { name: id, enabled: true, priority: 0 }]));
    await seedAnonymousDashboard(page, 'full', { localStorage: { 'worldmonitor-panels': JSON.stringify(settings) } });
    await routeFixtures(page);

    await page.goto('/dashboard');
    for (const id of PANELS) {
      const panel = page.locator(`#panelsGrid .panel[data-panel="${id}"]`);
      await expect
        .poll(async () => {
          await panel.scrollIntoViewIfNeeded().catch(() => {});
          return panel.locator('tbody tr').count();
        }, { message: `${id} rows at ${viewport.width}px`, timeout: 90_000 })
        .toBe(3);
      await panel.screenshot({ path: testInfo.outputPath(`${id}-${viewport.width}.png`) });
      const m = await measure(page, id);
      const label = `${id} at ${viewport.width}px (panel ${m.panel}px, table ${m.table}px)`;
      expect.soft(m.cellsPastPanel, `${label}: cells past the panel edge`).toEqual([]);
      expect.soft(m.content[0] - m.content[1], `${label}: sideways scroll`).toBeLessThanOrEqual(0);
    }
    await context.close();
  }
});

interface CueState { start: string; end: string; mask: string }
interface Scroll {
  panel: number;
  overflow: number;
  cellsPastPanel: number;
  scroller: string;
  keyboard: boolean;
  name: string;
  // Text inside the faded scroller that is not part of the table, such as a
  // panel summary, filter chips or a source footer. The fade must not reach it.
  outsideTable: string;
  atStart: CueState;
  atEnd: CueState;
  // Distance of the first row label from the scroller's inline-start edge
  // once scrolled to the end: 0 when the label column is pinned.
  labelDrift: number;
}

// Reads the table's horizontal scroll container in both end positions. The
// cue is a scroll-driven fade, so each read waits two frames for the scroll
// timeline to catch up.
function readScroll(page: Page, id: string): Promise<Scroll> {
  return page.evaluate(async (panelId) => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const panel = document.querySelector<HTMLElement>(`#panelsGrid .panel[data-panel="${panelId}"]`)!;
    const table = panel.querySelector('table')!;
    const box = panel.getBoundingClientRect();
    const cellsPastPanel = [...table.querySelectorAll('th, td')]
      .filter((cell) => { const r = cell.getBoundingClientRect(); return r.right > box.right + 0.5 || r.left < box.left - 0.5; }).length;
    let scroller: HTMLElement | null = null;
    for (let el = table.parentElement; el && el !== panel; el = el.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1) { scroller = el; break; }
    }
    const none: CueState = { start: '', end: '', mask: 'none' };
    if (!scroller) {
      return { panel: Math.round(box.width), overflow: 0, cellsPastPanel, scroller: '', keyboard: false, name: '', outsideTable: '', atStart: none, atEnd: none, labelDrift: 0 };
    }
    const read = (): CueState => {
      const cs = getComputedStyle(scroller!);
      return {
        start: cs.getPropertyValue('--table-scroll-fade-start').trim(),
        end: cs.getPropertyValue('--table-scroll-fade-end').trim(),
        mask: cs.maskImage,
      };
    };
    const copy = scroller.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('table, style, script').forEach((el) => el.remove());
    const outsideTable = (copy.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const rtl = getComputedStyle(scroller).direction === 'rtl';
    const towardEnd = rtl ? -1 : 1;
    scroller.scrollLeft = 0;
    await frame();
    const atStart = read();
    scroller.scrollLeft = towardEnd * scroller.scrollWidth;
    await frame();
    const atEnd = read();
    const label = table.querySelector('tbody td')!.getBoundingClientRect();
    const edge = scroller.getBoundingClientRect();
    const labelDrift = Math.round(Math.abs(rtl ? edge.right - label.right : label.left - edge.left));
    scroller.scrollLeft = 0;
    scroller.dataset.tableScrollProbe = panelId;
    const labelledBy = scroller.getAttribute('aria-labelledby');
    const name = (labelledBy ? document.getElementById(labelledBy)?.textContent : scroller.getAttribute('aria-label')) ?? '';
    return {
      panel: Math.round(box.width),
      overflow: scroller.scrollWidth - scroller.clientWidth,
      cellsPastPanel,
      scroller: scroller.className,
      keyboard: scroller.tabIndex >= 0,
      name: name.trim(),
      outsideTable,
      atStart,
      atEnd,
      labelDrift,
    };
  }, id);
}

// Tables with a pinned label column fade only the trailing edge, so the
// labels stay legible.
const PINNED_LABELS = new Set(['grocery-basket']);

async function expectCue(page: Page, s: Scroll, id: string, label: string): Promise<void> {
  expect.soft(s.keyboard, `${label}: the scroll region is a tab stop`).toBe(true);
  expect.soft(s.name, `${label}: the scroll region has a name`).not.toBe('');
  // A generic div cannot carry a name, so the wrapper needs a nameable role.
  // Group, not region: panels avoid adding a landmark each (Panel.ts).
  if (s.scroller.split(' ').includes('table-scroll')) {
    const region = page.locator(`[data-table-scroll-probe="${id}"]`);
    await expect.soft(region, `${label}: the scroll region has a nameable role`).toHaveRole('group');
    const panelTitle = (await page.locator(`#panelsGrid .panel[data-panel="${id}"] .panel-title`).textContent())?.trim() ?? '';
    expect.soft(panelTitle, `${label}: the panel has a title`).not.toBe('');
    await expect.soft(region, `${label}: the scroll region is named by the panel title`).toHaveAccessibleName(panelTitle);
  }
  expect.soft(s.scroller.split(' '), `${label}: the table scrolls inside its own wrapper, not the panel body`).toContain('table-scroll');
  expect.soft(s.outsideTable, `${label}: the edge fade covers only the table`).toBe('');
  expect.soft(s.atStart.mask, `${label}: edge fade at the start`).not.toBe('none');
  expect.soft(s.atStart, `${label}: at the start only the trailing edge fades`).toMatchObject({ start: '0px', end: '24px' });
  if (PINNED_LABELS.has(id)) {
    expect.soft(s.atEnd, `${label}: at the end the pinned labels do not fade`).toMatchObject({ start: '0px', end: '0px' });
    expect.soft(s.labelDrift, `${label}: the label column stays pinned`).toBeLessThanOrEqual(1);
  } else {
    expect.soft(s.atEnd, `${label}: at the end only the leading edge fades`).toMatchObject({ start: '24px', end: '0px' });
  }
}

// The sidebar holds two columns: 375px at 1920, about 279px at 1440, and
// about 271px at 1400, the narrowest viewport that still fits two. `fit` lists the tables
// that must reflow to the column without scrolling; the rest may keep their
// columns and scroll with the cue.
const DESKTOP_VIEWPORTS = [
  { width: 1920, height: 1080, fit: ['energy-disruptions', 'ucdp-events', 'climate', 'radiation-watch'] },
  { width: 1440, height: 900, fit: ['climate'] },
  { width: 1400, height: 800, fit: [] },
];
const DESKTOP_PANELS = [...PANELS, 'grocery-basket'] as const;

test('panel tables fit a narrow desktop column or scroll with a visible cue', async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  for (const { fit, ...viewport } of DESKTOP_VIEWPORTS) {
    const context = await browser.newContext({ viewport, colorScheme: 'dark' });
    const page = await context.newPage();
    const settings = Object.fromEntries(DESKTOP_PANELS.map((id) => [id, { name: id, enabled: true, priority: 0 }]));
    await seedAnonymousDashboard(page, 'full', { localStorage: { 'worldmonitor-panels': JSON.stringify(settings) } });
    await routeFixtures(page);
    await page.goto('/dashboard');
    for (const id of DESKTOP_PANELS) {
      const panel = page.locator(`#panelsGrid .panel[data-panel="${id}"]`);
      await expect
        .poll(async () => {
          await panel.scrollIntoViewIfNeeded().catch(() => {});
          return panel.locator('tbody tr').count();
        }, { message: `${id} rows at ${viewport.width}px`, timeout: 90_000 })
        .toBeGreaterThanOrEqual(3);
      await panel.screenshot({ path: testInfo.outputPath(`${id}-${viewport.width}.png`) });
      const s = await readScroll(page, id);
      const label = `${id} at ${viewport.width}px (panel ${s.panel}px, ${s.scroller || 'no scroller'} hides ${s.overflow}px)`;
      expect(s.panel, `${label}: the panel sits in a sidebar column`).toBeLessThanOrEqual(400);
      if (fit.includes(id)) expect.soft(s.overflow, `${label}: sideways scroll`).toBeLessThanOrEqual(0);
      if (id === 'grocery-basket') expect.soft(s.overflow, `${label}: the country matrix scrolls`).toBeGreaterThan(0);
      if (s.overflow > 0 || s.cellsPastPanel > 0) await expectCue(page, s, id, label);
    }
    await context.close();
  }
});

test('the table scroll cue follows the reading direction in RTL', async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await context.newPage();
  const settings = { 'grocery-basket': { name: 'grocery-basket', enabled: true, priority: 0 } };
  await seedAnonymousDashboard(page, 'full', { localStorage: { 'worldmonitor-panels': JSON.stringify(settings) } });
  await routeFixtures(page);
  await page.goto('/dashboard?lang=ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const panel = page.locator('#panelsGrid .panel[data-panel="grocery-basket"]');
  await expect
    .poll(async () => {
      await panel.scrollIntoViewIfNeeded().catch(() => {});
      return panel.locator('tbody tr').count();
    }, { timeout: 90_000 })
    .toBeGreaterThanOrEqual(3);
  await panel.screenshot({ path: testInfo.outputPath('grocery-basket-rtl-1440.png') });
  const s = await readScroll(page, 'grocery-basket');
  const label = `grocery-basket RTL (panel ${s.panel}px, hides ${s.overflow}px)`;
  expect(s.overflow, `${label}: the country matrix scrolls`).toBeGreaterThan(0);
  await expectCue(page, s, 'grocery-basket', label);
  expect.soft(s.atStart.mask, `${label}: the fade runs from the inline end, which is the left edge`).toContain('to left');
  await context.close();
});
