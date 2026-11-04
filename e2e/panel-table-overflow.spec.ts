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

interface CellStyle { fontSize: string; fontWeight: string; textTransform: string; letterSpacing: string; color: string; padding: string; borderBottom: string }

// The first header and body cell of a panel's table, as rendered.
function readCellStyle(page: Page, id: string): Promise<{ th: CellStyle; td: CellStyle }> {
  return page.evaluate((panelId) => {
    const table = document.querySelector(`#panelsGrid .panel[data-panel="${panelId}"] table`)!;
    const pick = (cell: Element): CellStyle => {
      const s = getComputedStyle(cell);
      return {
        fontSize: s.fontSize, fontWeight: s.fontWeight, textTransform: s.textTransform, letterSpacing: s.letterSpacing,
        color: s.color, padding: s.padding, borderBottom: `${s.borderBottomWidth} ${s.borderBottomStyle} ${s.borderBottomColor}`,
      };
    };
    return { th: pick(table.querySelector('thead th')!), td: pick(table.querySelector('tbody td')!) };
  }, id);
}

// Cells whose own class sets a colour that the rendered cell does not show.
// A probe cell with the same classes in a plain table gives the colour the
// classes set; a class that sets none matches the plain probe and is skipped.
function readLostColours(page: Page, root: string): Promise<string[]> {
  return page.evaluate((rootSelector) => {
    const lost: string[] = [];
    for (const table of document.querySelectorAll(`${rootSelector} table.wm-table`)) {
      const probeTable = document.createElement('table');
      table.parentElement!.appendChild(probeTable);
      const probe = (className: string) => {
        probeTable.innerHTML = `<tbody><tr><td class="${className}">x</td></tr></tbody>`;
        return getComputedStyle(probeTable.querySelector('td')!).color;
      };
      const plain = probe('');
      for (const td of table.querySelectorAll<HTMLElement>('tbody td[class]')) {
        const own = probe(td.className);
        const shown = getComputedStyle(td).color;
        if (own !== plain && shown !== own) lost.push(`td.${td.className.trim().replace(/\s+/g, '.')}: ${shown}, class sets ${own}`);
      }
      probeTable.remove();
    }
    return lost;
  }, root);
}

