import { expect, test } from '@playwright/test';
import { captureScreenshot } from './capture-screenshot';

type HarnessWindow = Window & {
  __mapHarness?: {
    ready: boolean;
    enableDeterministicVisualMode: () => void;
    seedAllDynamicData: () => void;
    prepareVisualScenario: (scenarioId: string) => boolean;
    isVisualScenarioReady: (scenarioId: string) => boolean;
  };
};

const CHROME_SCENES = [
  'conflicts-z4',
  'hotspots-z4',
  'protests-z5',
  'news-z5',
  'military-z5',
] as const;

const waitForHarnessReady = async (
  page: import('@playwright/test').Page,
): Promise<void> => {
  await page.goto('/tests/map-harness.html');
  await expect(page.locator('.deckgl-map-wrapper')).toBeVisible();
  await expect
    .poll(async () => {
      return await page.evaluate(() => {
        const w = window as HarnessWindow;
        return Boolean(w.__mapHarness?.ready);
      });
    }, { timeout: 45_000 })
    .toBe(true);
};

const prepareVisualScenario = async (
  page: import('@playwright/test').Page,
  scenarioId: string,
): Promise<void> => {
  const prepared = await page.evaluate((id) => {
    const w = window as HarnessWindow;
    return w.__mapHarness?.prepareVisualScenario(id) ?? false;
  }, scenarioId);
  expect(prepared, `harness must know scenario ${scenarioId}`).toBe(true);

  await expect
    .poll(async () => {
      return await page.evaluate((id) => {
        const w = window as HarnessWindow;
        return w.__mapHarness?.isVisualScenarioReady(id) ?? false;
      }, scenarioId);
    }, { timeout: 20_000 })
    .toBe(true);

  await page.waitForTimeout(250);
};

test.describe('chrome screenshot story', () => {
  test.describe.configure({ retries: 1 });

  test('captures named deterministic harness states', async ({ page }, testInfo) => {
    test.setTimeout(180_000);

    await waitForHarnessReady(page);
    await page.evaluate(() => {
      const w = window as HarnessWindow;
      w.__mapHarness?.seedAllDynamicData();
      w.__mapHarness?.enableDeterministicVisualMode();
    });

    await captureScreenshot(page, testInfo, '01-harness-ready');

    for (const [index, scenarioId] of CHROME_SCENES.entries()) {
      await test.step(`chrome story: ${scenarioId}`, async () => {
        await prepareVisualScenario(page, scenarioId);
        const ordinal = String(index + 2).padStart(2, '0');
        await captureScreenshot(page, testInfo, `${ordinal}-${scenarioId}`);
      });
    }
  });

  test('captures the mobile harness viewport', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForHarnessReady(page);
    await page.evaluate(() => {
      const w = window as HarnessWindow;
      w.__mapHarness?.seedAllDynamicData();
      w.__mapHarness?.enableDeterministicVisualMode();
    });
    await captureScreenshot(page, testInfo, '07-mobile-harness', { fullPage: false });
  });
});
