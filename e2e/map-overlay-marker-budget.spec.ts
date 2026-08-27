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
// MAP_OVERLAY_MARKER_BUDGET_MOBILE — the branch `isMobile` selects.
const MOBILE_TOTAL = 400;
const MOBILE_PER_LAYER = 150;
// MapComponent.MAX_CONCURRENT_MAP_FLASHES — news flashes are overlay children
// created outside the marker budget, so they carry their own ceiling.
const MAX_CONCURRENT_FLASHES = 12;
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

// #7145 — a drag must cost O(1) overlay rebuilds, not one per pointer event.
// `applyTransform()` runs on every `mousemove`, so a real gesture is many events
// spread over wall-clock time. Spacing the steps is load-bearing in BOTH
// directions, and getting either wrong makes the test worthless:
//
//   too fast — a single `page.mouse.move(x, y, { steps })` dispatches its steps
//   back-to-back inside one frame, where `scheduleRender()`'s own coalescing
//   collapses even a per-event rebuild to one and the regression is invisible;
//
//   too slow — any gap longer than OVERLAY_BUDGET_REPLAN_SETTLE_MS fires the
//   debounce mid-drag, which is correct behaviour but costs an extra rebuild.
//
// So the steps are timed from INSIDE the page (see dragMapAcross), not from the
// test process. Measured on CI at 4 workers: driving them over CDP round-trips
// produced 5 and 8 rebuilds on a correct tree, because a round-trip under load
// routinely exceeds the 200 ms window. Page-side timing does not have that
// problem on the fixed tree, where the drag leaves the main thread idle — a pan
// is a pure CSS transform with no DOM work. It is only the regression that makes
// the main thread busy, and there the rebuild count is set by
// MIN_RENDER_INTERVAL_MS rather than by the gaps, so the separation holds.
const DRAG_MOVE_STEPS = 24;
const DRAG_STEP_INTERVAL_MS = 60;
const DRAG_STEP_DX = 10;
const DRAG_STEP_DY = 5;
// Left of centre in the harness viewport, clear of the control rail, legend and
// time slider that `shouldIgnoreInteractionStart` refuses to start a drag from.
const DRAG_ORIGIN = { x: 300, y: 400 };
// MapComponent.OVERLAY_BUDGET_REPLAN_SETTLE_MS.
const REPLAN_SETTLE_MS = 200;
// MapComponent.MARKER_SETTLE_MS — how long after the last overlay rebuild the
// wrapper gets `.markers-settled` and the marker pulses stop (#4669).
const MARKER_SETTLE_MS = 6000;
// Measured with the page-side drag above: 1 rebuild for the whole gesture on the
// fixed tree, 15 with the replan called straight off the interaction path (the
// bug costs one rebuild per MIN_RENDER_INTERVAL_MS of gesture, so it scales with
// drag duration). The slack covers a runner starving the page long enough for one
// or two step gaps to overshoot the 200 ms settle and split the coalesced rebuild;
// it is nowhere near the mutant, so this ceiling is not a near-miss on the
// regression it exists to catch. Raising it to cover a flake would be — if this
// ever needs more than 3, the step timing is wrong, not the ceiling.
const MAX_DRAG_REBUILDS = 3;

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
  /** Overlay rebuild count, for the duplicate-rebuild assertion. */
  renders: number;
};

