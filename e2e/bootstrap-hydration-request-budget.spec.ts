import { expect, test, type Page } from '@playwright/test';

import {
  ENERGY_BOOTSTRAP_DATA,
  ENERGY_KEYS,
  requestedKeys,
  waitForStartup,
} from './bootstrap-request-budget-fixtures';

// ---------------------------------------------------------------------------
// #7045 U5 — prove the transfer work removed requests rather than data.
//
// U2 (#7048) is pinned at the service level by tests/bootstrap-hydration-reuse
// .test.mts. That harness stubs `globalThis.fetch` around esbuild-bundled
// services, so it proves the breaker/handoff contract but never proves that the
// real dashboard reaches those loaders twice, nor that the accepted value
// reaches the DOM. This block closes both gaps in a browser: a complete tier
// pair, a genuine post-startup hydration re-trigger, a request budget of zero,
// and a rendered record from the hydrated payload.
//
// The no-hydration control test below is load-bearing. Without it "zero
// requests" is satisfied just as well by a page whose loaders never ran — the
// exact false green a request counter produces in local dev, where the RPC
// routes 404 and the circuit breaker opens before `fetch` is ever reached.
// Every dataset here is served through `page.route`, so the control arm proves
// each counter can move before the hydrated arm asserts it did not.
// ---------------------------------------------------------------------------

/** Fixtures mirror tests/bootstrap-hydration-reuse.test.mts so both layers
 * accept and reject the same shapes. Changing one without the other would let a
 * value this suite calls accepted be rejected by the service itself. */
const NATURAL_EVENT = {
  id: 'eonet-EONET_1', title: 'Browser Storm Alpha', category: 'severeStorms',
  categoryTitle: 'Severe Storms', lat: 12.5, lon: -70.1,
  date: '2026-08-01T00:00:00Z', closed: false,
};
const FIRE_DETECTION = {
  id: 'fire-1', region: 'BR', brightness: 330.5, frp: 12.5,
  confidence: 'FIRE_CONFIDENCE_HIGH', acq_date: '2026-08-01', daynight: 'N',
  location: { latitude: -10.2, longitude: -55.3 },
};
const EARTHQUAKE = {
  id: 'us-7001', place: '12 km SE of Browserville', magnitude: 4.6, depthKm: 33.2,
  occurredAt: 1_754_000_000, sourceUrl: 'https://example.org/eq', source: 'usgs',
  category: 'usgs',
};
const SANCTIONS_ENTRY_NAME = 'Browser Sanctioned Entity';
const SANCTIONS_PRESSURE = {
  entries: [{
    id: 'sdn-1', name: SANCTIONS_ENTRY_NAME, entityType: 'ENTITY', countryCodes: ['RU'],
    countryNames: ['Russia'], programs: ['SDN'], sourceLists: ['OFAC'],
    effectiveAt: 1_754_000_000, isNew: false, note: '',
  }],
  countries: [], programs: [], totalCount: 1, sdnCount: 1, consolidatedCount: 0,
  semaCount: 0, newEntryCount: 0, vesselCount: 0, aircraftCount: 0,
  fetchedAt: 1_754_000_000, datasetDate: 1_754_000_000,
};

type HydrationDataset = {
  /** Bootstrap key, and the label a failure names. */
  key: string;
  tier: 'fast' | 'slow';
  /** The per-dataset fallback the loader takes when hydration is absent or
   * rejected. */
  rpcGlob: string;
  payload: unknown;
};

const HYDRATION_DATASETS: readonly HydrationDataset[] = [
  {
    key: 'earthquakes',
    tier: 'fast',
    rpcGlob: '**/api/seismology/v1/list-earthquakes*',
    payload: { earthquakes: [EARTHQUAKE] },
  },
  {
    key: 'naturalEvents',
    tier: 'slow',
    rpcGlob: '**/api/natural/v1/list-natural-events*',
    payload: { events: [NATURAL_EVENT] },
  },
  {
    key: 'wildfires',
    tier: 'slow',
    rpcGlob: '**/api/wildfire/v1/list-fire-detections*',
    payload: { fireDetections: [FIRE_DETECTION], fetchedAt: 1_754_000_000, dataAvailable: true },
  },
  {
    key: 'sanctionsPressure',
    tier: 'slow',
    // Anonymous sanctions also has a public per-key bootstrap fallback; the
    // bootstrap handler counts that one into the same dataset total.
    rpcGlob: '**/api/sanctions/v1/list-sanctions-pressure*',
    payload: SANCTIONS_PRESSURE,
  },
];

