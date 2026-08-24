import { expect, test } from '@playwright/test';

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

type BudgetState = {
  rendered: number;
  truncated: Record<string, { shown: number; total: number }>;
};

type HarnessWindow = Window & {
  __mobileMapIntegrationHarness?: {
    ready: boolean;
    seedOverlayMarkerStress: (perFeed: number) => void;
    getOverlayMarkerCount: () => number;
    getOverlayMarkerClassCount: (selector: string) => number;
    getOverlayBudgetState: () => BudgetState;
  };
};

test.describe('SVG map overlay marker budget (#7112)', () => {
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
});
