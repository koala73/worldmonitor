import { expect, test, type Page } from '@playwright/test';

import type { ServerInsights } from '../src/services/insights-loader';

import {
  ENERGY_BOOTSTRAP_DATA,
  ENERGY_KEYS,
  requestedKeys,
  seedAnonymousDashboard,
  waitForStartup,
} from './bootstrap-request-budget-fixtures';
import {
  DEFAULT_QUIESCENCE_TIMEOUT_MS,
  type HydrationRequestLog,
  waitForHydrationRequestQuiescence,
} from './helpers/hydration-request-quiescence';
import {
  LOAD_ALL_DATA_END_MARK,
  LOAD_ALL_DATA_START_MARK,
  waitForLoadAllDataFanOut as waitForLoadAllDataFanOutMarks,
} from './helpers/load-all-data-fan-out';

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
// Field names come from the generated FireDetection contract
// (src/generated/client/worldmonitor/wildfire/v1/service_client.ts:22-39), NOT
// from the snake_case shape in tests/bootstrap-hydration-reuse.test.mts. That
// unit fixture only ever reaches fetchAllFires(), whose sole gate is
// `fireDetections.length > 0`, so it never notices the mismatch. The browser
// goes one step further into data-loader's `new Date(f.detectedAt)`, which
// throws RangeError on a missing field and kills the satellite-fires surface —
// leaving the request counter green over a dead consumer.
const FIRE_DETECTION = {
  id: 'fire-1', region: 'BR', brightness: 330.5, frp: 12.5,
  confidence: 'FIRE_CONFIDENCE_HIGH', satellite: 'NOAA-20',
  detectedAt: 1_754_000_000_000, dayNight: 'N',
  possibleExplosion: false, source: 'FIRMS', kind: 'wildfire', emergency: false,
  agencyFireId: '', agencyCode: '', fireSize: 0,
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

const WEATHER_ALERT = {
  id: 'nws-1', event: 'Severe Thunderstorm Warning', severity: 'Severe',
  headline: 'Browser Severe Thunderstorm Warning', description: 'Browser test alert',
  areaDesc: 'Test County', onset: '2026-08-01T00:00:00Z', expires: '2099-08-01T00:00:00Z',
  coordinates: [[-90, 30], [-89, 30], [-89, 31], [-90, 31]] as [number, number][],
  centroid: [-89.5, 30.5] as [number, number], countryCode: 'US', source: 'NWS',
  geometryPrecision: 'polygon' as const,
};

/** isAcceptedInsightsSnapshot rejects anything older than INSIGHTS_MAX_AGE_MS
 * (1 hour — shared/insights-snapshot.js:7,84), so this timestamp has to track
 * the clock. A frozen literal would silently start failing acceptance and turn
 * the insights arm into a permanent fallthrough that still reads as a pass. */
const INSIGHTS_ENTRY_NAME = 'Browser Insight Headline';
const INSIGHTS_SNAPSHOT = {
  worldBrief: 'Browser world brief.',
  briefProvider: 'browser-test',
  status: 'ok',
  topStories: [{
    primaryTitle: INSIGHTS_ENTRY_NAME,
    primarySource: 'Example',
    primaryLink: 'https://example.org/insight',
    pubDate: new Date().toISOString(),
    sourceCount: 1,
    uniqueSourceCount: 1,
    importanceScore: 0.8,
    credibilityScore: 80,
    velocity: { level: 'normal', sourcesPerHour: 1 },
    isAlert: false,
    category: 'general',
    threatLevel: 'low',
    countryCode: null,
  }],
  generatedAt: new Date().toISOString(),
  clusterCount: 1,
  multiSourceCount: 0,
  fastMovingCount: 0,
} satisfies ServerInsights;

type HydrationDataset = {
  /** Bootstrap key, and the label a failure names. */
  key: string;
  tier: 'fast' | 'slow';
  /**
   * The per-dataset fallback the loader takes when hydration is absent or
   * rejected. `null` means the dataset has no RPC of its own and falls back to
   * the public per-key bootstrap URL, which the bootstrap handler already
   * counts into the same dataset total.
   */
  rpcGlob: string | null;
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
  // Both of the following are named by U5's own scenario list ("no duplicate
  // natural, wildfire, earthquake, sanctions, weather, or insights request
  // within TTL") and neither has an RPC: weather.ts:75 falls back to
  // `?keys=weatherAlerts&public=1` inside its breaker, and
  // insights-loader.ts:112 to `?keys=insights` behind a module-local cache.
  {
    key: 'weatherAlerts',
    tier: 'fast',
    rpcGlob: null,
    payload: { alerts: [WEATHER_ALERT] },
  },
  {
    key: 'insights',
    tier: 'fast',
    rpcGlob: null,
    payload: INSIGHTS_SNAPSHOT,
  },
];

/**
 * A body every one of these services REJECTS, so none of them promotes it into
 * a cache. Superset of the empty shapes each loader checks (`events`,
 * `fireDetections`, `earthquakes`, `entries`, `alerts`, `topStories`), so one
 * literal serves every route.
 */
const EMPTY_FALLBACK_PAYLOAD = {
  events: [], fireDetections: [], earthquakes: [], entries: [], alerts: [],
  topStories: [], countries: [], programs: [], totalCount: 0,
  dataAvailable: false, fetchedAt: 0,
};

/** Long enough for a second fan-out to land if one is coming. The service TTLs
 * being guarded are 30 minutes, so any refetch inside this window is a miss.
 * Also the outer budget for quiescence waits — not a fixed sleep that freezes
 * the baseline (#7212). */
const REPEAT_LOAD_SETTLE_MS = DEFAULT_QUIESCENCE_TIMEOUT_MS;

/** The shared breaker opens after two rejected fallback responses for five
 * minutes. The uncacheable control intentionally rejects those responses, and
 * startup can exercise weather twice before the repeat baseline is frozen.
 * Move Date.now just past that cooldown so the repeat still happens inside the
 * guarded 30-minute data TTL while remaining observable at the network route. */
const BREAKER_COOLDOWN_ADVANCE_MS = 5 * 60 * 1000 + 1;

/** Past the web fast-tier abort deadline (BOOTSTRAP_TIER_TIMEOUT_MS.web.fast =
 * 1_200). Held as a local literal on purpose: importing the constant would make
 * the abort fixture follow a deadline change instead of failing on it, and R3
 * forbids raising that deadline. */
const WEB_FAST_TIER_DEADLINE_MS = 1_200;

const HYDRATION_DATASET_KEYS = HYDRATION_DATASETS.map((dataset) => dataset.key);

/** Mark App.ts emits from handleViewportPrime — proves the handler was ENTERED. */
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
    /**
     * Serve EMPTY fallback bodies so no service promotes the result into its
     * cache, making every loader pass observable at the counter. Only useful
     * with `hydrate: false` — it is what lets a test witness a SECOND loader
     * invocation rather than a cached no-op.
     */
    uncacheableFallbacks?: boolean;
  } = {},
): Promise<HydrationRequestLog> {
  const hydrate = options.hydrate ?? true;
  const log: HydrationRequestLog = { counts: {}, tiers: [], inflight: 0 };

  // Catch-all FIRST: later-registered routes win in Playwright, so the specific
  // handlers below still see their traffic. A third-party asset must never
  // decide whether a request-budget assertion passes.
  await page.route(
    /^https?:\/\/(?!(127\.0\.0\.1:4173|localhost:4173)(?:\/|$)).*/i,
    (route) => route.abort('blockedbyclient'),
  );

  await page.route('**/api/bootstrap*', async (route) => {
    log.inflight += 1;
    try {
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
            options.uncacheableFallbacks
              ? EMPTY_FALLBACK_PAYLOAD
              : HYDRATION_DATASETS.find((dataset) => dataset.key === key)?.payload
                ?? ENERGY_BOOTSTRAP_DATA[key as (typeof ENERGY_KEYS)[number]]
                ?? { key, records: [] },
          ])),
          missing: [],
        }),
      }).catch(() => {});
    } finally {
      log.inflight -= 1;
    }
  });

  for (const dataset of HYDRATION_DATASETS) {
    if (!dataset.rpcGlob) continue;
    // Fulfilled, not aborted: an aborted RPC opens the circuit breaker after two
    // failures and the loader then stops issuing observable requests, which
    // would cap the control arm's counts instead of measuring them.
    await page.route(dataset.rpcGlob, async (route) => {
      log.inflight += 1;
      try {
        log.counts[dataset.key] = (log.counts[dataset.key] ?? 0) + 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            options.uncacheableFallbacks ? EMPTY_FALLBACK_PAYLOAD : dataset.payload,
          ),
        }).catch(() => {});
      } finally {
        log.inflight -= 1;
      }
    });
  }

  return log;
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
const STORAGE_PANEL_PROMOTION = {
  'storage-facility-map': { name: 'Strategic Storage Atlas', enabled: true, priority: 1 },
};