/** Long enough for a second fan-out to land if one is coming. The service TTLs
 * being guarded are 30 minutes, so any refetch inside this window is a miss. */
const REPEAT_LOAD_SETTLE_MS = 6_000;

/** Past the web fast-tier abort deadline (BOOTSTRAP_TIER_TIMEOUT_MS.web.fast =
 * 1_200). Held as a local literal on purpose: importing the constant would make
 * the abort fixture follow a deadline change instead of failing on it, and R3
 * forbids raising that deadline. */
const WEB_FAST_TIER_DEADLINE_MS = 1_200;

type HydrationRequestLog = {
  /** Per logical dataset: RPC hits plus public per-key bootstrap hits. */
  counts: Record<string, number>;
  tiers: string[];
};

/** Mark App.ts emits from handleViewportPrime. */
const VIEWPORT_HYDRATION_MARK = 'wm:hydration:viewport-trigger';

async function installHydrationRequestAccounting(
  page: Page,
  options: {
    /** false serves `{ data: {}, missing: [...] }` — the control arm. */
    hydrate?: boolean;
    /** Delays the fast tier past its abort deadline. */
    fastTierDelayMs?: number;
    /** Extra keys to place in the slow tier, e.g. a pre-#7046 payload still
     * carrying the energy registries during a rolling deploy. */
    extraSlowTierData?: Record<string, unknown>;
  } = {},
): Promise<HydrationRequestLog> {
  const hydrate = options.hydrate ?? true;
  const log: HydrationRequestLog = { counts: {}, tiers: [] };

  // Catch-all FIRST: later-registered routes win in Playwright, so the specific
  // handlers below still see their traffic. A third-party asset must never
  // decide whether a request-budget assertion passes.
  await page.route(
    /^https?:\/\/(?!(127\.0\.0\.1:4173|localhost:4173)(?:\/|$)).*/i,
    (route) => route.abort('blockedbyclient'),
  );

  await page.route('**/api/bootstrap*', async (route) => {
    const url = new URL(route.request().url());
    const tier = url.searchParams.get('tier');

    if (tier === 'fast' || tier === 'slow') {
      log.tiers.push(tier);
      if (tier === 'fast' && options.fastTierDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.fastTierDelayMs));
      }
      const data: Record<string, unknown> = {};
      const missing: string[] = [];
      for (const dataset of HYDRATION_DATASETS) {
        if (dataset.tier !== tier) continue;
        if (hydrate) data[dataset.key] = dataset.payload;
        else missing.push(dataset.key);
      }
      if (tier === 'slow') Object.assign(data, options.extraSlowTierData ?? {});
      // The client aborts the fast tier at its deadline, which rejects the
      // fulfill of a request that no longer exists. That rejection IS the
      // scenario under test, not a spec failure.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data, missing }),
      }).catch(() => {});
      return;
    }

    const keys = requestedKeys(url.href);
    for (const key of keys) log.counts[key] = (log.counts[key] ?? 0) + 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: Object.fromEntries(keys.map((key) => [
          key,
          HYDRATION_DATASETS.find((dataset) => dataset.key === key)?.payload
            ?? ENERGY_BOOTSTRAP_DATA[key as (typeof ENERGY_KEYS)[number]]
            ?? { key, records: [] },
        ])),
        missing: [],
      }),
    }).catch(() => {});
  });

  for (const dataset of HYDRATION_DATASETS) {
    // Fulfilled, not aborted: an aborted RPC opens the circuit breaker after two
    // failures and the loader then stops issuing observable requests, which
    // would cap the control arm's counts instead of measuring them.
    await page.route(dataset.rpcGlob, async (route) => {
      log.counts[dataset.key] = (log.counts[dataset.key] ?? 0) + 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(dataset.payload),
      }).catch(() => {});
    });
  }

  return log;
}

/**
 * Turn on the app's own opt-in LCP mark recorder before any page script runs.
 *
 * markLcpDebug() is a no-op unless the recorder is installed, and its
 * `wm:hydration:viewport-trigger` mark is the only proof that the post-startup
 * hydration handler actually ran. Every test that calls fireHydrationTrigger()
 * must set this first, or the trigger's own positive control reads zero.
 * The flag is the supported entry point — hand-installing the state object
 * would fabricate a shape the app never builds.
 */
async function installHydrationTriggerRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('wm_lcp_debug', '1');
  });
}

/** The `full` variant enables 39 priority-1 panels and free tier caps at 40, so
 * a fixture may promote exactly ONE priority-2 panel into range. Promoting two
 * pushes the set over the cap and enforceFreePanelLimit silently drops one. */