// Tables on the shared `.wm-table` style (tests/panel-table-style.test.mjs),
// with the header and cell it renders in a 1920px sidebar column. The column
// is under 480px, so the panel-body container query narrows inline padding
// to 4px.
const WM_TABLE_PANELS = new Set(['ucdp-events', 'climate']);
const WM_TABLE_STYLE = {
  th: { fontSize: '10px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.4px', padding: '4px' },
  td: { fontSize: '11px', fontWeight: '400', textTransform: 'none', letterSpacing: 'normal', padding: '5px 4px' },
};

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
  // The fade grows over the last 24px of scroll, so a table that hides less
  // than 24px fades by the distance it hides.
  const fade = `${Math.min(24, s.overflow)}px`;
  expect.soft(s.atStart, `${label}: at the start only the trailing edge fades`).toMatchObject({ start: '0px', end: fade });
  if (PINNED_LABELS.has(id)) {
    expect.soft(s.atEnd, `${label}: at the end the pinned labels do not fade`).toMatchObject({ start: '0px', end: '0px' });
    expect.soft(s.labelDrift, `${label}: the label column stays pinned`).toBeLessThanOrEqual(1);
  } else {
    expect.soft(s.atEnd, `${label}: at the end only the leading edge fades`).toMatchObject({ start: fade, end: '0px' });
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
    const styles = new Map<string, { th: CellStyle; td: CellStyle }>();
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
      if (WM_TABLE_PANELS.has(id) && viewport.width === 1920) {
        const style = await readCellStyle(page, id);
        expect.soft(style.th, `${id}: header cell uses the shared table style`).toMatchObject(WM_TABLE_STYLE.th);
        expect.soft(style.td, `${id}: body cell uses the shared table style`).toMatchObject(WM_TABLE_STYLE.td);
        styles.set(id, style);
        expect.soft(await readLostColours(page, `#panelsGrid .panel[data-panel="${id}"]`), `${id}: cells keep the colour their class sets`).toEqual([]);
      }
    }
    if (viewport.width === 1920) {
      const [first, ...rest] = [...styles.values()];
      for (const style of rest) expect.soft(style, 'shared-style tables render identical header and body cells').toEqual(first);
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

test('shared-style table headers line up with their cells in RTL', async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await context.newPage();
  const ids = [...WM_TABLE_PANELS];
  const settings = Object.fromEntries(ids.map((id) => [id, { name: id, enabled: true, priority: 0 }]));
  await seedAnonymousDashboard(page, 'full', { localStorage: { 'worldmonitor-panels': JSON.stringify(settings) } });
  await routeFixtures(page);
  await page.goto('/dashboard?lang=ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  for (const id of ids) {
    const panel = page.locator(`#panelsGrid .panel[data-panel="${id}"]`);
    await expect
      .poll(async () => {
        await panel.scrollIntoViewIfNeeded().catch(() => {});
        return panel.locator('tbody tr').count();
      }, { message: `${id} rows`, timeout: 90_000 })
      .toBeGreaterThanOrEqual(3);
    const columns = await panel.evaluate((el) => {
      const table = el.querySelector('table.wm-table')!;
      // Resolve start/end against the cell's direction, so `left` and `start` compare by where text sits.
      const side = (cell: Element) => {
        const { textAlign, direction } = getComputedStyle(cell);
        if (textAlign === 'start') return direction === 'rtl' ? 'right' : 'left';
        if (textAlign === 'end') return direction === 'rtl' ? 'left' : 'right';
        return textAlign;
      };
      const headers = [...table.querySelectorAll('thead th')];
      const cells = [...table.querySelectorAll('tbody tr:first-child > *')];
      return headers.map((th, i) => `${(th.textContent ?? '').trim()}: header ${side(th)}, cell ${cells[i] ? side(cells[i]) : 'none'}`);
    });
    expect(columns.length, `${id} has header cells`).toBeGreaterThan(0);
    for (const column of columns) {
      const [, header, cell] = column.match(/header (\w+), cell (\w+)/)!;
      expect.soft(header, `${id} ${column}`).toBe(cell);
    }
  }
  await context.close();
});

