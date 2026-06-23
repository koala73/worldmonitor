import { expect, test, devices, type Page } from '@playwright/test';

type Box = {
  height: number;
  width: number;
  x: number;
  y: number;
};

type LayoutShiftEntry = {
  value: number;
  hadRecentInput: boolean;
  sourceSelectors: string[];
  sourceDetails: Array<{
    selector: string;
    previousRect?: DOMRectInit;
    currentRect?: DOMRectInit;
  }>;
};

declare global {
  interface Window {
    __wmDashboardClsEntries?: LayoutShiftEntry[];
  }
}

const PRO_BANNER_DISMISS_KEY = 'wm-pro-banner-launched-dismissed';
const LEGACY_PRO_BANNER_DISMISS_KEY = 'wm-pro-banner-dismissed';
const { defaultBrowserType: mobileDefaultBrowserType, ...mobileDevice } = devices['iPhone 14 Pro Max'];
void mobileDefaultBrowserType;

const dashboardSelectors = [
  '.header',
  '#panelTabsMount',
  '.main-content',
  '#mapSection',
  '#panelsGrid',
] as const;

const installDashboardClsObserver = async (page: Page): Promise<void> => {
  await page.addInitScript(({ dismissKey, legacyDismissKey }) => {
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    localStorage.removeItem(dismissKey);
    localStorage.removeItem(legacyDismissKey);
    window.__wmDashboardClsEntries = [];

    const selectorFor = (node: Node | null): string => {
      if (!(node instanceof Element)) return '';
      if (node.id) return `#${node.id}`;
      if (node.classList.length > 0) return `.${Array.from(node.classList).join('.')}`;
      return node.tagName.toLowerCase();
    };

    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as PerformanceEntry[]) {
          const layoutShift = entry as PerformanceEntry & {
            value?: number;
            hadRecentInput?: boolean;
            sources?: Array<{ node?: Node; previousRect?: DOMRectReadOnly; currentRect?: DOMRectReadOnly }>;
          };
          window.__wmDashboardClsEntries?.push({
            value: layoutShift.value ?? 0,
            hadRecentInput: Boolean(layoutShift.hadRecentInput),
            sourceSelectors: (layoutShift.sources ?? []).map((source) => selectorFor(source.node ?? null)),
            sourceDetails: (layoutShift.sources ?? []).map((source) => ({
              selector: selectorFor(source.node ?? null),
              previousRect: source.previousRect ? {
                x: source.previousRect.x,
                y: source.previousRect.y,
                width: source.previousRect.width,
                height: source.previousRect.height,
              } : undefined,
              currentRect: source.currentRect ? {
                x: source.currentRect.x,
                y: source.currentRect.y,
                width: source.currentRect.width,
                height: source.currentRect.height,
              } : undefined,
            })),
          });
        }
      });
      observer.observe({ type: 'layout-shift', buffered: true });
    } catch {
      // Engines without layout-shift support still exercise rect stability below.
    }
  }, {
    dismissKey: PRO_BANNER_DISMISS_KEY,
    legacyDismissKey: LEGACY_PRO_BANNER_DISMISS_KEY,
  });
};

const nextLayoutFrames = async (page: Page, count = 2): Promise<void> => {
  await page.evaluate((frames) => new Promise<void>((resolve) => {
    let remaining = frames;
    const tick = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), count);
};

const snapshotBoxes = async (page: Page, selectors: readonly string[]): Promise<Record<string, Box | null>> => {
  return page.evaluate((targetSelectors) => {
    const boxOf = (selector: string): Box | null => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        height: rect.height,
        width: rect.width,
        x: rect.x,
        y: rect.y,
      };
    };
    return Object.fromEntries(targetSelectors.map((selector) => [selector, boxOf(selector)]));
  }, selectors);
};

const boxesMatch = (a: Box | null, b: Box | null): boolean => {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) <= 1
    && Math.abs(a.y - b.y) <= 1
    && Math.abs(a.width - b.width) <= 1
    && Math.abs(a.height - b.height) <= 1;
};

