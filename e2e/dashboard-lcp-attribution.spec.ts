import { devices, expect, test, type Page } from '@playwright/test';

const { defaultBrowserType: mobileDefaultBrowserType, ...mobileDevice } = devices['iPhone 14 Pro Max'];
void mobileDefaultBrowserType;

type LcpDebugContext = {
  devicePixelRatio: number;
  theme: string;
  variant: string;
  viewport: { height: number; width: number };
  visibilityState: string;
};

type LcpDebugSnapshot = {
  context: LcpDebugContext;
  entries: Array<{
    context: LcpDebugContext;
    element: {
      closest: string;
      selector: string;
      tagName: string;
      text: string;
      textLength: number;
    } | null;
    resources: Array<{ category: string; count: number; transferSize: number }>;
    size: number;
    startTime: number;
    url: string;
  }>;
  marks: Array<{ name: string; startTime: number }>;
  resources: Array<{ category: string; count: number; transferSize: number }>;
};

declare global {
  interface Window {
    __wmLcpDebug?: {
      enabled: true;
      getSnapshot: () => LcpDebugSnapshot;
    };
  }
}

const installLcpDebug = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    localStorage.setItem('wm_lcp_debug', '1');
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
  });
};

const CORE_MARKS = [
  'wm:lcp-debug:installed',
  'wm:boot:app-construct',
  'wm:boot:app-init-start',
  'wm:layout:render-start',
  'wm:layout:shell-replaced',
  'wm:map:shell-shown',
];

const expectLcpDebug = async (page: Page): Promise<LcpDebugSnapshot> => {
  await expect.poll(async () => page.evaluate(() => Boolean(window.__wmLcpDebug?.enabled)), {
    message: 'LCP debug should install when explicitly enabled',
  }).toBe(true);

  await expect(page.locator('.header')).toBeVisible({ timeout: 30000 });
  await expect.poll(async () => page.evaluate(() => window.__wmLcpDebug?.getSnapshot().entries.length ?? 0), {
    message: 'LCP debug should capture at least one LCP entry',
    timeout: 10000,
  }).toBeGreaterThan(0);
  await expect.poll(async () => page.evaluate((expectedMarks) => {
    const marks = new Set(window.__wmLcpDebug?.getSnapshot().marks.map((mark) => mark.name) ?? []);
    return expectedMarks.every((mark) => marks.has(mark));
  }, CORE_MARKS), {
    message: 'LCP debug should capture post-hydration boot and map marks',
    timeout: 30000,
  }).toBe(true);

  return page.evaluate(() => window.__wmLcpDebug!.getSnapshot());
};

const expectCoreMarks = (snapshot: LcpDebugSnapshot): void => {
  const marks = new Set(snapshot.marks.map((mark) => mark.name));
  for (const mark of CORE_MARKS) expect(marks).toContain(mark);
};

const expectContext = (snapshot: LcpDebugSnapshot): void => {
  expect(snapshot.context.viewport.width).toBeGreaterThan(0);
  expect(snapshot.context.viewport.height).toBeGreaterThan(0);
  expect(snapshot.context.devicePixelRatio).toBeGreaterThan(0);
  expect(snapshot.context.visibilityState).toBeTruthy();
};

// Vocabulary produced by closestAttributionLabel(). '' is valid when the LCP
// element is outside every known container, so this set alone cannot catch a
// regression that degrades attribution to '' — expectFooterNeverWinsLcp below
// is what pins the one container we know must never win LCP.
const KNOWN_ATTRIBUTION = new Set([
  '', 'shell-lcp', 'shell', 'map-container', 'map-section', 'map-renderer-shell', 'panel',
  'site-footer',
]);