async function seedHydrationDashboard(
  page: Page,
  promotedPanels: Record<string, unknown> = SANCTIONS_PANEL_PROMOTION,
): Promise<void> {
  await seedAnonymousDashboard(page, 'full', {
    initializeOnce: {
      sessionKey: '__bootstrap_hydration_budget_e2e__',
      clearStorage: true,
      localStorage: {
        // loadNatural() and loadFirmsData() are gated on the `natural` map
        // layer, which the full variant defaults OFF. The fixture enables the
        // real consumers rather than asserting about loaders that never run.
        'worldmonitor-layers': JSON.stringify({ natural: true }),
        // Partial panel settings: App.ts merges every other key at its variant
        // default, so this only overrides the panel named here.
        'worldmonitor-panels': JSON.stringify(promotedPanels),
      },
    },
    // markLcpDebug() is a no-op without this supported recorder flag. Apply it
    // on every document so reloads preserve the trigger's positive control.
    localStorage: { wm_lcp_debug: '1' },
  });
}

function countMarks(page: Page, markName: string): Promise<number> {
  return page.evaluate((name) => {
    const debug = (window as typeof window & {
      __wmLcpDebug?: { getSnapshot?: () => { marks: Array<{ name: string }> } };
    }).__wmLcpDebug;
    return debug?.getSnapshot?.().marks.filter((mark) => mark.name === name).length ?? 0;
  }, markName);
}