const SANCTIONS_PANEL_PROMOTION = {
  'sanctions-pressure': { name: 'Sanctions Pressure', enabled: true, priority: 1 },
};
const PIPELINE_PANEL_PROMOTION = {
  'pipeline-status': { name: 'Oil & Gas Pipeline Status', enabled: true, priority: 1 },
};

async function seedHydrationDashboard(
  page: Page,
  promotedPanels: Record<string, unknown> = SANCTIONS_PANEL_PROMOTION,
): Promise<void> {
  await page.addInitScript((panels: Record<string, unknown>) => {
    if (sessionStorage.getItem('__bootstrap_hydration_budget_e2e__')) return;
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('worldmonitor-variant', 'full');
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    // loadNatural() and loadFirmsData() are gated on the `natural` map layer,
    // which the full variant defaults OFF. AE1/AE2 describe what happens when
    // those loaders run twice, so the fixture turns on the layer that owns them
    // rather than asserting about a loader that never runs.
    localStorage.setItem('worldmonitor-layers', JSON.stringify({ natural: true }));
    // Partial panel settings: App.ts merges every other key in at its variant
    // default, so this only overrides the panel named here.
    localStorage.setItem('worldmonitor-panels', JSON.stringify(panels));
    sessionStorage.setItem('__bootstrap_hydration_budget_e2e__', '1');
  }, promotedPanels);
  // Registered LAST on purpose: init scripts run in registration order and the
  // seeder above calls localStorage.clear(), which would erase the recorder flag
  // if it were set first. That erasure is silent — countViewportTriggers() just
  // reads zero — so the ordering is load-bearing, not cosmetic.
  await installHydrationTriggerRecorder(page);
}

function countViewportTriggers(page: Page): Promise<number> {
  return page.evaluate((markName) => {
    const debug = (window as typeof window & {
      __wmLcpDebug?: { getSnapshot?: () => { marks: Array<{ name: string }> } };
    }).__wmLcpDebug;
    return debug?.getSnapshot?.().marks.filter((mark) => mark.name === markName).length ?? 0;
  }, VIEWPORT_HYDRATION_MARK);
}

/**
 * Fire a real post-startup hydration trigger and prove it fired.
 *
 * It has to be `resize`, not a scroll: html and body are `overflow: hidden`, so
 * the document never scrolls and a window scroll listener only sees descendant
 * scrolls in the capture phase. App.ts binds handleViewportPrime to both events,
 * and resize genuinely fires. The mark count is the positive control — without
 * it, "no second request" is indistinguishable from "nothing asked for one".
 */
async function fireHydrationTrigger(page: Page): Promise<void> {
  const before = await countViewportTriggers(page);
  const viewport = page.viewportSize();
  await page.setViewportSize({
    width: (viewport?.width ?? 1280) - 20,
    height: (viewport?.height ?? 720) - 20,
  });
  await expect
    .poll(() => countViewportTriggers(page), { message: 'handleViewportPrime never ran' })
    .toBeGreaterThan(before);
}

/** Bring the sanctions panel into range so its viewport-gated loader runs. */
async function mountSanctionsPanel(page: Page) {
  const panel = page.locator('[data-panel="sanctions-pressure"]');
  await panel.scrollIntoViewIfNeeded();
  await expect(panel).toBeVisible();
  await expect(panel).not.toHaveAttribute('data-deferred-panel', 'true');
  return panel;
}