type HarnessWindow = Window & {
  __mobileMapIntegrationHarness?: {
    ready: boolean;
    getWrapperTransform: () => string;
    seedOverlayMarkerStress: (perFeed: number) => void;
    seedOverlayViewportStress: (count: number) => void;
    setOverlayViewport: (lat: number, lon: number) => void;
    setOverlayZoom: (zoom: number) => void;
    seedTimeFilteredEarthquakes: (recent: number, stale: number) => void;
    getOverlayMarkerCount: () => number;
    getOverlayMarkerClassCount: (selector: string) => number;
    getOverlayPositionSignature: (selector: string) => string;
    seedWeatherAlerts: (withCentroid: number, withoutCentroid: number) => void;
    forceRender: () => void;
    burstFlashes: (count: number) => void;
    clearOverlayFeeds: () => void;
    getActiveFlashCount: () => number;
    getFlashNodeCount: () => number;
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

/** Ready-gated harness boot, shared by the #7145 interaction tests. */
async function openOverlayHarness(page: Page): Promise<void> {
  await page.goto('/tests/mobile-map-integration-harness.html');
  await expect
    .poll(
      async () =>
        page.evaluate(() => Boolean((window as HarnessWindow).__mobileMapIntegrationHarness?.ready)),
      { timeout: 30000 },
    )
    .toBe(true);
}

async function readOverlayBudget(page: Page): Promise<BudgetState> {
  return page.evaluate(() =>
    (window as HarnessWindow).__mobileMapIntegrationHarness!.getOverlayBudgetState(),
  );
}

async function readWrapperTransform(page: Page): Promise<string> {
  return page.evaluate(() =>
    (window as HarnessWindow).__mobileMapIntegrationHarness!.getWrapperTransform(),
  );
}

/**
 * A pointer drag: one `mousemove` per step, spaced in wall-clock time, so
 * `applyTransform()` runs once per event across many frames — the only shape in
 * which an O(N) replan is distinguishable from an O(1) one.
 *
 * The press and release are real CDP input; neither is timing-sensitive. The
 * moves are dispatched and timed inside the page instead, because the test
 * process cannot time them reliably: a CDP round-trip on a loaded CI runner
 * overshoots the 200 ms settle window, firing the debounce mid-drag and inflating
 * a correct tree's rebuild count (measured: 5, then 8, at 4 workers). The map
 * listens for `mousemove` on `document`, so a dispatched event reaches exactly
 * the same handler and the same `applyTransform()` call as a driven one.
 *
 * Returns how many steps observed the wrapper WITHOUT `.markers-settled`. The
 * sample is taken in the page, immediately before each move is dispatched, so it
 * reads the state ~one interval after the previous move — late enough for that
 * move's rebuild to have landed, and with no CDP round-trip to race the 200 ms
 * settle timer. Sampling here, rather than counting class transitions from a
 * MutationObserver, is deliberate: `armMarkerSettle()` strips the class on every
 * rebuild but only re-adds it MARKER_SETTLE_MS later, so under a per-event
 * rebuild the class goes absent once and stays absent — a transition counter
 * saturates at 1 and cannot tell one rebuild from twenty.
 */
async function dragMapAcross(page: Page): Promise<{ stepsUnsettled: number }> {
  await page.mouse.move(DRAG_ORIGIN.x, DRAG_ORIGIN.y);
  await page.mouse.down();
  const stepsUnsettled = await page.evaluate(
    ({ origin, steps, intervalMs, dx, dy }) =>
      new Promise<number>((resolve, reject) => {
        const wrapper = document.querySelector('.map-wrapper');
        if (!wrapper) {
          reject(new Error('Missing .map-wrapper to sample marker settle state'));
          return;
        }
        let step = 0;
        let unsettled = 0;
        const tick = (): void => {
          if (!wrapper.classList.contains('markers-settled')) unsettled += 1;
          step += 1;
          document.dispatchEvent(
            new MouseEvent('mousemove', {
              bubbles: true,
              clientX: origin.x + step * dx,
              clientY: origin.y + step * dy,
            }),
          );
          if (step >= steps) {
            setTimeout(() => {
              if (!wrapper.classList.contains('markers-settled')) unsettled += 1;
              resolve(unsettled);
            }, intervalMs);
          } else setTimeout(tick, intervalMs);
        };
        setTimeout(tick, intervalMs);
      }),
    {
      origin: DRAG_ORIGIN,
      steps: DRAG_MOVE_STEPS,
      intervalMs: DRAG_STEP_INTERVAL_MS,
      dx: DRAG_STEP_DX,
      dy: DRAG_STEP_DY,
    },
  );
  await page.mouse.up();
  return { stepsUnsettled };
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

  test('applies the tighter mobile ceiling when the renderer is on its mobile branch', async ({ page }) => {
    // The desktop tests above all run `isMobile: false`, so without this the
    // mobile budget constant is referenced by the code and asserted by nothing.
    await page.goto('/tests/mobile-map-integration-harness.html?mobile=1');
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
          page.evaluate(() => {
            const harness = (window as HarnessWindow).__mobileMapIntegrationHarness!;
            return (
              harness.getOverlayMarkerClassCount('.military-vessel-marker') > 0 &&
              harness.getOverlayMarkerClassCount('.military-flight-marker') > 0
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
      };
    });

    // The mobile ceilings, and — the point of the test — NOT the desktop ones:
    // a component that ignored isMobile would sit under 800/300 and pass every
    // assertion that only bounded from above by the desktop numbers.
    expect(state.rendered).toBeLessThanOrEqual(MOBILE_TOTAL);
    expect(counts.overlayChildren).toBeLessThanOrEqual(MOBILE_TOTAL);
    expect(counts.vessels).toBeLessThanOrEqual(MOBILE_PER_LAYER);
    expect(counts.flights).toBeLessThanOrEqual(MOBILE_PER_LAYER);
    expect(counts.vessels).toBeGreaterThan(0);
    expect(counts.flights).toBeGreaterThan(0);
    // Strictly tighter than desktop would have been on the same seed, so this
    // cannot pass with the desktop budget selected.
    expect(counts.vessels + counts.flights).toBeGreaterThan(MOBILE_TOTAL / 4);
    expect(counts.vessels + counts.flights).toBeLessThan(DESKTOP_TOTAL);
    expect(state.undisclosed).toEqual([]);
  });

  test('does not budget weather alerts that can never be drawn', async ({ page }) => {
    await page.goto('/tests/mobile-map-integration-harness.html');
    await expect
      .poll(
        async () =>
          page.evaluate(() => Boolean((window as HarnessWindow).__mobileMapIntegrationHarness?.ready)),
        { timeout: 30000 },
      )
      .toBe(true);

    // 400 renderable alerts past the 300 per-layer cap, behind 1,000 that have no
    // `centroid`. The render loop can only ever draw the 400.
    const RENDERABLE = 400;
    await page.evaluate(
      (renderable) =>
        (window as HarnessWindow).__mobileMapIntegrationHarness!.seedWeatherAlerts(renderable, 1000),
      RENDERABLE,
    );

    await expect
      .poll(
        async () =>
          page.evaluate(() =>
            (window as HarnessWindow).__mobileMapIntegrationHarness!.getOverlayMarkerClassCount(
              '.weather-marker',
            ),
          ),
        { timeout: 15000 },
      )
      .toBeGreaterThan(0);

    const state = await page.evaluate(() =>
      (window as HarnessWindow).__mobileMapIntegrationHarness!.getOverlayBudgetState(),
    );

    // The badge must count what was renderable, not what arrived. Budgeting the
    // raw feed would report 1,400 here and tell the user 300/1400 when 1,000 of
    // those were never going to appear under any budget.
    expect(state.truncated.weather?.total).toBe(RENDERABLE);
    expect(state.truncated.weather?.shown).toBe(DESKTOP_PER_LAYER);
  });

  test('does not rebuild again when another render already re-planned the new view', async ({ page }) => {
    await page.goto('/tests/mobile-map-integration-harness.html');
    await expect
      .poll(
        async () =>
          page.evaluate(() => Boolean((window as HarnessWindow).__mobileMapIntegrationHarness?.ready)),
        { timeout: 30000 },
      )
      .toBe(true);

    // Truncation must exist, or the replan is skipped outright and this passes
    // for the wrong reason.
    await page.evaluate(
      (count) =>
        (window as HarnessWindow).__mobileMapIntegrationHarness!.seedOverlayViewportStress(count),
      2000,
    );
    await expect
      .poll(
        async () =>
          page.evaluate(() =>
            Object.keys(
              (window as HarnessWindow).__mobileMapIntegrationHarness!.getOverlayBudgetState()
                .truncated,
            ).length,
          ),
        { timeout: 15000 },
      )
      .toBeGreaterThan(0);
    await page.waitForTimeout(1200);

    const before = await page.evaluate(() =>
      (window as HarnessWindow).__mobileMapIntegrationHarness!.getOverlayBudgetState().renders,
    );
    expect(before).toBeGreaterThan(0);

    // Pan (starts the settle timer), then land a render inside the settle window
    // — which is what production does constantly, since every data setter calls
    // render(). That render re-plans for the new viewport, so by the time the
    // timer fires the plan is no longer stale and a rebuild cannot change a
    // marker. A timer that fires unconditionally rebuilds the whole dynamic
    // layer a second time for a viewport it already planned.
    await page.evaluate(() => {
      const harness = (window as HarnessWindow).__mobileMapIntegrationHarness!;
      harness.setOverlayViewport(-30, 60);
      harness.forceRender();
    });

    await page.waitForTimeout(2500);
    const after = await page.evaluate(() =>
      (window as HarnessWindow).__mobileMapIntegrationHarness!.getOverlayBudgetState().renders,
    );

    // Exactly one rebuild for the new viewport — the one the in-window render
    // already performed.
    expect(after).toBe(before + 1);
  });

  test('coalesces a pointer drag into one overlay rebuild, not one per move event', async ({ page }) => {
    // #7145. #7134 moved the budget replan off the interaction path and behind a
    // settle debounce; nothing asserted the property it exists for. Before it,
    // `applyTransform()` called `scheduleRender()` directly from every
    // `mousemove`/`touchmove`/`wheel` and every touch-inertia frame, so a
    // one-second drag ran roughly ten full `renderDynamicLayers()` passes — each
    // wiping and rebuilding cables, pipelines, conflicts, AIS density, clusters
    // and every overlay marker with a fresh `click` listener — where a pan had
    // been a pure CSS transform with no DOM work at all.
    await openOverlayHarness(page);

    // Truncation must be live, or `overlayBudgetPlanIsStale()` short-circuits on
    // its truncation guard and the drag is free for a reason this test is not
    // measuring. (That guard has its own test below.)
    await page.evaluate(
      (count) =>
        (window as HarnessWindow).__mobileMapIntegrationHarness!.seedOverlayViewportStress(count),
      STRESS_PER_FEED,
    );
    await expect
      .poll(async () => Object.keys((await readOverlayBudget(page)).truncated).length, {
        timeout: 15000,
      })
      .toBeGreaterThan(0);

    // Let the seed render's marker pulse expire first. That both quiesces the
    // render counter and puts the wrapper in the settled state, so every
    // un-settle counted below belongs to the gesture.
    await expect(page.locator('.map-wrapper')).toHaveClass(/markers-settled/, {
      timeout: MARKER_SETTLE_MS + 4000,
    });

    const before = (await readOverlayBudget(page)).renders;
    expect(before).toBeGreaterThan(0);
    const transformBefore = await readWrapperTransform(page);

    const { stepsUnsettled } = await dragMapAcross(page);
    await page.waitForTimeout(REPLAN_SETTLE_MS + 1500);

    // Positive control. A drag that never reached the map's `mousedown` handler —
    // wrong coordinates, a control swallowing the press — would satisfy every
    // count below by doing nothing at all.
    expect(await readWrapperTransform(page)).not.toBe(transformBefore);

    const rebuilds = (await readOverlayBudget(page)).renders - before;
    // The load-bearing pair, and the reason this asserts a COUNT rather than that
    // "a rebuild happened": a per-frame rebuild satisfies the second. The lower
    // bound keeps the settle replan alive — a build that simply stopped
    // re-planning would meet the ceiling by never rebuilding, leaving the
    // pre-gesture view's nearest markers on screen for good.
    expect(rebuilds).toBeGreaterThanOrEqual(1);
    expect(rebuilds).toBeLessThanOrEqual(MAX_DRAG_REBUILDS);

    // The `armMarkerSettle()` half, in the DOM the user actually sees. The
    // wrapper entered the drag settled and no rebuild happens until the gesture
    // ends, so every in-gesture sample must still see `.markers-settled`. Under
    // the regression the first rebuild strips it within ~100 ms and it stays
    // stripped for the rest of the drag — every marker held in the infinite-pulse
    // state, and its compositing layer with it (#4669) — so this reads ~24.
    //
    // Strict 0, with no slack: a mid-drag rebuild is exactly the thing being
    // ruled out. It shares the failure mode of MAX_DRAG_REBUILDS above — a runner
    // that stalls a step gap past the 200 ms settle breaks both — and the remedy
    // is the same one, fix the step timing rather than widen the tolerance.
    expect(stepsUnsettled).toBe(0);

    // ...and the pulse is released again once that single rebuild lands, rather
    // than being re-armed indefinitely. The window is MARKER_SETTLE_MS measured
    // from the settle-debounced rebuild, not from the end of the drag.
    await expect(page.locator('.map-wrapper')).toHaveClass(/markers-settled/, {
      timeout: MARKER_SETTLE_MS + REPLAN_SETTLE_MS + 4000,
    });
  });

  test('does not rebuild the overlay at all when a drag pans a view with nothing truncated', async ({ page }) => {
    // #7145, the other half. `overlayBudgetPlanIsStale()` requires truncation
    // before it will call a moved viewport stale. It reads like a redundant fast
    // path, which makes it the easier of the two edits to lose: drop it and every
    // pan ends in a full `renderDynamicLayers()` pass that cannot change a single
    // marker, because with nothing withheld the selection is view-independent.
    await openOverlayHarness(page);

    // No stress seed — the harness's own feed is a single hotspot, far inside the
    // budget. Wait out the settle so the render counter is quiescent before the
    // baseline is taken.
    await expect(page.locator('.map-wrapper')).toHaveClass(/markers-settled/, {
      timeout: MARKER_SETTLE_MS + 4000,
    });

    const before = await readOverlayBudget(page);
    expect(before.renders).toBeGreaterThan(0);
    expect(Object.keys(before.truncated)).toEqual([]);
    const transformBefore = await readWrapperTransform(page);

    await dragMapAcross(page);
    await page.waitForTimeout(REPLAN_SETTLE_MS + 1500);

    expect(await readWrapperTransform(page)).not.toBe(transformBefore);
    expect((await readOverlayBudget(page)).renders).toBe(before.renders);
  });

  test('reports every trimmed layer as undisclosed when the map has no toggle rail', async ({ page }) => {
    // The embed surface: src/embed/panels/map.ts builds MapContainer with
    // `chrome: false`, so no #layerToggles rail is ever created and no
    // `shown/total` badge has anywhere to go.
    await page.goto('/tests/mobile-map-integration-harness.html?chrome=0');
    await expect
      .poll(
        async () =>
          page.evaluate(() => Boolean((window as HarnessWindow).__mobileMapIntegrationHarness?.ready)),
        { timeout: 30000 },
      )
      .toBe(true);

    await expect(page.locator('#layerToggles')).toHaveCount(0);

    await page.evaluate(
      (perFeed) =>
        (window as HarnessWindow).__mobileMapIntegrationHarness!.seedOverlayMarkerStress(perFeed),
      STRESS_PER_FEED,
    );
    await expect
      .poll(
        async () =>
          page.evaluate(() =>
            Object.keys(
              (window as HarnessWindow).__mobileMapIntegrationHarness!.getOverlayBudgetState()
                .truncated,
            ).length,
          ),
        { timeout: 15000 },
      )
      .toBeGreaterThan(0);

    const state = await page.evaluate(() =>
      (window as HarnessWindow).__mobileMapIntegrationHarness!.getOverlayBudgetState(),
    );

    // The markers ARE capped here — that part works. What must not happen is the
    // budget state claiming the cut was disclosed: with no rail, every trimmed
    // layer is undisclosed, and an empty array would report full disclosure while
    // the embed silently withholds markers.
    expect(Object.keys(state.truncated).length).toBeGreaterThan(0);
    expect(state.undisclosed.sort()).toEqual(Object.keys(state.truncated).sort());
    expect(state.rendered).toBeLessThanOrEqual(DESKTOP_TOTAL);

    // Honest private state is necessary but not sufficient: the person looking at
    // the embed must be able to SEE that the map is partial. With no toggle rail
    // to badge, the compact summary is the only disclosure surface there is.
    const summary = page.locator('.map-truncation-summary');
    await expect(summary).toHaveCount(1);
    const shown = Object.values(state.truncated).reduce((sum, counts) => sum + counts.shown, 0);
    const total = Object.values(state.truncated).reduce((sum, counts) => sum + counts.total, 0);
    await expect(summary).toHaveText(`${shown}/${total} markers`);
    expect(shown).toBeLessThan(total);
    await expect(summary).toBeVisible();

    // Idempotent: another render must update the one node, not append a second.
    await page.evaluate(() => (window as HarnessWindow).__mobileMapIntegrationHarness!.forceRender());
    await expect(summary).toHaveCount(1);

    // ...and it must disappear once nothing is being withheld, rather than
    // stranding a stale count over a complete map.
    await page.evaluate(() =>
      (window as HarnessWindow).__mobileMapIntegrationHarness!.clearOverlayFeeds(),
    );
    await expect(page.locator('.map-truncation-summary')).toHaveCount(0);
  });

  test('bounds concurrent news flashes, which are overlay children outside the budget', async ({ page }) => {
    await page.goto('/tests/mobile-map-integration-harness.html');
    await expect
      .poll(
        async () =>
          page.evaluate(() => Boolean((window as HarnessWindow).__mobileMapIntegrationHarness?.ready)),
        { timeout: 30000 },
      )
      .toBe(true);

    // A full overlay first, so this measures the composed DOM the ceiling claim
    // is about rather than flashes on an empty map.
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
              '.military-vessel-marker',
            ),
          ),
        { timeout: 15000 },
      )
      .toBeGreaterThan(0);

    // 300 flashes with a long duration, so none expire mid-measurement — the
    // burst shape flashMapForNews() actually produces on load. Burst and measure
    // in ONE evaluate: renderOverlays() clears #mapOverlays wholesale, so a render
    // landing between the two would empty the flashes and make this pass for a
    // reason that has nothing to do with the ceiling.
    const flashes = await page.evaluate((count) => {
      const harness = (window as HarnessWindow).__mobileMapIntegrationHarness!;
      harness.burstFlashes(count);
      return {
        active: harness.getActiveFlashCount(),
        nodes: harness.getFlashNodeCount(),
        overlayChildren: harness.getOverlayMarkerCount(),
      };
    }, 300);

    // EXACTLY the cap, not `<=`. Every assertion here is satisfied by zero —
    // 0 <= 12, 0 === 0, and 0 is under the overlay ceiling — so a flashLocation()
    // that early-returned on every call (no container size, unprojectable point)
    // would have made this test green while creating no flashes at all. 300 calls
    // with valid coordinates must leave the ceiling exactly full.
    expect(flashes.active).toBe(MAX_CONCURRENT_FLASHES);
    // The evicted ones must actually leave the DOM, not just the bookkeeping.
    expect(flashes.nodes).toBe(MAX_CONCURRENT_FLASHES);
    // The composed ceiling: budgeted markers plus the bounded flash exemption.
    expect(flashes.overlayChildren).toBeLessThanOrEqual(DESKTOP_TOTAL + MAX_CONCURRENT_FLASHES);
    // ...and the flashes really are on top of a full overlay, so this measures the
    // composed DOM rather than flashes on an empty map.
    expect(flashes.overlayChildren).toBeGreaterThan(MAX_CONCURRENT_FLASHES);
  });

  test('clears live flash timers and nodes when the map is destroyed', async ({ page }) => {
    await page.goto('/tests/mobile-map-integration-harness.html');
    await expect
      .poll(
        async () =>
          page.evaluate(() => Boolean((window as HarnessWindow).__mobileMapIntegrationHarness?.ready)),
        { timeout: 30000 },
      )
      .toBe(true);

    // Long-duration flashes so they are unambiguously still live at teardown —
    // otherwise natural expiry, not destroy(), would be what cleared them.
    const before = await page.evaluate(() => {
      const harness = (window as HarnessWindow).__mobileMapIntegrationHarness!;
      harness.burstFlashes(5);
      return { active: harness.getActiveFlashCount(), nodes: harness.getFlashNodeCount() };
    });

    // Active precondition: without this the assertions below pass on a map that
    // never had a flash to clear.
    expect(before.active).toBe(5);
    expect(before.nodes).toBe(5);

    const after = await page.evaluate(() => {
      const harness = (window as HarnessWindow).__mobileMapIntegrationHarness!;
      harness.destroyMap();
      return { active: harness.getActiveFlashCount(), nodes: harness.getFlashNodeCount() };
    });

    // destroy() must clear the tracking AND remove the nodes. A leaked expiry
    // timer would later fire `flash.remove()` against a torn-down instance, and
    // leaked nodes outlive the renderer that owns them.
    expect(after.active).toBe(0);
    expect(after.nodes).toBe(0);
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
