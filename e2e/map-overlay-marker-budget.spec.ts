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
// Where the pan/zoom test asks the map to look. Nothing special about it beyond
// being far from the default centre in both axes.
const VIEW_TARGET = { lat: -55, lon: 125 };
// The 300 survivors of 2,000 globe-spread markers, ranked by nearness, sit well
// inside this. Thresholds are deliberately loose against the measured values
// (kept mean ~30 deg vs seeded mean ~95 deg) so the test pins the BEHAVIOUR —
// survivors cluster on the requested centre — not a fixed spiral layout.
const VIEW_CENTRED_MAX_MEAN_DEGREES = 55;
const VIEW_CENTRED_MEAN_RATIO = 0.65;
const VIEW_CENTRED_MAX_WORST_DEGREES = 110;

type Coord = { lat: number; lon: number };

/** Great-circle separation in degrees. Mirrors what proximityRank orders by. */
function angularDistanceDegrees(a: Coord, b: Coord): number {
  const rad = Math.PI / 180;
  const cos =
    Math.sin(a.lat * rad) * Math.sin(b.lat * rad) +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((a.lon - b.lon) * rad);
  return Math.acos(Math.min(1, Math.max(-1, cos))) / rad;
}

function meanAngularDistance(points: Coord[], focus: Coord): number {
  return points.reduce((sum, point) => sum + angularDistanceDegrees(point, focus), 0) / points.length;
}

type BudgetState = {
  rendered: number;
  truncated: Record<string, { shown: number; total: number }>;
  /** Trimmed layers with no toggle row to disclose the cut on; see #7112. */
  undisclosed: string[];
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
    getKeptHotspotCoords: () => Coord[];
    getSeededHotspotCoords: () => Coord[];
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
    // Three sequential COLD dashboard boots, each with its own 2s settle. On a
    // loaded CI box that runs past 90s for reasons unrelated to what is being
    // measured, so the budget is sized to the work rather than to a fast machine.
    test.setTimeout(240000);
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

    // A general /dashboard DOM guardrail, NOT the #7112 acceptance evidence.
    // installLocalOnlyNetwork() aborts every off-origin request, so the live
    // feeds that produced the 2,088-marker measurement never arrive and these
    // ceilings would hold with the overlay budget deleted. The budget's teeth
    // are in the harness tests below, which seed the feeds directly.
    //
    // What this test does buy: the whole real document (not just the overlay
    // root) stays inside the production guardrail from the issue investigation,
    // and repeated fresh contexts catch cold-load drift.
    expect(Math.max(...domNodes)).toBeLessThanOrEqual(DASHBOARD_MAX_DOM_NODES);
    expect(Math.max(...rendererNodes)).toBeLessThanOrEqual(DASHBOARD_MAX_RENDERER_NODES);
    expect(Math.max(...listeners)).toBeLessThanOrEqual(DASHBOARD_MAX_LISTENERS);

    // Ceilings only — the run-to-run RANGE of these counters is deliberately not
    // asserted. `Performance.getMetrics()` reports Nodes and JSEventListeners
    // renderer-wide INCLUDING detached objects still awaiting GC (the same fact
    // that explains this issue's ~11-bytes-per-node puzzle), so a range assertion
    // is really an assertion about when the collector ran. Measured: the previous
    // tolerances failed on an unmodified tree in consecutive runs — document-node
    // range 999 against a 500 cap, renderer-node range 2813 against 2000 — so they
    // reported GC timing as a regression. The ceilings above hold across the same
    // runs and are what the guardrail is actually for.
  });

  test('re-ranks the kept markers onto the new view centre after a pan and zoom', async ({ page }) => {
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

    // Zoom BEFORE panning. The wrong inverse transform this test exists to catch
    // (`width / (2 * zoom) - pan.x`) is identical to the right one at zoom 1, so
    // an assertion made at the default zoom cannot see it.
    await page.evaluate(() =>
      (window as HarnessWindow).__mobileMapIntegrationHarness!.setOverlayZoom(4),
    );
    await page.evaluate(
      (target) =>
        (window as HarnessWindow).__mobileMapIntegrationHarness!.setOverlayViewport(
          target.lat,
          target.lon,
        ),
      VIEW_TARGET,
    );

    // The re-plan is debounced to the settle (OVERLAY_BUDGET_REPLAN_SETTLE_MS),
    // so poll rather than reading once.
    await expect
      .poll(
        async () => {
          const kept = await page.evaluate(() =>
            (window as HarnessWindow).__mobileMapIntegrationHarness!.getKeptHotspotCoords(),
          );
          return kept.length > 0 ? meanAngularDistance(kept, VIEW_TARGET) : Number.POSITIVE_INFINITY;
        },
        { timeout: 20000 },
      )
      .toBeLessThan(VIEW_CENTRED_MAX_MEAN_DEGREES);

    const kept = await page.evaluate(() =>
      (window as HarnessWindow).__mobileMapIntegrationHarness!.getKeptHotspotCoords(),
    );
    const seeded = await page.evaluate(() =>
      (window as HarnessWindow).__mobileMapIntegrationHarness!.getSeededHotspotCoords(),
    );

    expect(kept.length).toBe(DESKTOP_PER_LAYER);
    expect(seeded.length).toBeGreaterThan(kept.length);

    // The load-bearing assertion: the survivors are the ones NEAR the requested
    // centre, not merely a different subset than before. A centre computed from
    // the wrong inverse transform still changes the set on every pan and zoom —
    // it just clusters it on a point the user is not looking at — so "the
    // signature changed" is satisfied by the bug and cannot stand in for this.
    const keptMean = meanAngularDistance(kept, VIEW_TARGET);
    const seededMean = meanAngularDistance(seeded, VIEW_TARGET);
    expect(keptMean).toBeLessThan(seededMean * VIEW_CENTRED_MEAN_RATIO);

    // And no survivor is far from the view: a cut ranked on the wrong centre
    // keeps its own near neighbours, which are this centre's far ones.
    const worst = Math.max(...kept.map((spot) => angularDistanceDegrees(spot, VIEW_TARGET)));
    expect(worst).toBeLessThan(VIEW_CENTRED_MAX_WORST_DEGREES);
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
    // Every trimmed layer must have a toggle row to show its count on. A layer
    // reported here was cut with nowhere to disclose it, which is
    // indistinguishable from missing data for the user (#7112).
    expect(state.undisclosed).toEqual([]);

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
