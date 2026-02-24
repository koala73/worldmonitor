import { expect, test } from '@playwright/test';

type LayerSnapshot = { id: string; dataCount: number };
type OverlaySnapshot = {
  protestMarkers: number;
  datacenterMarkers: number;
  techEventMarkers: number;
  techHQMarkers: number;
  hotspotMarkers: number;
};

type VisualScenarioSummary = {
  id: string;
  variant: 'both' | 'full' | 'tech' | 'finance';
};

type HarnessWindow = Window & {
  __mapHarness?: {
    ready: boolean;
    variant: 'full' | 'tech' | 'finance';
    seedAllDynamicData: () => void;
    setProtestsScenario: (scenario: 'alpha' | 'beta') => void;
    setPulseProtestsScenario: (
      scenario:
        | 'none'
        | 'recent-acled-riot'
        | 'recent-gdelt-riot'
        | 'recent-protest'
    ) => void;
    setNewsPulseScenario: (scenario: 'none' | 'recent' | 'stale') => void;
    setHotspotActivityScenario: (scenario: 'none' | 'breaking') => void;
    forcePulseStartupElapsed: () => void;
    resetPulseStartupTime: () => void;
    isPulseAnimationRunning: () => boolean;
    setZoom: (zoom: number) => void;
    setLayersForSnapshot: (enabledLayers: string[]) => void;
    setCamera: (camera: { lon: number; lat: number; zoom: number }) => void;
    enableDeterministicVisualMode: () => void;
    getVisualScenarios: () => VisualScenarioSummary[];
    prepareVisualScenario: (scenarioId: string) => boolean;
    isVisualScenarioReady: (scenarioId: string) => boolean;
    getDeckLayerSnapshot: () => LayerSnapshot[];
    getLayerDataCount: (layerId: string) => number;
    getLayerFirstScreenTransform: (layerId: string) => string | null;
    getFirstProtestTitle: () => string | null;
    getProtestClusterCount: () => number;
    getOverlaySnapshot: () => OverlaySnapshot;
    getCyberTooltipHtml: (indicator: string) => string;
  };
};

const EXPECTED_FULL_DECK_LAYERS = [
  'cables-layer',
  'pipelines-layer',
  'conflict-zones-layer',
  'bases-layer',
  'nuclear-layer',
  'irradiators-layer',
  'spaceports-layer',
  'hotspots-layer',
  'datacenters-layer',
  'earthquakes-layer',
  'natural-events-layer',
  'fires-layer',
  'weather-layer',
  'outages-layer',
  'cyber-threats-layer',
  'ais-density-layer',
  'ais-disruptions-layer',
  'ports-layer',
  'cable-advisories-layer',
  'repair-ships-layer',
  'flight-delays-layer',
  'military-vessels-layer',
  'military-vessel-clusters-layer',
  'military-flights-layer',
  'military-flight-clusters-layer',
  'waterways-layer',
  'economic-centers-layer',
  'minerals-layer',
  'apt-groups-layer',
  'news-locations-layer',
];

const EXPECTED_TECH_DECK_LAYERS = [
  'cables-layer',
  'pipelines-layer',
  'conflict-zones-layer',
  'bases-layer',
  'nuclear-layer',
  'irradiators-layer',
  'spaceports-layer',
  'hotspots-layer',
  'datacenters-layer',
  'earthquakes-layer',
  'natural-events-layer',
  'fires-layer',
  'weather-layer',
  'outages-layer',
  'cyber-threats-layer',
  'ais-density-layer',
  'ais-disruptions-layer',
  'ports-layer',
  'cable-advisories-layer',
  'repair-ships-layer',
  'flight-delays-layer',
  'military-vessels-layer',
  'military-vessel-clusters-layer',
  'military-flights-layer',
  'military-flight-clusters-layer',
  'waterways-layer',
  'economic-centers-layer',
  'minerals-layer',
  'startup-hubs-layer',
  'accelerators-layer',
  'cloud-regions-layer',
  'news-locations-layer',
];

const EXPECTED_FINANCE_DECK_LAYERS = [
  ...EXPECTED_FULL_DECK_LAYERS,
  'stock-exchanges-layer',
  'financial-centers-layer',
  'central-banks-layer',
  'commodity-hubs-layer',
  'gulf-investments-layer',
];