// #7267 mounted the digest coverage row into footer.site-footer and collapsed
// the mobile footer around it, where its wrapped mono text outgrew the shell
// skeleton and took over as LCP — and because the text only lands on the first
// digest load, LCP then waited on a network round trip (mobile field p75
// 1137ms -> 2357ms).
//
// This asserts on desktop too, and that is not redundant. #app is a
// fixed-viewport flex column with .main-content scrolling internally, so the
// footer is pinned to the viewport bottom and LCP-eligible at every width.
// Desktop escaped only on margin: ~29,400px2 of row against ~607,000px2 of
// .map-section. Shrink the desktop first-paint candidate and it regresses the
// same way, so the invariant is pinned on both.
//
// This MUST re-read the snapshot rather than reuse the entry expectLcpDebug()
// returned. That entry is sampled once the boot and map marks land, which is
// well before reportDigestCoverage() mounts the row: measured on the pre-fix
// stylesheet, the candidate at that moment is p.skeleton-panel-copy (11,200px2,
// t=80ms) and only at t=2872ms does div.digest-coverage-row take over at
// 14,233px2. Asserting against the early entry passes on the pre-fix code,
// which is precisely the vacuous guard this replaces.
const expectFooterNeverWinsLcp = async (page: Page): Promise<void> => {
  // A row that never mounts would make every assertion below vacuously true,
  // and is itself the #7085 defect #7267 fixed — so require it.
  await expect(
    page.locator('.digest-coverage-row'),
    'the #7085 coverage row must still mount, or this guard proves nothing',
  ).toBeAttached({ timeout: 30000 });
  // Let any LCP entry the freshly painted row would produce be emitted.
  await page.waitForTimeout(2000);

  const latest = await page.evaluate(() => window.__wmLcpDebug!.getSnapshot().entries.at(-1));
  expect(latest?.element?.closest ?? '').not.toBe('site-footer');
  expect(latest?.element?.selector ?? '').not.toContain('digest-coverage-row');
  expect(latest?.element?.selector ?? '').not.toContain('status-panel-container');
};

const expectMeaningfulCandidate = (latest: LcpDebugSnapshot['entries'][number]): void => {
  expect(latest.element?.selector || latest.url).toBeTruthy();
  const closest = latest.element?.closest ?? '';
  expect(KNOWN_ATTRIBUTION.has(closest) || closest.startsWith('panel:')).toBe(true);
  // Raw text must stay redacted unless the explicit wm_lcp_text flag is set
  // (it is not set in these runs). The element's textLength still flows so
  // attribution can tell a text node apart without exposing its content.
  expect(latest.element?.text ?? '').toBe('');
};

test.describe('dashboard LCP attribution debug', () => {
  test.beforeEach(async ({ page }) => {
    await installLcpDebug(page);
  });

  test('captures final LCP candidate and boot marks on desktop', async ({ page }) => {
    await page.goto('/dashboard?wm_lcp_debug=1', { waitUntil: 'domcontentloaded' });
    const snapshot = await expectLcpDebug(page);
    const latest = snapshot.entries.at(-1);

    expectCoreMarks(snapshot);
    expectContext(snapshot);
    expect(latest).toBeTruthy();
    expect(latest!.startTime).toBeGreaterThanOrEqual(0);
    expect(latest!.size).toBeGreaterThan(0);
    expectMeaningfulCandidate(latest!);
    await expectFooterNeverWinsLcp(page);
    expect(latest!.context.viewport.width).toBeGreaterThan(0);
    expect(latest!.url).not.toContain('wms_');
    expect(latest!.url).not.toContain('token=');
  });
});

test.describe('dashboard LCP attribution debug on mobile', () => {
  test.use({
    ...mobileDevice,
    viewport: { width: 360, height: 780 },
    deviceScaleFactor: 2.625,
  });

  test.beforeEach(async ({ page }) => {
    await installLcpDebug(page);
  });

  test('captures final LCP candidate and boot marks on mobile', async ({ page }) => {
    await page.goto('/dashboard?wm_lcp_debug=1', { waitUntil: 'domcontentloaded' });
    const snapshot = await expectLcpDebug(page);
    const latest = snapshot.entries.at(-1);

    expectCoreMarks(snapshot);
    expectContext(snapshot);
    expect(latest).toBeTruthy();
    expect(latest!.startTime).toBeGreaterThanOrEqual(0);
    expect(latest!.size).toBeGreaterThan(0);
    expectMeaningfulCandidate(latest!);
    await expectFooterNeverWinsLcp(page);
    expect(latest!.context.viewport.width).toBeGreaterThan(0);
  });
});
