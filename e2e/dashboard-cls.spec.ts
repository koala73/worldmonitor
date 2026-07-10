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

const isHappyVariant = process.env.VITE_VARIANT === 'happy';
const shouldSeedDeferredFootprint = !isHappyVariant;

const seededDeferredPanelId = 'supply-chain';
const seededDeferredPanelOrder = [
  'live-news',
  'live-webcams',
  'insights',
  'threat-timeline',
  'strategic-posture',
  'forecast',
  'cii',
  'strategic-risk',
  'intel',
  'gdelt-intel',
  'cascade',
  'military-correlation',
  'escalation-correlation',
  'economic-correlation',
  'disaster-correlation',
  'politics',
  'us',
  'europe',
  'middleeast',
  'africa',
  'latam',
  'asia',
  'energy',
  'gov',
  'thinktanks',
  'polymarket',
  'commodities',
  'energy-complex',
  'oil-inventories',
  'markets',
  'stock-analysis',
  'stock-backtest',
  'daily-market-brief',
  'chat-analyst',
  'economic',
  'trade-policy',
  seededDeferredPanelId,
];

interface DashboardClsObserverOptions {
  seedDeferredFootprint?: boolean;
}

const installDashboardClsObserver = async (
  page: Page,
  { seedDeferredFootprint = false }: DashboardClsObserverOptions = {},
): Promise<void> => {
  await page.addInitScript(({ dismissKey, legacyDismissKey, seedDeferredFootprint, panelId, panelOrder }) => {
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    localStorage.removeItem(dismissKey);
    localStorage.removeItem(legacyDismissKey);
    if (seedDeferredFootprint) {
      localStorage.setItem('worldmonitor-layout-reset-v2.5', 'done');
      localStorage.setItem('panel-order', JSON.stringify(panelOrder));
      localStorage.setItem('worldmonitor-panel-spans', JSON.stringify({ [panelId]: 3 }));
      localStorage.setItem('worldmonitor-panel-col-spans', JSON.stringify({ [panelId]: 2 }));
      localStorage.removeItem('worldmonitor-panel-collapsed');
    }
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
    seedDeferredFootprint,
    panelId: seededDeferredPanelId,
    panelOrder: seededDeferredPanelOrder,
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

type DeferredPanelFootprintSnapshot = Box & {
  className: string;
  deferred: boolean;
};

const snapshotDeferredPanelFootprint = async (page: Page, panelId: string): Promise<DeferredPanelFootprintSnapshot | null> => {
  return page.evaluate((targetPanelId) => {
    const el = document.querySelector('#panelsGrid > .panel[data-panel="' + targetPanelId + '"]') as HTMLElement | null;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      className: el.className,
      deferred: el.dataset.deferredPanel === 'true',
      height: rect.height,
      width: rect.width,
      x: rect.x,
      y: rect.y,
    };
  }, panelId);
};

const expectClass = (className: string, expected: string, label: string): void => {
  expect(className.split(/\s+/), label).toContain(expected);
};

const assertSeededDeferredPanelShellFootprint = async (page: Page): Promise<DeferredPanelFootprintSnapshot> => {
  const selector = '#panelsGrid > .panel[data-panel="' + seededDeferredPanelId + '"]';
  await page.locator(selector).waitFor({ timeout: 30000 });

  const shell = await snapshotDeferredPanelFootprint(page, seededDeferredPanelId);
  expect(shell, 'seeded deferred shell should exist').not.toBeNull();
  expect(shell!.deferred, 'seeded panel should start as a deferred shell').toBe(true);
  expectClass(shell!.className, 'span-3', 'seeded shell row span');
  expectClass(shell!.className, 'resized', 'seeded shell saved row marker');
  expectClass(shell!.className, 'col-span-2', 'seeded shell saved column span');
  return shell!;
};

const assertSeededDeferredPanelMount = async (
  page: Page,
  shell: DeferredPanelFootprintSnapshot,
): Promise<void> => {
  const selector = '#panelsGrid > .panel[data-panel="' + seededDeferredPanelId + '"]';
  await page.locator(selector).scrollIntoViewIfNeeded();
  await expect
    .poll(async () => (await snapshotDeferredPanelFootprint(page, seededDeferredPanelId))?.deferred, {
      timeout: 30000,
      intervals: [50, 100, 250, 500],
    })
    .toBe(false);
  await nextLayoutFrames(page, 4);

  const mounted = await snapshotDeferredPanelFootprint(page, seededDeferredPanelId);
  expect(mounted, 'seeded real panel should exist after deferred mount').not.toBeNull();
  expectClass(mounted!.className, 'span-3', 'seeded real panel row span');
  expectClass(mounted!.className, 'resized', 'seeded real panel saved row marker');
  expectClass(mounted!.className, 'col-span-2', 'seeded real panel saved column span');
  expect(Math.abs(mounted!.width - shell!.width), 'shell→mounted width delta').toBeLessThanOrEqual(2);
  expect(Math.abs(mounted!.height - shell!.height), 'shell→mounted height delta').toBeLessThanOrEqual(2);
};

const assertDashboardCls = async (page: Page): Promise<void> => {
  const cls = await page.evaluate(() => {
    const entries = (window.__wmDashboardClsEntries ?? []).filter((entry) => !entry.hadRecentInput);
    const total = entries.reduce((sum, entry) => sum + entry.value, 0);
    const seoPrerenderSelectors = new Set(['#seo-prerender', 'h1', 'h2', 'p', 'ul', 'li', 'nav']);
    const dashboardEntries = entries.filter((entry) => {
      if (entry.sourceSelectors.some((selector) => seoPrerenderSelectors.has(selector))) return false;
      return entry.sourceSelectors.some((selector) => (
        selector === '.header'
        || selector === '#panelTabsMount'
        || selector === '.main-content'
        || selector === '#mapSection'
        || selector === '#panelsGrid'
        || selector.includes('pro-banner')
        || selector.includes('panel-wide')
        || selector.includes('span-2')
        || selector.includes('span-3')
      ));
    });
    const dashboard = dashboardEntries.reduce((sum, entry) => sum + entry.value, 0);
    return { total, dashboard, dashboardEntries, entries };
  });

  if (!isHappyVariant) {
    expect(cls.total, JSON.stringify(cls.entries)).toBeLessThan(0.1);
  }
  expect(cls.dashboard, JSON.stringify(cls.dashboardEntries)).toBeLessThan(0.05);
};

const exerciseDashboardBoot = async (
  page: Page,
  { assertSeededDeferredFootprint = false }: { assertSeededDeferredFootprint?: boolean } = {},
): Promise<void> => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('.header').waitFor();
  await page.locator('.pro-banner').waitFor({ timeout: 15000 });
  await page.locator('.main-content').waitFor();
  await page.locator('#panelsGrid').waitFor();

  const beforePanels = await snapshotBoxes(page, dashboardSelectors);
  await page.locator('#panelsGrid > .panel').first().waitFor({ timeout: 30000 });
  const seededDeferredShell = assertSeededDeferredFootprint
    ? await assertSeededDeferredPanelShellFootprint(page)
    : null;
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
    '#panelsGrid > .panel.span-3',
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
  if (seededDeferredShell) {
    await assertSeededDeferredPanelMount(page, seededDeferredShell);
  }
  expect(pageErrors.filter((message) => /layout|hydration|auth/i.test(message))).toHaveLength(0);
};

test.describe('dashboard layout stability', () => {
  test.beforeEach(async ({ page }) => {
    await installDashboardClsObserver(page, { seedDeferredFootprint: shouldSeedDeferredFootprint });
  });

  test('keeps desktop first-load CLS below the dashboard threshold with top banner visible', async ({ page }) => {
    await exerciseDashboardBoot(page, { assertSeededDeferredFootprint: shouldSeedDeferredFootprint });
  });
});

test.describe('dashboard layout stability on mobile', () => {
  test.use({
    ...mobileDevice,
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
  });

  test.beforeEach(async ({ page }) => {
    // Seed the same tall/wide saved footprint as desktop so the deferred-shell
    // mount path is exercised on mobile, where the mount budget is smallest and
    // the grid is a single-column flexbox. This guards the mobile shell
    // reservation override against reintroducing CLS during lazy mount.
    await installDashboardClsObserver(page, { seedDeferredFootprint: shouldSeedDeferredFootprint });
  });

  test('keeps mobile first-load CLS below the dashboard threshold with top banner visible', async ({ page }) => {
    // Note: the strict shell↔mount footprint equality check is desktop-only — on
    // mobile spans are inert (flex column) and panels are content-sized, so we
    // rely on the dashboard CLS bucket assertion to catch reservation regressions.
    await exerciseDashboardBoot(page);
  });
});