/** Prove a second `runLoadAllData` fan-out ran and drained after the baseline.
 * START vs drain budgets live in helpers/load-all-data-fan-out.ts — do not reuse
 * REPEAT_LOAD_SETTLE_MS for drain (CI 99074126316: START fired, END did not). */
async function waitForLoadAllDataFanOut(
  page: Page,
  marksBefore: { start: number; end: number },
  message: string,
): Promise<void> {
  await waitForLoadAllDataFanOutMarks(
    page,
    () => snapshotLoadAllDataMarks(page),
    marksBefore,
    { message },
  );
}

async function snapshotLoadAllDataMarks(page: Page): Promise<{ start: number; end: number }> {
  return {
    start: await countMarks(page, LOAD_ALL_DATA_START_MARK),
    end: await countMarks(page, LOAD_ALL_DATA_END_MARK),
  };
}

function countViewportTriggers(page: Page): Promise<number> {
  return countMarks(page, VIEWPORT_HYDRATION_MARK);
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

/**
 * Drive the InsightsPanel's real repeat-read path. Insights is populated by
 * loadNews(), not by the viewport-triggered loadAllData() pass, so the resize
 * alone cannot prove a second insights read. A framework change is a supported
 * consumer event subscribed by InsightsPanel on both desktop and mobile; its
 * handler calls updateInsights() with the panel's latest clusters.
 */
async function fireInsightsRepeatConsumer(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('wm-framework-changed', {
      detail: { panelId: 'insights', frameworkId: null },
    }));
  });
}

async function expireRejectedFallbackCooldown(page: Page): Promise<void> {
  await page.evaluate((advanceMs) => {
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + advanceMs;
  }, BREAKER_COOLDOWN_ADVANCE_MS);
}