const waitForHarnessReady = async (
  page: import('@playwright/test').Page
): Promise<void> => {
  await page.goto('/tests/map-harness.html');
  await expect(page.locator('.deckgl-map-wrapper')).toBeVisible();
  await expect
    .poll(async () => {
      return await page.evaluate(() => {
        const w = window as HarnessWindow;
        return Boolean(w.__mapHarness?.ready);
      });
    }, { timeout: 45000 })
    .toBe(true);
};

const prepareVisualScenario = async (
  page: import('@playwright/test').Page,
  scenarioId: string
): Promise<void> => {
  const prepared = await page.evaluate((id) => {
    const w = window as HarnessWindow;
    return w.__mapHarness?.prepareVisualScenario(id) ?? false;
  }, scenarioId);

  expect(prepared).toBe(true);

  await expect
    .poll(async () => {
      return await page.evaluate((id) => {
        const w = window as HarnessWindow;
        return w.__mapHarness?.isVisualScenarioReady(id) ?? false;
      }, scenarioId);
    }, { timeout: 20000 })
    .toBe(true);

  await page.waitForTimeout(250);
};

test.describe('DeckGL map harness', () => {
  test.describe.configure({ retries: 1 });

  test('serves requested runtime variant for this test run', async ({ page }) => {
    await waitForHarnessReady(page);

    const runtimeVariant = await page.evaluate(() => {
      const w = window as HarnessWindow;
      return w.__mapHarness?.variant ?? 'full';
    });

    const expectedVariant = process.env.VITE_VARIANT === 'tech'
      ? 'tech'
      : process.env.VITE_VARIANT === 'finance'
      ? 'finance'
      : 'full';
    expect(runtimeVariant).toBe(expectedVariant);
  });

  test('boots without deck assertions or unhandled runtime errors', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    const deckAssertionErrors: string[] = [];
    const ignorablePageErrorPatterns = [/could not compile fragment shader/i];

    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });

    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (text.includes('deck.gl: assertion failed')) {
        deckAssertionErrors.push(text);
      }
    });

    await waitForHarnessReady(page);
    await page.waitForTimeout(1000);

    const unexpectedPageErrors = pageErrors.filter(
      (error) =>
        !ignorablePageErrorPatterns.some((pattern) => pattern.test(error))
    );

    expect(unexpectedPageErrors).toEqual([]);
    expect(deckAssertionErrors).toEqual([]);
  });

  test('renders non-empty visual data for every renderable layer in current variant', async ({
    page,
  }) => {
    await waitForHarnessReady(page);

    await page.evaluate(() => {
      const w = window as HarnessWindow;
      w.__mapHarness?.seedAllDynamicData();
      w.__mapHarness?.setZoom(5);
    });

    const variant = await page.evaluate(() => {
      const w = window as HarnessWindow;
      return w.__mapHarness?.variant ?? 'full';
    });

    const expectedDeckLayers = variant === 'tech'
      ? EXPECTED_TECH_DECK_LAYERS
      : variant === 'finance'
      ? EXPECTED_FINANCE_DECK_LAYERS
      : EXPECTED_FULL_DECK_LAYERS;

    await expect
      .poll(async () => {
        const snapshot = await page.evaluate(() => {
          const w = window as HarnessWindow;
          return w.__mapHarness?.getDeckLayerSnapshot() ?? [];
        });
        const nonEmptyIds = new Set(
          snapshot.filter((layer) => layer.dataCount > 0).map((layer) => layer.id)
        );
        return expectedDeckLayers.filter((id) => !nonEmptyIds.has(id)).length;
      }, { timeout: 40000 })
      .toBe(0);

    await expect
      .poll(async () => {
        return await page.evaluate(() => {
          const w = window as HarnessWindow;
          const layers = w.__mapHarness?.getDeckLayerSnapshot() ?? [];
          return layers.find((layer) => layer.id === 'protest-clusters-layer')?.dataCount ?? 0;
        });
      }, { timeout: 20000 })
      .toBeGreaterThan(0);

    await page.evaluate(() => {
      const w = window as HarnessWindow;
      w.__mapHarness?.setZoom(3);
    });

    await expect
      .poll(async () => {
        return await page.evaluate(() => {
          const w = window as HarnessWindow;
          const layers = w.__mapHarness?.getDeckLayerSnapshot() ?? [];
          return layers.find((layer) => layer.id === 'datacenter-clusters-layer')?.dataCount ?? 0;
        });
      }, { timeout: 20000 })
      .toBeGreaterThan(0);

    if (variant === 'tech') {
      await page.evaluate(() => {
        const w = window as HarnessWindow;
        w.__mapHarness?.setCamera({ lon: -122.42, lat: 37.77, zoom: 5.2 });
      });

      await expect
        .poll(async () => {
          return await page.evaluate(() => {
            const w = window as HarnessWindow;
            const layers = w.__mapHarness?.getDeckLayerSnapshot() ?? [];
            return layers.find((layer) => layer.id === 'tech-hq-clusters-layer')?.dataCount ?? 0;
          });
        }, { timeout: 20000 })
        .toBeGreaterThan(0);

      await expect
        .poll(async () => {
          return await page.evaluate(() => {
            const w = window as HarnessWindow;
            const layers = w.__mapHarness?.getDeckLayerSnapshot() ?? [];
            return layers.find((layer) => layer.id === 'tech-event-clusters-layer')?.dataCount ?? 0;
          });
        }, { timeout: 20000 })
        .toBeGreaterThan(0);
    }
  });

  test('renders GCC investments layer when enabled in finance variant', async ({ page }) => {
    await waitForHarnessReady(page);

    const variant = await page.evaluate(() => {
      const w = window as HarnessWindow;
      return w.__mapHarness?.variant ?? 'full';
    });
    test.skip(variant !== 'finance', 'Finance variant only');

    await page.evaluate(() => {
      const w = window as HarnessWindow;
      w.__mapHarness?.seedAllDynamicData();
      w.__mapHarness?.setLayersForSnapshot(['gulfInvestments']);
      w.__mapHarness?.setCamera({ lon: 55.27, lat: 25.2, zoom: 4.2 });
    });

    await expect
      .poll(async () => {
        return await page.evaluate(() => {
          const w = window as HarnessWindow;
          return w.__mapHarness?.getLayerDataCount('gulf-investments-layer') ?? 0;
        });
      }, { timeout: 30000 })
      .toBeGreaterThan(0);
  });

  test('sanitizes cyber threat tooltip content', async ({ page }) => {
    await waitForHarnessReady(page);

    const html = await page.evaluate(() => {
      const w = window as HarnessWindow;
      return w.__mapHarness?.getCyberTooltipHtml('<script>alert(1)</script>') ?? '';
    });

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  test('suppresses pulse animation during startup cooldown even with recent signals', async ({
    page,
  }) => {
    await waitForHarnessReady(page);

    await page.evaluate(() => {
      const w = window as HarnessWindow;
      w.__mapHarness?.setHotspotActivityScenario('none');
      w.__mapHarness?.setPulseProtestsScenario('none');
      w.__mapHarness?.setNewsPulseScenario('none');
      w.__mapHarness?.resetPulseStartupTime();
      w.__mapHarness?.setNewsPulseScenario('recent');
    });

    await page.waitForTimeout(800);

    const isRunning = await page.evaluate(() => {
      const w = window as HarnessWindow;
      return w.__mapHarness?.isPulseAnimationRunning() ?? false;
    });

    expect(isRunning).toBe(false);
  });

  test('starts and stops pulse on dynamic signals and ignores gdelt-only riot recency', async ({
    page,
  }) => {
    await waitForHarnessReady(page);

    await page.evaluate(() => {
      const w = window as HarnessWindow;
      w.__mapHarness?.seedAllDynamicData();
      w.__mapHarness?.setHotspotActivityScenario('none');
      w.__mapHarness?.setPulseProtestsScenario('none');
      w.__mapHarness?.setNewsPulseScenario('none');
      w.__mapHarness?.forcePulseStartupElapsed();
      w.__mapHarness?.setPulseProtestsScenario('recent-gdelt-riot');
    });

    await page.waitForTimeout(600);

    const gdeltPulseRunning = await page.evaluate(() => {
      const w = window as HarnessWindow;
      return w.__mapHarness?.isPulseAnimationRunning() ?? false;
    });
    expect(gdeltPulseRunning).toBe(false);

    await page.evaluate(() => {
      const w = window as HarnessWindow;
      w.__mapHarness?.setPulseProtestsScenario('recent-acled-riot');
    });

    await expect
      .poll(async () => {
        return await page.evaluate(() => {
          const w = window as HarnessWindow;
          return w.__mapHarness?.isPulseAnimationRunning() ?? false;
        });
      }, { timeout: 30000 })
      .toBe(true);

    await page.evaluate(() => {
      const w = window as HarnessWindow;
      w.__mapHarness?.resetPulseStartupTime();
      w.__mapHarness?.setNewsPulseScenario('none');
      w.__mapHarness?.setHotspotActivityScenario('none');
      w.__mapHarness?.setPulseProtestsScenario('none');
    });

    await expect
      .poll(async () => {
        return await page.evaluate(() => {
          const w = window as HarnessWindow;
          return w.__mapHarness?.isPulseAnimationRunning() ?? false;
        });
      }, { timeout: 12000 })
      .toBe(false);
  });

  test('matches golden screenshots per layer and zoom', async ({ page }) => {
    test.setTimeout(180_000);

    await waitForHarnessReady(page);

    await page.evaluate(() => {
      const w = window as HarnessWindow;
      w.__mapHarness?.seedAllDynamicData();
      w.__mapHarness?.enableDeterministicVisualMode();
    });

    const variant = await page.evaluate(() => {
      const w = window as HarnessWindow;
      return w.__mapHarness?.variant ?? 'full';
    });

    const scenarios = await page.evaluate(() => {
      const w = window as HarnessWindow;
      return w.__mapHarness?.getVisualScenarios() ?? [];
    });

    expect(scenarios.length).toBeGreaterThan(0);

    const mapWrapper = page.locator('.deckgl-map-wrapper');
    await expect(mapWrapper).toBeVisible();

    for (const scenario of scenarios) {
      await test.step(`visual baseline: ${scenario.id}`, async () => {
        await prepareVisualScenario(page, scenario.id);
        await expect(mapWrapper).toHaveScreenshot(
          `layer-${variant}-${scenario.id}.png`,
          {
            animations: 'disabled',
            caret: 'hide',
            scale: 'css',
            maxDiffPixelRatio: 0.04,
          }
        );
      });
    }
  });

  test('updates protest marker click payload after data refresh', async ({
    page,
  }) => {
    await waitForHarnessReady(page);

    await expect
      .poll(async () => {
        return await page.evaluate(() => {
          const w = window as HarnessWindow;
          return w.__mapHarness?.getFirstProtestTitle() ?? '';
        });
      }, { timeout: 30000 })
      .toContain('Scenario Alpha Protest');

    await page.evaluate(() => {
      const w = window as HarnessWindow;
      w.__mapHarness?.setProtestsScenario('beta');
    });

    await expect
      .poll(async () => {
        return await page.evaluate(() => {
          const w = window as HarnessWindow;
          return w.__mapHarness?.getProtestClusterCount() ?? 0;
        });
      }, { timeout: 30000 })
      .toBeGreaterThan(0);

    await expect
      .poll(async () => {
        return await page.evaluate(() => {
          const w = window as HarnessWindow;
          return w.__mapHarness?.getFirstProtestTitle() ?? '';
        });
      }, { timeout: 30000 })
      .toContain('Scenario Beta Protest');
  });

  test('populates protest clusters on first protest cluster render', async ({
    page,
  }) => {
    await waitForHarnessReady(page);

    await page.evaluate(() => {
      const w = window as HarnessWindow;
      w.__mapHarness?.seedAllDynamicData();
      w.__mapHarness?.setLayersForSnapshot(['protests']);
      w.__mapHarness?.setCamera({ lon: 0.2, lat: 15.2, zoom: 5.2 });
    });

    await expect
      .poll(async () => {
        return await page.evaluate(() => {
          const w = window as HarnessWindow;
          return w.__mapHarness?.getLayerDataCount('protest-clusters-layer') ?? 0;
        });
      }, { timeout: 20000 })
      .toBeGreaterThan(0);

    await expect
      .poll(async () => {
        return await page.evaluate(() => {
          const w = window as HarnessWindow;
          return w.__mapHarness?.getProtestClusterCount() ?? 0;
        });
      }, { timeout: 20000 })
      .toBeGreaterThan(0);
  });

  test('reprojects hotspot overlay marker within one frame on zoom', async ({
    page,
  }) => {
    await waitForHarnessReady(page);

    await page.evaluate(() => {
      const w = window as HarnessWindow;
      w.__mapHarness?.setLayersForSnapshot(['hotspots']);
      w.__mapHarness?.setHotspotActivityScenario('breaking');
      w.__mapHarness?.setCamera({ lon: 0.2, lat: 15.2, zoom: 4.2 });
    });

    await expect
      .poll(async () => {
        return await page.evaluate(() => {
          const w = window as HarnessWindow;
          return w.__mapHarness?.getLayerDataCount('hotspots-layer') ?? 0;
        });
      }, { timeout: 30000 })
      .toBeGreaterThan(0);

    const beforeTransform = await page.evaluate(() => {
      const w = window as HarnessWindow;
      return w.__mapHarness?.getLayerFirstScreenTransform('hotspots-layer') ?? null;
    });
    expect(beforeTransform).not.toBeNull();

    await page.evaluate(() => {
      const w = window as HarnessWindow;
      w.__mapHarness?.setCamera({ lon: 0.2, lat: 15.2, zoom: 5.4 });
    });

    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        })
    );

    const afterTransform = await page.evaluate(() => {
      const w = window as HarnessWindow;
      return w.__mapHarness?.getLayerFirstScreenTransform('hotspots-layer') ?? null;
    });
    expect(afterTransform).not.toBeNull();
    expect(afterTransform).not.toBe(beforeTransform);
  });

  test('does not mutate hotspot overlay position when hotspots layer is disabled', async ({
    page,
  }) => {
    await waitForHarnessReady(page);

    await page.evaluate(() => {
      const w = window as HarnessWindow;
      w.__mapHarness?.setLayersForSnapshot(['hotspots']);
      w.__mapHarness?.setHotspotActivityScenario('breaking');
      w.__mapHarness?.setCamera({ lon: 0.2, lat: 15.2, zoom: 4.2 });
    });

    await expect
      .poll(async () => {
        return await page.evaluate(() => {
          const w = window as HarnessWindow;
          return w.__mapHarness?.getLayerDataCount('hotspots-layer') ?? 0;
        });
      }, { timeout: 30000 })
      .toBeGreaterThan(0);

    const beforeTransform = await page.evaluate(() => {
      const w = window as HarnessWindow;
      return w.__mapHarness?.getLayerFirstScreenTransform('hotspots-layer') ?? null;
    });
    expect(beforeTransform).not.toBeNull();

    await page.evaluate(() => {
      const w = window as HarnessWindow;
      w.__mapHarness?.setLayersForSnapshot([]);
      w.__mapHarness?.setCamera({ lon: 3.5, lat: 18.2, zoom: 4.8 });
    });

    await expect
      .poll(async () => {
        return await page.evaluate(() => {
          const w = window as HarnessWindow;
          return w.__mapHarness?.getLayerDataCount('hotspots-layer') ?? -1;
        });
      }, { timeout: 10000 })
      .toBe(0);

    const afterTransform = await page.evaluate(() => {
      const w = window as HarnessWindow;
      return w.__mapHarness?.getLayerFirstScreenTransform('hotspots-layer') ?? null;
    });
    expect(afterTransform).toBeNull();
  });

  test('reprojects protest overlay marker when panning at fixed zoom', async ({
    page,
  }) => {
    await waitForHarnessReady(page);

    await page.evaluate(() => {
      const w = window as HarnessWindow;
      w.__mapHarness?.seedAllDynamicData();
      w.__mapHarness?.enableDeterministicVisualMode();
    });

    await prepareVisualScenario(page, 'protests-z5');

    await expect
      .poll(async () => {
        return await page.evaluate(() => {
          const w = window as HarnessWindow;
          return w.__mapHarness?.getLayerDataCount('protest-clusters-layer') ?? 0;
        });
      }, { timeout: 30000 })
      .toBeGreaterThan(0);

    const beforeTransform = await page.evaluate(() => {
      const w = window as HarnessWindow;
      return w.__mapHarness?.getLayerFirstScreenTransform('protest-clusters-layer') ?? null;
    });
    expect(beforeTransform).not.toBeNull();

    await page.evaluate(() => {
      const w = window as HarnessWindow;
      w.__mapHarness?.setCamera({ lon: 2.2, lat: 20.1, zoom: 5.2 });
    });

    await page.waitForTimeout(750);

    const afterTransform = await page.evaluate(() => {
      const w = window as HarnessWindow;
      return w.__mapHarness?.getLayerFirstScreenTransform('protest-clusters-layer') ?? null;
    });
    expect(afterTransform).not.toBeNull();
    expect(afterTransform).not.toBe(beforeTransform);
  });
});
