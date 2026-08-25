import { expect, test, type Page } from '@playwright/test';

/**
 * #7112 — the SVG renderer's HTML overlay must stay bounded.
 *
 * `MapComponent` is the desktop renderer whenever the client has no hardware
 * WebGL2 context (`MapContainer.shouldUseDeckGL` -> `hasWebGLSupport` rejects
 * SwiftShader by name), which is the normal state of a synthetic lab runner and
 * of any GPU-blocklisted browser. It rebuilds every overlay marker on every
 * render, and each marker carries its own `click` listener — so before the
 * budget an uncapped AIS feed set the DOM size outright: 2,088 overlay markers
 * measured on production, 17.4k renderer nodes / 2.8k listeners at rest and
 * 49.7k / 21.5k mid-rebuild, against 7.6k / 736 on the DeckGL path.
 *
 * The ceiling is `MAP_OVERLAY_MARKER_BUDGET_DESKTOP` = { perLayer: 300,
 * total: 800 } (see src/utils/globe-marker-budget.ts). This spec seeds feeds an
 * order of magnitude past anything production has produced and asserts the
 * ceiling holds, that the budget cut the biggest feed rather than starving the
 * small ones, and that the cut is disclosed on the layer row.
 */

const DESKTOP_TOTAL = 800;
const DESKTOP_PER_LAYER = 300;
const STRESS_PER_FEED = 2000;
const DASHBOARD_MAX_DOM_NODES = 12000;
// Chromium's renderer-wide metric includes a small amount of browser-owned
// bookkeeping beyond the document nodes returned by querySelectorAll('*').
const DASHBOARD_MAX_RENDERER_NODES = 15000;
const DASHBOARD_MAX_LISTENERS = 1500;
const DASHBOARD_MAX_NODE_VARIANCE = 500;
const DASHBOARD_MAX_RENDERER_NODE_VARIANCE = 2000;
const DASHBOARD_MAX_LISTENER_VARIANCE = 200;

type BudgetState = {
  rendered: number;
  truncated: Record<string, { shown: number; total: number }>;
};

type HarnessWindow = Window & {
  __mobileMapIntegrationHarness?: {
    ready: boolean;
    seedOverlayMarkerStress: (perFeed: number) => void;
    seedOverlayViewportStress: (count: number) => void;
    setOverlayViewport: (lat: number, lon: number) => void;
    setOverlayZoom: (zoom: number) => void;
    seedTimeFilteredEarthquakes: (recent: number, stale: number) => void;
    getOverlayMarkerCount: () => number;
    getOverlayMarkerClassCount: (selector: string) => number;
    getOverlayPositionSignature: (selector: string) => string;
    getOverlayBudgetState: () => BudgetState;
  };
};

async function installLocalOnlyNetwork(page: Page): Promise<void> {
  await page.route(/^https?:\/\/(?!(127\.0\.0\.1:4173|localhost:4173)(?:\/|$)).*/i, (route) => {
    return route.abort('blockedbyclient');
  });
}

async function loadColdDashboard(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('worldmonitor-variant', 'full');
  });
  await installLocalOnlyNetwork(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.wmEventHandlersReady === 'true');
  await expect(page.locator('#mapContainer')).toBeVisible({ timeout: 30000 });
  // Let the same local-only boot window settle on every fresh context before
  // collecting the renderer metrics.
  await page.waitForTimeout(2000);
}

async function readDashboardDomMetrics(page: Page): Promise<{
  domNodes: number;
  rendererNodes: number;
  listeners: number;
}> {
  const domNodes = await page.evaluate(() => document.querySelectorAll('*').length);
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Performance.enable');
    const result = await session.send('Performance.getMetrics');
    const value = (name: string): number => {
      const metric = result.metrics.find((entry: { name: string; value: number }) => entry.name === name);
      if (!metric || !Number.isFinite(metric.value)) throw new Error(`Missing Chromium metric: ${name}`);
      return metric.value;
    };
    return {
      domNodes,
      rendererNodes: value('Nodes'),
      listeners: value('JSEventListeners'),
    };
  } finally {
    await session.detach().catch(() => {});
  }
}