/** Bring a deferred panel into range and wait for its real implementation. */
async function mountPanel(page: Page, panelId: string) {
  const panel = page.locator(`[data-panel="${panelId}"]`);
  await panel.scrollIntoViewIfNeeded();
  await expect(panel).toBeVisible();
  await expect(panel).not.toHaveAttribute('data-deferred-panel', 'true');
  return panel;
}

/** Bring the sanctions panel into range so its viewport-gated loader runs. */
function mountSanctionsPanel(page: Page) {
  return mountPanel(page, 'sanctions-pressure');
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

    // Drop routes before Playwright tears the page down. An in-flight
    // `route.fulfill` against a closed page surfaces as
    // `Object with guid response@… was not bound in the connection`
    // (playwright.config.ts retries). That is a harness race on teardown, not
    // #6501 (browser gone during the first `page.goto`).
    test.afterEach(async ({ page }) => {
      await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    });

    test('a complete tier pair answers repeat loaders with zero refetch', async ({ page }) => {
      await seedHydrationDashboard(page);
      const log = await installHydrationRequestAccounting(page, { hydrate: true });

      await waitForStartup(page);
      await mountPanel(page, 'insights');
      await mountSanctionsPanel(page);
      const fanOutsBefore = await snapshotLoadAllDataMarks(page);
      await fireHydrationTrigger(page);
      await fireInsightsRepeatConsumer(page);
      await waitForLoadAllDataFanOut(
        page,
        fanOutsBefore,
        'no second loadAllData() fan-out ran, so zero-refetch is vacuous',
      );
      await waitForHydrationRequestQuiescence(page, log, HYDRATION_DATASET_KEYS, {
        message: 'post-trigger traffic did not quiesce before the zero-refetch assertion',
      });

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
      await expect(page.locator('[data-panel="insights"] .insight-story-title'))
        .toHaveText(INSIGHTS_ENTRY_NAME);
    });

    // The precondition every zero-refetch assertion in this file rests on.
    // fireHydrationTrigger() proves handleViewportPrime ENTERED; it does not
    // prove the pass reached the loaders. If a future change stops
    // loadAllData() from re-running, every "must not refetch" assertion above
    // goes green over a page that never asked a second time — the guard would
    // report U2's contract protected while nothing tests it.
    //
    // The witness is data-loader's own `wm:data:load-all-start` mark, NOT a
    // request counter. A counter cannot tell a second fan-out apart from a
    // service retry — measured: with the repeat pass deleted from
    // handleViewportPrime, a counter-based version of this test still passed on
    // the desktop arm because a retry moved the number. The mark moves only
    // when runLoadAllData actually runs.
    //
    // Scope of the claim, deliberately narrow: this asserts a SECOND FAN-OUT
    // happens, not that handleViewportPrime is what caused it. Two paths can
    // supply one — handleViewportPrime (App.ts:360) and panel-layout's
    // IntersectionObserver via scheduleLoadAllData — and which one fires
    // depends on the viewport. Deleting the App.ts call reds the desktop arm
    // while mobile stays green on the observer path. Claiming a specific
    // trigger would be the stronger-sounding assertion this cannot support.
    test('a second fan-out runs after startup — the precondition for every zero-refetch assertion', async ({ page }) => {
      await seedHydrationDashboard(page);
      await installHydrationRequestAccounting(page, { hydrate: true });

      await waitForStartup(page);
      await mountSanctionsPanel(page);
      const fanOutsBefore = await snapshotLoadAllDataMarks(page);
      expect(fanOutsBefore.start, 'startup must have run at least one fan-out').toBeGreaterThan(0);
      expect(fanOutsBefore.end, 'startup fan-out must have drained').toBeGreaterThan(0);

      await fireHydrationTrigger(page);

      await waitForLoadAllDataFanOut(
        page,
        fanOutsBefore,
        'no second loadAllData() fan-out ran, so every zero-refetch assertion in this file is vacuous',
      );
    });

    test('without tier hydration the same flow refetches — the counters are live', async ({ page }) => {
      await seedHydrationDashboard(page);
      const log = await installHydrationRequestAccounting(page, {
        hydrate: false,
        uncacheableFallbacks: true,
      });

      await waitForStartup(page);
      // The panel owns the insights subscription. Mounting it makes both the
      // first update and the framework-change repeat a real consumer action.
      await mountPanel(page, 'insights');
      await mountSanctionsPanel(page);

      // Establish that every loader's first fallback pass is visible, then
      // compare only traffic caused by the repeat consumers. Startup retries
      // can raise these baselines, so exact absolute counts are not meaningful.
      for (const dataset of HYDRATION_DATASETS) {
        await expect.poll(() => log.counts[dataset.key] ?? 0, {
          message: `${dataset.key} did not exercise its first fallback pass`,
          timeout: REPEAT_LOAD_SETTLE_MS,
        }).toBeGreaterThan(0);
      }
      // Some loaders cascade from an RPC miss to the public per-key endpoint.
      // Freeze the baseline only after that first pass is quiescent (#7212) —
      // a wall-clock sleep neither proves the cascade finished nor prevents a
      // late tail from being misattributed to the repeat trigger below.
      const firstPassCounts = await waitForHydrationRequestQuiescence(
        page,
        log,
        HYDRATION_DATASET_KEYS,
        {
          message: 'first-pass fallback traffic did not quiesce before the repeat baseline freeze',
        },
      );

      const fanOutsBefore = await snapshotLoadAllDataMarks(page);
      await expireRejectedFallbackCooldown(page);
      await fireHydrationTrigger(page);
      await fireInsightsRepeatConsumer(page);
      await waitForLoadAllDataFanOut(
        page,
        fanOutsBefore,
        'no second loadAllData() fan-out ran after the repeat trigger, so a refetch miss would be misread',
      );

      for (const dataset of HYDRATION_DATASETS) {
        await expect.poll(() => log.counts[dataset.key] ?? 0, {
          message: `${dataset.key} did not refetch after its repeat consumer ran`,
          timeout: REPEAT_LOAD_SETTLE_MS,
        }).toBeGreaterThan(firstPassCounts[dataset.key] ?? 0);
      }
    });
  });
}