const waitForStableBoxes = async (
  page: Page,
  selectors: readonly string[],
  requiredStableSamples = 3,
): Promise<Record<string, Box | null>> => {
  let previous = await snapshotBoxes(page, selectors);
  let stableSamples = 0;

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await nextLayoutFrames(page, 2);
    const current = await snapshotBoxes(page, selectors);
    const stable = selectors.every((selector) => boxesMatch(previous[selector], current[selector]));
    if (stable) {
      stableSamples += 1;
      if (stableSamples >= requiredStableSamples) return current;
    } else {
      stableSamples = 0;
    }
    previous = current;
  }

  return previous;
};

const expectStablePosition = (before: Box, after: Box, label: string): void => {
  expect(Math.abs(after.x - before.x), `${label} x`).toBeLessThanOrEqual(2);
  expect(Math.abs(after.y - before.y), `${label} y`).toBeLessThanOrEqual(2);
  expect(Math.abs(after.width - before.width), `${label} width`).toBeLessThanOrEqual(2);
};

const assertDashboardCls = async (page: Page): Promise<void> => {
  const cls = await page.evaluate(() => {
    const entries = (window.__wmDashboardClsEntries ?? []).filter((entry) => !entry.hadRecentInput);
    const total = entries.reduce((sum, entry) => sum + entry.value, 0);
    const dashboardEntries = entries.filter((entry) => entry.sourceSelectors.some((selector) => (
      selector === '.header'
      || selector === '#panelTabsMount'
      || selector === '.main-content'
      || selector === '#mapSection'
      || selector === '#panelsGrid'
      || selector.includes('pro-banner')
      || selector.includes('panel-wide')
      || selector.includes('span-2')
    )));
    const dashboard = dashboardEntries.reduce((sum, entry) => sum + entry.value, 0);
    return { total, dashboard, dashboardEntries, entries };
  });

  expect(cls.total, JSON.stringify(cls.entries)).toBeLessThan(0.1);
  expect(cls.dashboard, JSON.stringify(cls.dashboardEntries)).toBeLessThan(0.05);
};

const exerciseDashboardBoot = async (page: Page): Promise<void> => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('.header').waitFor();
  await page.locator('.pro-banner').waitFor({ timeout: 15000 });
  await page.locator('.main-content').waitFor();
  await page.locator('#panelsGrid').waitFor();

  const beforePanels = await snapshotBoxes(page, dashboardSelectors);
  await page.locator('#panelsGrid > .panel').first().waitFor({ timeout: 30000 });
  await nextLayoutFrames(page, 4);
  const afterPanels = await snapshotBoxes(page, dashboardSelectors);

  for (const selector of dashboardSelectors) {
    const before = beforePanels[selector];
    const after = afterPanels[selector];
    expect(before, `${selector} before panel mount`).not.toBeNull();
    expect(after, `${selector} after panel mount`).not.toBeNull();
    expectStablePosition(before!, after!, selector);
  }

  const panelSelectors = [
    '#panelsGrid > .panel:first-of-type',
    '#panelsGrid > .panel.panel-wide',
    '#panelsGrid > .panel.span-2',
  ] as const;
  const beforeHydration = await snapshotBoxes(page, panelSelectors);
  const afterHydration = await waitForStableBoxes(page, panelSelectors);

  for (const selector of panelSelectors) {
    const before = beforeHydration[selector];
    const after = afterHydration[selector];
    if (!before || !after) continue;
    expectStablePosition(before, after, selector);
    expect(Math.abs(after.height - before.height), `${selector} height`).toBeLessThanOrEqual(2);
  }

  await assertDashboardCls(page);
  expect(pageErrors.filter((message) => /layout|hydration|auth/i.test(message))).toHaveLength(0);
};

test.describe('dashboard layout stability', () => {
  test.beforeEach(async ({ page }) => {
    await installDashboardClsObserver(page);
  });

  test('keeps desktop first-load CLS below the dashboard threshold with top banner visible', async ({ page }) => {
    await exerciseDashboardBoot(page);
  });
});

test.describe('dashboard layout stability on mobile', () => {
  test.use({
    ...mobileDevice,
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
  });

  test.beforeEach(async ({ page }) => {
    await installDashboardClsObserver(page);
  });

  test('keeps mobile first-load CLS below the dashboard threshold with top banner visible', async ({ page }) => {
    await exerciseDashboardBoot(page);
  });
});