// FX, ETF flows and the watchlist render outside the fixture dashboard, so
// they mount in the runtime harness with injected data. Their cells carry
// gain/loss classes, accent columns and dimmed reference values.
test('harness-mounted shared-style tables keep the shared header and their cell colours', async ({ page }) => {
  await page.goto('/tests/runtime-harness.html');
  await page.evaluate(async () => {
    await import('/src/styles/main.css');
    const { initI18n } = await import('/src/services/i18n.ts');
    await initI18n();
    const { Panel } = await import('/src/components/Panel.ts');
    const { FxPanel } = await import('/src/components/FxPanel.ts');
    const { ETFFlowsPanel } = await import('/src/components/ETFFlowsPanel.ts');
    const { WatchlistTableView } = await import('/src/components/WatchlistTableView.ts');

    document.getElementById('runtime-harness')?.remove();
    const grid = document.createElement('div');
    grid.className = 'panels-grid';
    grid.style.cssText = 'height:auto;width:900px;grid-template-columns:900px';
    document.body.appendChild(grid);

    const fx = new FxPanel();
    (fx as unknown as { updateFx(data: unknown): void }).updateFx({
      stress: [
        { countryCode: 'AR', currency: 'ARS', yoyChange: -38.2, drawdown24m: -61.4, stressed: true, peakRate: 0.0029, peakDate: '2024-11', troughRate: 0.0011, troughDate: '2026-10', asOf: '2026-10-31' },
        { countryCode: 'JP', currency: 'JPY', yoyChange: 2.1, drawdown24m: 0, stressed: false, peakRate: null, peakDate: null, troughRate: null, troughDate: null, asOf: '2026-10-31' },
      ],
      usd: [{ currency: 'EUR', usdPerUnit: 1.08, unitsPerUsd: 0.926 }, { currency: 'GBP', usdPerUnit: 1.27, unitsPerUsd: 0.787 }],
      eur: [{ currency: 'USD', rate: 1.08, change1d: 0.004 }, { currency: 'JPY', rate: 162.4, change1d: -0.85 }],
      rub: [{ currency: 'USD', rubPerUnit: 81.2, change1d: 0.4 }, { currency: 'CNY', rubPerUnit: 11.3, change1d: null }],
      degraded: [],
    });
    grid.appendChild(fx.getElement());
    (window as unknown as { fxProbe: unknown }).fxProbe = fx;

    const etf = new ETFFlowsPanel();
    const etfInternals = etf as unknown as { data: unknown; loading: boolean; renderPanel(): void };
    etfInternals.loading = false;
    etfInternals.data = {
      timestamp: '2026-11-04T00:00:00Z', rateLimited: false,
      summary: { etfCount: 2, totalVolume: 2.1e9, totalEstFlow: 3.4e8, netDirection: 'NET_INFLOW', inflowCount: 1, outflowCount: 1 },
      etfs: [
        { ticker: 'IBIT', issuer: 'BlackRock', price: 61.2, priceChange: 1.84, volume: 1.4e9, avgVolume: 1.1e9, volumeRatio: 1.3, direction: 'inflow', estFlow: 4.1e8 },
        { ticker: 'GBTC', issuer: 'Grayscale', price: 78.5, priceChange: -0.92, volume: 7e8, avgVolume: 8e8, volumeRatio: 0.9, direction: 'outflow', estFlow: -7e7 },
      ],
    };
    etfInternals.renderPanel();
    grid.appendChild(etf.getElement());

    const watch = new Panel({ id: 'probe-watchlist', title: 'Watchlist' });
    const view = new WatchlistTableView<{ symbol: string; change: number }>({
      columns: [
        { key: 'symbol', label: 'Symbol', cell: (item) => item.symbol },
        { key: 'change', label: 'Change', align: 'right', cell: (item) => `${item.change}%` },
      ],
      filters: [{ key: 'all', label: 'All', match: () => true }],
      sortOptions: [{ key: 'symbol', label: 'Symbol', cmp: (a, b) => a.symbol.localeCompare(b.symbol) }],
      defaultSort: 'symbol', defaultFilter: 'all',
      getKey: (item) => item.symbol, getSearchText: (item) => item.symbol, renderDetail: () => '',
    });
    view.setItems([{ symbol: 'AAPL', change: 1.2 }, { symbol: 'MSFT', change: -0.4 }]);
    watch.getElement().querySelector('.panel-content')!.innerHTML = view.render();
    grid.appendChild(watch.getElement());
    await new Promise((r) => setTimeout(r, 300));
  });

  const views: Array<{ name: string; root: string; tab?: string }> = [
    { name: 'fx stress', root: '.panel[data-panel="fx"]', tab: 'stress' },
    { name: 'fx spot', root: '.panel[data-panel="fx"]', tab: 'spot' },
    { name: 'fx rub', root: '.panel[data-panel="fx"]', tab: 'rub' },
    { name: 'etf-flows', root: '.panel[data-panel="etf-flows"]' },
    { name: 'watchlist', root: '.panel[data-panel="probe-watchlist"]' },
  ];
  let headerColour = '';
  for (const { name, root, tab } of views) {
    if (tab) {
      await page.evaluate(async (fxTab) => {
        const fx = (window as unknown as { fxProbe: { tab: string; render(): void } }).fxProbe;
        fx.tab = fxTab;
        fx.render();
        await new Promise((r) => setTimeout(r, 300));
      }, tab);
    }
    const tables = await page.evaluate((rootSelector) => [...document.querySelectorAll(`${rootSelector} table.wm-table`)].map((table) => {
      const pick = (el: Element) => {
        const s = getComputedStyle(el);
        return { fontSize: s.fontSize, fontWeight: s.fontWeight, textTransform: s.textTransform, letterSpacing: s.letterSpacing, color: s.color };
      };
      return { th: pick(table.querySelector('thead th')!), td: pick(table.querySelector('tbody td')!) };
    }), root);
    expect(tables.length, `${name}: shared-style tables`).toBeGreaterThan(0);
    for (const { th, td } of tables) {
      headerColour ||= th.color;
      expect.soft(th, `${name}: header cell uses the shared table style`).toMatchObject({ fontSize: '10px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.4px' });
      expect.soft(td.fontSize, `${name}: body cell uses the shared size`).toBe('11px');
      expect.soft(th.color, `${name}: header colour matches the other shared-style tables`).toBe(headerColour);
    }
    expect.soft(await readLostColours(page, root), `${name}: cells keep the colour their class sets`).toEqual([]);
  }
});