test.describe('bootstrap tier failure and rolling-deploy budgets (#7045 U5)', () => {
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
  });

  test('a fast-tier abort keeps its fallback while accepted slow hydration still holds', async ({ page }) => {
    await seedHydrationDashboard(page);
    const log = await installHydrationRequestAccounting(page, {
      hydrate: true,
      fastTierDelayMs: WEB_FAST_TIER_DEADLINE_MS + 1_500,
    });

    await waitForStartup(page);
    await mountPanel(page, 'insights');
    await mountSanctionsPanel(page);
    const fanOutsBefore = await snapshotLoadAllDataMarks(page);
    await fireHydrationTrigger(page);
    await fireInsightsRepeatConsumer(page);
    await waitForLoadAllDataFanOut(
      page,
      fanOutsBefore,
      'no second loadAllData() fan-out ran after the abort-path trigger',
    );
    await waitForHydrationRequestQuiescence(page, log, HYDRATION_DATASET_KEYS, {
      message: 'abort-path post-trigger traffic did not quiesce',
    });

    // Without this, both assertions below are equally satisfied by a run in
    // which the fast tier was never requested at all: no fast tier means no
    // earthquake hydration (so the fallback count rises) while the slow tier
    // still hydrates (so the slow keys stay at 0). The abort has to be the
    // reason, not merely a consistent story.
    expect(
      log.tiers,
      'the fast tier must have been requested so its abort is the scenario under test',
    ).toContain('fast');

    // The fast tier never delivered, so every consumer must recover through
    // its own fallback rather than settle into an empty state. Weather rides
    // the map fan-out; Insights needs its mounted panel and framework-change
    // consumer above because loadAllData() does not read it.
    for (const dataset of HYDRATION_DATASETS.filter((entry) => entry.tier === 'fast')) {
      expect(
        log.counts[dataset.key] ?? 0,
        `an aborted fast tier must leave the ${dataset.key} fallback available`,
      ).toBeGreaterThan(0);
    }
    expect(
      log.counts.insights ?? 0,
      'a hydration miss must issue at most one ?keys=insights request per page load (#7290)',
    ).toBeLessThanOrEqual(1);

    // The abort must not cost the slow tier its reuse contract.
    for (const dataset of HYDRATION_DATASETS.filter((entry) => entry.tier === 'slow')) {
      expect(
        log.counts[dataset.key] ?? 0,
        `${dataset.key} came from a complete slow tier and must still be reused`,
      ).toBe(0);
    }
    await expect(page.locator('[data-panel="sanctions-pressure"] .sanctions-entry-name'))
      .toHaveText(SANCTIONS_ENTRY_NAME);
    await expect(page.locator('[data-panel="insights"] .insight-story-title'))
      .toHaveText(INSIGHTS_ENTRY_NAME);
  });

  // Rolling deploy: a client running #7046 code receives a tier payload
  // published before the keys were demoted, so the demoted keys arrive in the
  // universal slow body and the one-shot hydration read must satisfy the
  // registry demand instead of the public per-key URL.
  //
  // Demand comes from a deferred panel on the `full` variant, not from an
  // energy-variant startup layer. That ordering is the point: App.ts starts the
  // slow-tier checkpoint and awaits it before the initial fan-out
  // (src/App.ts:2356,2372), so a panel scrolled into range afterwards asks
  // after the payload landed — PROVIDED the tier settles inside
  // waitForBootstrapSlowTier's 3.5 s web budget, which a route-fulfilled tier
  // always does. Energy-variant startup demand races the tier instead and can
  // legitimately miss it, which is why that path is the #7046 spec's job.
  //
  // ONE arm per registry, each promoting its own consumer panel, because the
  // free-tier cap has exactly zero headroom: FULL_PANELS already enables 40
  // priority-1 panels (39 cap-counted plus `map`, which enforceFreePanelLimit
  // excludes), so promoting a second panel would silently drop one. A single
  // arm looping all three keys would assert `toBe(0)` for a registry nothing on
  // the page ever demanded — true no matter what the store does.
  for (const { arm, panel, promotion, rowSelector, rowCount, renders, keys } of [
    {
      arm: 'pipeline',
      panel: 'pipeline-status',
      promotion: PIPELINE_PANEL_PROMOTION,
      rowSelector: '.pp-row',
      rowCount: 2,
      renders: ['Browser Gas Link', 'Browser Oil Link'],
      keys: ['pipelinesGas', 'pipelinesOil'],
    },
    {
      arm: 'storage',
      panel: 'storage-facility-map',
      promotion: STORAGE_PANEL_PROMOTION,
      rowSelector: '.sf-row',
      rowCount: 1,
      renders: ['Browser Storage Hub'],
      keys: ['storageFacilities'],
    },
  ] as const) {
    test(`an old slow tier still carrying the ${arm} registry is consumed without a per-key request`, async ({ page }) => {
      await seedHydrationDashboard(page, promotion);
      const log = await installHydrationRequestAccounting(page, {
        hydrate: true,
        extraSlowTierData: ENERGY_BOOTSTRAP_DATA,
      });

      await waitForStartup(page);
      const target = page.locator(`[data-panel="${panel}"]`);
      await target.scrollIntoViewIfNeeded();
      await expect(target).toBeVisible();
      await expect(target).not.toHaveAttribute('data-deferred-panel', 'true');
      const fanOutsBefore = await snapshotLoadAllDataMarks(page);
      await fireHydrationTrigger(page);
      await waitForLoadAllDataFanOut(
        page,
        fanOutsBefore,
        `no second loadAllData() fan-out ran for the ${arm} rolling-deploy arm`,
      );
      await waitForHydrationRequestQuiescence(page, log, keys, {
        message: `${arm} rolling-deploy traffic did not quiesce before the zero-refetch assertion`,
      });

      // Rendered first: a panel that never asked for its registry would satisfy
      // the zero-request assertion below for the wrong reason.
      await expect(target.locator(rowSelector)).toHaveCount(rowCount);
      for (const text of renders) await expect(target).toContainText(text);

      // Assert only the keys this arm's panel actually consumes.
      for (const key of keys) {
        expect(
          log.counts[key] ?? 0,
          `${key} arrived in the old tier payload and must not be refetched per key`,
        ).toBe(0);
      }
    });
  }
});