// Viewport only — both arms still use the WEB tier deadlines. The desktop
// 5,000/8,000 ms budgets key off isDesktopRuntime() (the Tauri shell), not
// window size, so a narrow viewport changes layout and viewport gating without
// changing which deadline the abort test is measured against.
for (const [deviceClass, deviceViewport] of [
  ['desktop', { width: 1280, height: 720 }],
  ['mobile', { width: 390, height: 844 }],
] as const) {
  test.describe(`bootstrap hydration request budget — ${deviceClass} (#7045 U5)`, () => {
    test.use({ viewport: deviceViewport });

    test('a complete tier pair answers repeat loaders with zero refetch', async ({ page }) => {
      await seedHydrationDashboard(page);
      const log = await installHydrationRequestAccounting(page, { hydrate: true });

      await waitForStartup(page);
      await mountSanctionsPanel(page);
      await fireHydrationTrigger(page);
      await page.waitForTimeout(REPEAT_LOAD_SETTLE_MS);

      expect(log.tiers, 'both tiers must have been served').toEqual(
        expect.arrayContaining(['fast', 'slow']),
      );
      for (const dataset of HYDRATION_DATASETS) {
        expect(
          log.counts[dataset.key] ?? 0,
          `${dataset.key} was accepted from bootstrap and must not refetch within TTL`,
        ).toBe(0);
      }

      // Rendered data, not just network silence: the hydrated record has to
      // reach the DOM, or "zero requests" would also describe a dead panel.
      await expect(page.locator('[data-panel="sanctions-pressure"] .sanctions-entry-name'))
        .toHaveText(SANCTIONS_ENTRY_NAME);
    });

    test('without tier hydration the same flow refetches — the counters are live', async ({ page }) => {
      await seedHydrationDashboard(page);
      const log = await installHydrationRequestAccounting(page, { hydrate: false });

      await waitForStartup(page);
      await mountSanctionsPanel(page);
      await fireHydrationTrigger(page);
      await page.waitForTimeout(REPEAT_LOAD_SETTLE_MS);

      for (const dataset of HYDRATION_DATASETS) {
        expect(
          log.counts[dataset.key] ?? 0,
          `${dataset.key} has no live fallback path here, so the zero-refetch assertion is vacuous`,
        ).toBeGreaterThan(0);
      }
    });
  });
}

test.describe('bootstrap tier failure and rolling-deploy budgets (#7045 U5)', () => {
  test('a fast-tier abort keeps its fallback while accepted slow hydration still holds', async ({ page }) => {
    await seedHydrationDashboard(page);
    const log = await installHydrationRequestAccounting(page, {
      hydrate: true,
      fastTierDelayMs: WEB_FAST_TIER_DEADLINE_MS + 1_500,
    });

    await waitForStartup(page);
    await mountSanctionsPanel(page);
    await fireHydrationTrigger(page);
    await page.waitForTimeout(REPEAT_LOAD_SETTLE_MS);

    // The fast tier never delivered, so its consumer must recover through its
    // own fallback rather than settle into an empty state.
    expect(
      log.counts.earthquakes ?? 0,
      'an aborted fast tier must leave the earthquake fallback available',
    ).toBeGreaterThan(0);

    // The abort must not cost the slow tier its reuse contract.
    for (const dataset of HYDRATION_DATASETS.filter((entry) => entry.tier === 'slow')) {
      expect(
        log.counts[dataset.key] ?? 0,
        `${dataset.key} came from a complete slow tier and must still be reused`,
      ).toBe(0);
    }
    await expect(page.locator('[data-panel="sanctions-pressure"] .sanctions-entry-name'))
      .toHaveText(SANCTIONS_ENTRY_NAME);
  });

  test('an old slow tier still carrying the energy registries is consumed without a per-key request', async ({ page }) => {
    // Rolling deploy: a client running #7046 code receives a tier payload
    // published before the keys were demoted, so the demoted keys arrive in the
    // universal slow body and the one-shot hydration read must satisfy the
    // registry demand instead of the public per-key URL.
    //
    // Demand comes from the deferred pipeline panel on the `full` variant, not
    // from an energy-variant startup layer. That ordering is the point: App.ts
    // awaits the slow-tier checkpoint before its initial fan-out, so a panel
    // scrolled into range afterwards is guaranteed to ask AFTER the payload
    // landed. Energy-variant startup demand races the tier and can legitimately
    // miss it — the #7046 spec already covers that path with its own budget.
    await seedHydrationDashboard(page, PIPELINE_PANEL_PROMOTION);
    const log = await installHydrationRequestAccounting(page, {
      hydrate: true,
      extraSlowTierData: ENERGY_BOOTSTRAP_DATA,
    });

    await waitForStartup(page);
    const pipelinePanel = page.locator('[data-panel="pipeline-status"]');
    await pipelinePanel.scrollIntoViewIfNeeded();
    await expect(pipelinePanel).toBeVisible();
    await expect(pipelinePanel).not.toHaveAttribute('data-deferred-panel', 'true');
    await fireHydrationTrigger(page);
    await page.waitForTimeout(REPEAT_LOAD_SETTLE_MS);

    // Rendered first: a panel that never asked for its registry would satisfy
    // the zero-request assertion below for the wrong reason.
    await expect(pipelinePanel.locator('.pp-row')).toHaveCount(2);
    await expect(pipelinePanel).toContainText('Browser Gas Link');
    await expect(pipelinePanel).toContainText('Browser Oil Link');

    for (const key of ENERGY_KEYS) {
      expect(
        log.counts[key] ?? 0,
        `${key} arrived in the old tier payload and must not be refetched per key`,
      ).toBe(0);
    }
  });
});