// Satellite Fires and Displacement have no dashboard fixture, so the harness
// mounts them directly. Displacement renders a different table per tab.
test('Satellite Fires and every Displacement table fit the sidebar and phone widths', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/tests/runtime-harness.html');

  const results = await page.evaluate(async () => {
    await import('/src/styles/main.css');
    const { initI18n } = await import('/src/services/i18n.ts');
    await initI18n();
    const { SatelliteFiresPanel } = await import('/src/components/SatelliteFiresPanel.ts');
    const { DisplacementPanel } = await import('/src/components/DisplacementPanel.ts');

    document.getElementById('runtime-harness')?.remove();
    const grid = document.createElement('div');
    grid.className = 'panels-grid';
    document.body.appendChild(grid);

    // Long names and large figures, the widest values each table shows.
    const names = ['Democratic Republic of the Congo', 'Syrian Arab Republic', 'Venezuela (Bolivarian Republic of)'];
    const codes = ['CD', 'SY', 'VE'];
    const fires = new SatelliteFiresPanel();
    fires.update(names.map((region, i) => ({ region, fires: [], fireCount: 12_345 - i, totalFrp: 98_765.4 / (i + 1), highIntensityCount: 4321, possibleExplosionCount: i === 1 ? 2 : 0 })), 37_000);
    const disp = new DisplacementPanel();
    disp.setData({
      year: 2025, globalTotals: { refugees: 1, asylumSeekers: 1, idps: 1, stateless: 1, total: 4 }, topFlows: [],
      countries: names.map((name, i) => ({ code: ['COD', 'SYR', 'VEN'][i]!, name, refugees: 6_543_210 - i, asylumSeekers: 123_456, idps: 1, stateless: 0, totalDisplaced: 7_000_000 - i * 3_000_000, hostRefugees: 3_000_000, hostAsylumSeekers: 1, hostTotal: 3_456_789 - i * 1_500_000 })),
    } as never);
    disp.setEventsData({ countries: names.map((countryName, i) => ({ countryCode: codes[i]!, countryName, displaced30d: 1_234_567, conflict30d: 1_000_000, disaster30d: 234_567, newlyReported7d: i ? 45_678 : 0, surge: i === 0 })), points: [], missingCountries: ['Sudan', 'Myanmar'], asOf: '2026-10-31' } as never);
    disp.setInternalData({ operations: names.map((countryName, i) => ({ countryCode: codes[i]!, countryName, operation: 'North Kivu and Ituri displacement tracking, round 14', reportingDate: '2026-09-30', totalIdps: 2_345_678, topReason: 'conflict' })), regions: [], routes: [] } as never);
    disp.setCrossBorderData({
      points: [], sources: [{ name: 'UNHCR', status: 'ok' }],
      situations: ['Sudan situation: refugee outflows to neighbouring countries', 'Ukraine refugee situation', 'Rohingya'].map((name, i) => ({
        id: `s${i}`, name, sourceUrl: 'https://data.unhcr.org/en/situations/sudan', asOf: '2026-10-31', accelerating: i === 0, outflow: 1, total: 3_456_789,
        lastMonth: i === 0 ? { month: '2026-09', individuals: 45_678 } : null, latestChange: i === 1 ? { delta: -12_345, days: 30 } : null,
        topCountries: ['Chad', 'South Sudan', 'Egypt'], countryCodes: ['TD'], kind: 'refugees', measure: 'stock',
        last7Days: i === 2 ? 1234 : undefined, last30Days: i === 2 ? 5678 : undefined, changePct: i === 2 ? 12.3 : undefined,
      })),
    } as never);
    grid.append(fires.getElement(), disp.getElement());
    const settle = () => new Promise((r) => setTimeout(r, 400));

    const out = [];
    for (const width of [271, 360, 375]) {
      grid.style.cssText = `box-sizing:content-box;height:auto;width:${width}px;grid-template-columns:${width}px`;
      for (const view of ['fires', 'origins', 'hosts', 'recent', 'internal', 'crossBorder']) {
        if (view !== 'fires') disp.getElement().querySelector<HTMLElement>(`.panel-tab[data-tab="${view}"]`)!.click();
        await settle();
        const content = (view === 'fires' ? fires : disp).getElement().querySelector<HTMLElement>('.panel-content')!;
        const table = content.querySelector('table')!;
        const cells = [...table.querySelectorAll<HTMLElement>('th, td')];
        const right = content.getBoundingClientRect().right;
        const label = (cell: Element) => (cell.textContent ?? '').trim().slice(0, 24);
        // A figure that wraps onto a second line reads as two numbers.
        const wrapped = [...table.querySelectorAll<HTMLElement>('td.disp-count, td.fire-count, td.fire-hi, td.fire-frp')]
          .filter((cell) => cell.getClientRects().length > 0 && cell.querySelector('*') === null)
          .filter((cell) => { const r = document.createRange(); r.selectNodeContents(cell); return r.getClientRects().length > 1; })
          .map(label);
        const th = getComputedStyle(table.querySelector('thead th')!);
        const td = getComputedStyle(table.querySelector('tbody td')!);
        out.push({
          name: `${view} at ${width}px`,
          rows: table.querySelectorAll('tbody tr').length,
          sideways: content.scrollWidth - content.clientWidth,
          pastPanel: cells.filter((cell) => cell.getBoundingClientRect().right > right + 0.5).map(label),
          clipped: cells.filter((cell) => cell.scrollWidth > cell.clientWidth + 1).map(label),
          // The tab bar scrolls by design; a table may scroll only in its own cued scroller.
          scrollers: [...content.querySelectorAll<HTMLElement>('*')]
            .filter((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1)
            .map((el) => el.className)
            .filter((name) => !/\b(panel-tabs|table-scroll)\b/.test(name)),
          wrapped,
          header: `${th.fontSize} ${th.fontWeight} ${th.textTransform} ${th.letterSpacing} ${th.padding}`,
          cell: `${td.fontSize} ${td.padding}`,
        });
      }
    }
    return out;
  });

  expect(results).toHaveLength(18);
  for (const r of results) {
    expect.soft(r.rows, `${r.name}: rows`).toBe(3);
    expect.soft(r.sideways, `${r.name}: sideways scroll`).toBeLessThanOrEqual(0);
    expect.soft(r.pastPanel, `${r.name}: cells past the panel edge`).toEqual([]);
    expect.soft(r.clipped, `${r.name}: cells wider than their content box`).toEqual([]);
    expect.soft(r.scrollers, `${r.name}: other sideways scrollers`).toEqual([]);
    expect.soft(r.wrapped, `${r.name}: figures split across lines`).toEqual([]);
    // Panel bodies up to 480px wide narrow the shared inline padding to 4px.
    expect.soft(r.header, `${r.name}: shared header style`).toBe('10px 600 uppercase 0.4px 4px');
    expect.soft(r.cell, `${r.name}: shared cell style`).toBe('11px 5px 4px');
  }
});
