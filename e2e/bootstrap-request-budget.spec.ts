import { expect, test, type Page } from '@playwright/test';

import {
  ENERGY_BOOTSTRAP_DATA,
  ENERGY_KEYS,
  requestedKeys,
  seedAnonymousDashboard,
  waitForStartup,
} from './bootstrap-request-budget-fixtures';

const DEMOTED_ON_DEMAND_KEYS = ['flightDelays', 'wsbTickers'] as const;

type BootstrapRequestLog = {
  tier: string[];
  keys: string[];
  counts: Record<string, number>;
};

type EnergyMapHarnessWindow = Window & {
  __mapHarness?: {
    ready: boolean;
    variant: string;
    seedAllDynamicData: () => void;
    setLayersForSnapshot: (enabledLayers: string[]) => void;
    getLayerDataCount: (layerId: string) => number;
  };
};

async function installBootstrapAccounting(page: Page): Promise<BootstrapRequestLog> {
  const log: BootstrapRequestLog = { tier: [], keys: [], counts: {} };

  await page.route('**/api/bootstrap*', async (route) => {
    const url = route.request().url();
    const parsed = new URL(url);
    const tier = parsed.searchParams.get('tier');
    if (tier === 'fast' || tier === 'slow') {
      log.tier.push(`${tier}:${url}`);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: {}, missing: [] }),
      });
      return;
    }
    const keys = requestedKeys(url);
    log.keys.push(...keys);
    for (const key of keys) log.counts[key] = (log.counts[key] ?? 0) + 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: Object.fromEntries(keys.map((key) => [
          key,
          ENERGY_BOOTSTRAP_DATA[key as (typeof ENERGY_KEYS)[number]] ?? { key, records: [] },
        ])),
        missing: [],
      }),
    });
  });

  return log;
}

async function expectPopulatedEnergyMapLayers(page: Page): Promise<void> {
  await page.goto('/tests/map-harness.html');
  await expect(page.locator('.deckgl-map-wrapper')).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const harness = (window as EnergyMapHarnessWindow).__mapHarness;
    return harness?.ready && harness.variant === 'energy';
  }), { timeout: 45_000 }).toBe(true);

  // Energy harness boots with nearly every map layer on. getLayerDataCount()
  // rebuilds the full DeckGL stack on each poll (~60 layers). Under
  // variant-smoke-full CI load that single evaluate can take most of a 20s
  // expect.poll budget (or hang the Playwright protocol) even when counts
  // are already correct — see issue #7249 traces. Narrow to the two layers
  // under contract, matching e2e/map-harness.spec.ts's snapshot pattern.
  await page.evaluate(() => {
    const harness = (window as EnergyMapHarnessWindow).__mapHarness;
    harness?.seedAllDynamicData();
    harness?.setLayersForSnapshot(['pipelines', 'storageFacilities']);
  });

  await expect.poll(async () => {
    return page.evaluate(() => {
      const harness = (window as EnergyMapHarnessWindow).__mapHarness;
      return {
        pipelines: harness?.getLayerDataCount('pipelines-layer') ?? 0,
        storage: harness?.getLayerDataCount('storage-facilities-layer') ?? 0,
      };
    });
  }, { timeout: 30_000 }).toEqual({ pipelines: 2, storage: 1 });
}

test.describe('bootstrap request budget (#7046)', () => {
  for (const variant of ['full', 'happy'] as const) {
    test(`${variant} startup makes no energy registry requests`, async ({ page }) => {
      const log = await installBootstrapAccounting(page);
      await seedAnonymousDashboard(page, variant);
      await waitForStartup(page);

      for (const key of ENERGY_KEYS) {
        expect(log.counts[key] ?? 0, `${key} must stay off ${variant} startup`).toBe(0);
      }
      expect(log.tier.some((entry) => entry.startsWith('fast:'))).toBeTruthy();
    });
  }

  test('full startup also keeps the other demoted keys off the request budget', async ({ page }) => {
    const log = await installBootstrapAccounting(page);
    await seedAnonymousDashboard(page, 'full');
    await waitForStartup(page);

    for (const key of DEMOTED_ON_DEMAND_KEYS) {
      expect(log.keys, `${key} must not be requested on default full startup`).not.toContain(key);
    }
  });

  test('energy startup requests every registry once and renders populated map and panels', async ({ page }) => {
    const log = await installBootstrapAccounting(page);
    await seedAnonymousDashboard(page, 'energy');
    await waitForStartup(page);

    for (const key of ENERGY_KEYS) {
      await expect.poll(() => log.counts[key] ?? 0, {
        message: `${key} should be requested exactly once`,
      }).toBe(1);
    }

    const pipelinePanel = page.locator('[data-panel="pipeline-status"]');
    const storagePanel = page.locator('[data-panel="storage-facility-map"]');
    await pipelinePanel.scrollIntoViewIfNeeded();
    await expect(pipelinePanel.locator('.pp-row')).toHaveCount(2);
    await expect(pipelinePanel).toContainText('Browser Gas Link');
    await expect(pipelinePanel).toContainText('Browser Oil Link');
    await storagePanel.scrollIntoViewIfNeeded();
    await expect(storagePanel.locator('.sf-row')).toHaveCount(1);
    await expect(storagePanel).toContainText('Browser Storage Hub');

    for (const key of ENERGY_KEYS) {
      expect(log.counts[key], `${key} must remain single-flight after panels mount`).toBe(1);
    }

    // The production map does not expose its deck.gl layer data. Reuse the
    // repository's real DeckGL harness to inspect the same store consumers and
    // assert record counts, which is stronger than a toggle-ready CSS class.
    await expectPopulatedEnergyMapLayers(page);
  });
});