test.describe('SVG map overlay marker budget (#7112)', () => {
  test('keeps the full dashboard DOM and listener counts bounded across cold loads', async ({ browser }) => {
    test.setTimeout(90000);
    const samples: Array<Awaited<ReturnType<typeof readDashboardDomMetrics>>> = [];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: 'dark',
        locale: 'en-US',
        timezoneId: 'UTC',
      });
      const page = await context.newPage();
      try {
        await loadColdDashboard(page);
        samples.push(await readDashboardDomMetrics(page));
      } finally {
        await context.close();
      }
    }

    const domNodes = samples.map((sample) => sample.domNodes);
    const rendererNodes = samples.map((sample) => sample.rendererNodes);
    const listeners = samples.map((sample) => sample.listeners);
    const range = (values: number[]): number => Math.max(...values) - Math.min(...values);

    // #7112 acceptance: this is the real /dashboard document, not only the
    // harness overlay root. The repeated fresh contexts catch cold-load drift;
    // the stated ceilings and tolerances are the production guardrail from the
    // issue investigation (12k document nodes / 15k renderer nodes / 1.5k
    // listeners).
    expect(Math.max(...domNodes)).toBeLessThanOrEqual(DASHBOARD_MAX_DOM_NODES);
    expect(Math.max(...rendererNodes)).toBeLessThanOrEqual(DASHBOARD_MAX_RENDERER_NODES);
    expect(Math.max(...listeners)).toBeLessThanOrEqual(DASHBOARD_MAX_LISTENERS);
    expect(range(domNodes)).toBeLessThanOrEqual(DASHBOARD_MAX_NODE_VARIANCE);
    // Performance.getMetrics().Nodes is renderer-wide and includes transient
    // browser-owned nodes, so it has a wider explicit tolerance than the live
    // dashboard document count.
    expect(range(rendererNodes)).toBeLessThanOrEqual(DASHBOARD_MAX_RENDERER_NODE_VARIANCE);
    expect(range(listeners)).toBeLessThanOrEqual(DASHBOARD_MAX_LISTENER_VARIANCE);
  });

  test('replans proximity-ranked markers after a pan and zoom transform', async ({ page }) => {
    await page.goto('/tests/mobile-map-integration-harness.html');
    await expect
      .poll(
        async () =>
          page.evaluate(() => Boolean((window as HarnessWindow).__mobileMapIntegrationHarness?.ready)),
        { timeout: 30000 },
      )
      .toBe(true);

    await page.evaluate(
      (count) =>
        (window as HarnessWindow).__mobileMapIntegrationHarness!.seedOverlayViewportStress(count),
      2000,
    );
    await expect
      .poll(
        async () =>
          page.evaluate((expected) => {
            const harness = (window as HarnessWindow).__mobileMapIntegrationHarness!;
            return harness.getOverlayMarkerClassCount('.hotspot') === expected;
          }, DESKTOP_PER_LAYER),
        { timeout: 15000 },
      )
      .toBe(true);

    const initial = await page.evaluate(() =>
      (window as HarnessWindow).__mobileMapIntegrationHarness!.getOverlayPositionSignature('.hotspot'),
    );
    await page.evaluate(() =>
      (window as HarnessWindow).__mobileMapIntegrationHarness!.setOverlayViewport(-55, 125),
    );
    await expect
      .poll(
        async () =>
          page.evaluate((previous) =>
            (window as HarnessWindow).__mobileMapIntegrationHarness!.getOverlayPositionSignature('.hotspot') !== previous,
          initial),
        { timeout: 15000 },
      )
      .toBe(true);

    const afterPan = await page.evaluate(() =>
      (window as HarnessWindow).__mobileMapIntegrationHarness!.getOverlayPositionSignature('.hotspot'),
    );
    await page.evaluate(() =>
      (window as HarnessWindow).__mobileMapIntegrationHarness!.setOverlayZoom(4),
    );
    await expect
      .poll(
        async () =>
          page.evaluate((previous) =>
            (window as HarnessWindow).__mobileMapIntegrationHarness!.getOverlayPositionSignature('.hotspot') !== previous,
          afterPan),
        { timeout: 15000 },
      )
      .toBe(true);
  });

  test('bounds the overlay marker count against feeds far past production volume', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto('/tests/mobile-map-integration-harness.html');

    await expect
      .poll(
        async () =>
          page.evaluate(() => Boolean((window as HarnessWindow).__mobileMapIntegrationHarness?.ready)),
        { timeout: 30000 },
      )
      .toBe(true);

    // Sanity: without the stress feeds the harness renders a handful of markers,
    // so a later assertion of "<= 800" cannot pass merely because nothing rendered.
    const baseline = await page.evaluate(() =>
      (window as HarnessWindow).__mobileMapIntegrationHarness!.getOverlayMarkerCount(),
    );
    expect(baseline).toBeGreaterThan(0);
    expect(baseline).toBeLessThan(DESKTOP_TOTAL);

    await page.evaluate(
      (perFeed) =>
        (window as HarnessWindow).__mobileMapIntegrationHarness!.seedOverlayMarkerStress(perFeed),
      STRESS_PER_FEED,
    );

    // Each setter triggers its own render() and render() is rate-limited, so the
    // three seeded feeds land over successive passes. Wait for the settled state
    // — all three present — before asserting the ceiling, or the assertion could
    // pass on a pass that simply had not rendered the later feeds yet.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const harness = (window as HarnessWindow).__mobileMapIntegrationHarness!;
            return (
              harness.getOverlayMarkerClassCount('.military-vessel-marker') > 0 &&
              harness.getOverlayMarkerClassCount('.military-flight-marker') > 0 &&
              harness.getOverlayMarkerClassCount('.earthquake-marker') > 0
            );
          }),
        { timeout: 15000 },
      )
      .toBe(true);

    const state = await page.evaluate(() =>
      (window as HarnessWindow).__mobileMapIntegrationHarness!.getOverlayBudgetState(),
    );
    const counts = await page.evaluate(() => {
      const harness = (window as HarnessWindow).__mobileMapIntegrationHarness!;
      return {
        overlayChildren: harness.getOverlayMarkerCount(),
        vessels: harness.getOverlayMarkerClassCount('.military-vessel-marker'),
        flights: harness.getOverlayMarkerClassCount('.military-flight-marker'),
        quakes: harness.getOverlayMarkerClassCount('.earthquake-marker'),
      };
    });

    // 6,000 seeded markers (3 feeds x 2,000) must not become 6,000 DOM markers.
    expect(counts.vessels + counts.flights + counts.quakes).toBeLessThanOrEqual(DESKTOP_TOTAL);
    // Hotspots are budgeted too, so the whole overlay — not just the seeded
    // feeds — sits under the total.
    expect(counts.overlayChildren).toBeLessThanOrEqual(DESKTOP_TOTAL);
    expect(state.rendered).toBeLessThanOrEqual(DESKTOP_TOTAL);

    // Per-group ceiling, and the fair share must actually be handed out rather
    // than one feed eating the whole total.
    expect(counts.vessels).toBeLessThanOrEqual(DESKTOP_PER_LAYER);
    expect(counts.flights).toBeLessThanOrEqual(DESKTOP_PER_LAYER);
    expect(counts.quakes).toBeLessThanOrEqual(DESKTOP_PER_LAYER);
    expect(counts.vessels).toBeGreaterThan(0);
    expect(counts.flights).toBeGreaterThan(0);
    expect(counts.quakes).toBeGreaterThan(0);

    // Withholding is disclosed, not silent.
    expect(state.truncated.military?.total).toBe(STRESS_PER_FEED * 2);
    expect(state.truncated.military?.shown).toBeLessThan(STRESS_PER_FEED * 2);
    expect(state.truncated.natural?.total).toBe(STRESS_PER_FEED);

    const badge = page.locator('.layer-toggle-row[data-layer="military"] .layer-truncation-count');
    await expect(badge).toHaveText(`${state.truncated.military!.shown}/${state.truncated.military!.total}`);

    expect(pageErrors).toEqual([]);
  });

  test('keeps the highest-magnitude earthquakes when the natural feed is cut', async ({ page }) => {
    await page.goto('/tests/mobile-map-integration-harness.html');
    await expect
      .poll(
        async () =>
          page.evaluate(() => Boolean((window as HarnessWindow).__mobileMapIntegrationHarness?.ready)),
        { timeout: 30000 },
      )
      .toBe(true);

    await page.evaluate(
      (perFeed) =>
        (window as HarnessWindow).__mobileMapIntegrationHarness!.seedOverlayMarkerStress(perFeed),
      STRESS_PER_FEED,
    );
    await expect
      .poll(
        async () =>
          page.evaluate(() =>
            (window as HarnessWindow).__mobileMapIntegrationHarness!.getOverlayMarkerClassCount(
              '.earthquake-marker',
            ),
          ),
        { timeout: 15000 },
      )
      .toBeGreaterThan(0);
    // The cut only happens once the feed is over the fair share, which is what
    // makes the magnitude assertion below meaningful rather than vacuous.
    const naturalTruncation = await page.evaluate(
      () =>
        (window as HarnessWindow).__mobileMapIntegrationHarness!.getOverlayBudgetState().truncated
          .natural,
    );
    expect(naturalTruncation?.total).toBe(STRESS_PER_FEED);
    expect(naturalTruncation!.shown).toBeLessThan(STRESS_PER_FEED);

    // The seed spreads magnitudes 1.0-6.9 across the feed. A cut that fell on
    // raw feed order would keep magnitude 1.0 markers; ranking by magnitude must
    // not. `.earthquake-marker` carries its magnitude in the title text.
    const titles = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#mapOverlays .earthquake-marker')).map(
        (element) => (element as HTMLElement).title,
      ),
    );
    expect(titles.length).toBeGreaterThan(0);
    const magnitudes = titles
      .map((title) => Number(/M\s*([0-9.]+)/.exec(title)?.[1] ?? Number.NaN))
      .filter((value) => Number.isFinite(value));
    expect(magnitudes.length).toBeGreaterThan(0);
    expect(Math.min(...magnitudes)).toBeGreaterThan(1.5);
  });
  test('budgets the time-filtered slice, not the whole feed', async ({ page }) => {
    await page.goto('/tests/mobile-map-integration-harness.html');
    await expect
      .poll(
        async () =>
          page.evaluate(() => Boolean((window as HarnessWindow).__mobileMapIntegrationHarness?.ready)),
        { timeout: 30000 },
      )
      .toBe(true);

    // 40 recent low-magnitude events behind 2,000 stale high-magnitude ones.
    // The render loop only draws the 40; a budget planned over the unfiltered
    // 2,040 would rank the stale ones first, spend its whole share on them and
    // draw a handful of the 40 — or none.
    const RECENT = 40;
    await page.evaluate(
      (recent) =>
        (window as HarnessWindow).__mobileMapIntegrationHarness!.seedTimeFilteredEarthquakes(
          recent,
          2000,
        ),
      RECENT,
    );

    await expect
      .poll(
        async () =>
          page.evaluate(() =>
            (window as HarnessWindow).__mobileMapIntegrationHarness!.getOverlayMarkerClassCount(
              '.earthquake-marker',
            ),
          ),
        { timeout: 15000 },
      )
      .toBe(RECENT);

    // Nothing was withheld: 40 in-window events sit well under the per-group cap.
    const state = await page.evaluate(() =>
      (window as HarnessWindow).__mobileMapIntegrationHarness!.getOverlayBudgetState(),
    );
    expect(state.truncated.natural).toBeUndefined();
  });
});
