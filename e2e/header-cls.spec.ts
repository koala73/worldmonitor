import { expect, test } from '@playwright/test';
import { assertSignedOutAuthHydrationKeepsHeaderStable, HEADER_AUTH_SLOT_WIDTH } from './header-reservation';

declare global {
  interface Window {
    __wmHeaderClsEntries?: Array<{
      value: number;
      hadRecentInput: boolean;
      sourceSelectors: string[];
      sourceDetails: Array<{
        selector: string;
        previousRect?: DOMRectInit;
        currentRect?: DOMRectInit;
      }>;
    }>;
  }
}

test.describe('header CLS reservations', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('wm-layer-warning-dismissed', 'true');
      localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
      localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
      window.__wmHeaderClsEntries = [];
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
            window.__wmHeaderClsEntries?.push({
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
        // Older engines without layout-shift support still exercise computed styles below.
      }
    });
  });

  test('reserves stable space for async header mounts without shifting the header', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.locator('.header').waitFor();
    await page.locator('.unified-settings-btn').waitFor({ timeout: 20000 });
    await page.locator('.intel-findings-badge').waitFor({ timeout: 20000 });
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));

    const beforeHydration = await page.locator('.header').boundingBox();
    expect(beforeHydration).not.toBeNull();
    await page.evaluate(() => {
      window.__wmHeaderClsEntries = [];
    });

    const styles = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>('.header');
      const missionMount = document.getElementById('missionPresetMount');
      const settingsMount = document.getElementById('unifiedSettingsMount');
      const authMount = document.getElementById('authWidgetMount');
      if (!header || !missionMount || !settingsMount || !authMount) {
        throw new Error('missing header reservation elements');
      }

      const headerStyle = getComputedStyle(header);
      const missionStyle = getComputedStyle(missionMount);
      const settingsStyle = getComputedStyle(settingsMount);
      const authStyle = getComputedStyle(authMount);

      return {
        headerContain: headerStyle.contain,
        missionDisplay: missionStyle.display,
        missionMinWidth: missionStyle.minWidth,
        missionMinHeight: missionStyle.minHeight,
        missionWidth: missionMount.getBoundingClientRect().width,
        missionHeight: missionMount.getBoundingClientRect().height,
        settingsDisplay: settingsStyle.display,
        settingsMinWidth: settingsStyle.minWidth,
        settingsMinHeight: settingsStyle.minHeight,
        settingsWidth: settingsMount.getBoundingClientRect().width,
        settingsHeight: settingsMount.getBoundingClientRect().height,
        authDisplay: authStyle.display,
        authMinWidth: authStyle.minWidth,
        authMinHeight: authStyle.minHeight,
        authWidth: authMount.getBoundingClientRect().width,
        authHeight: authMount.getBoundingClientRect().height,
      };
    });

    expect(styles.headerContain.split(' ')).toContain('layout');
    expect(styles.missionDisplay).toMatch(/^(inline-)?flex$/);
    expect(styles.missionMinWidth).toBe('86px');
    expect(styles.missionMinHeight).toBe('24px');
    expect(styles.missionWidth).toBeGreaterThanOrEqual(86);
    expect(styles.missionHeight).toBeGreaterThanOrEqual(24);
    expect(styles.settingsDisplay).toMatch(/^(inline-)?flex$/);
    expect(styles.settingsMinWidth).toBe('28px');
    expect(styles.settingsMinHeight).toBe('28px');
    expect(styles.settingsWidth).toBeGreaterThanOrEqual(28);
    expect(styles.settingsHeight).toBeGreaterThanOrEqual(28);
    expect(styles.authDisplay).toMatch(/^(inline-)?flex$/);
    expect(styles.authMinWidth).toBe(`${HEADER_AUTH_SLOT_WIDTH}px`);
    expect(styles.authMinHeight).toBe('32px');
    expect(styles.authWidth).toBeGreaterThanOrEqual(HEADER_AUTH_SLOT_WIDTH);
    expect(styles.authHeight).toBeGreaterThanOrEqual(32);

    await assertSignedOutAuthHydrationKeepsHeaderStable(page);
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));

    const afterHydration = await page.locator('.header').boundingBox();
    expect(afterHydration).not.toBeNull();
    expect(Math.abs((afterHydration?.height ?? 0) - (beforeHydration?.height ?? 0))).toBeLessThanOrEqual(1);

    const cls = await page.evaluate(() => {
      const entries = (window.__wmHeaderClsEntries ?? []).filter((entry) => !entry.hadRecentInput);
      const total = entries.reduce((sum, entry) => sum + entry.value, 0);
      const headerEntries = entries.filter((entry) => entry.sourceSelectors.some((selector) => (
          selector === '.header'
          || selector === '#missionPresetMount'
          || selector === '#unifiedSettingsMount'
          || selector === '#authWidgetMount'
          || selector.startsWith('.header-')
          || selector.includes('mission-preset')
          || selector.includes('auth-')
          || selector.includes('unified-settings')
        )));
      const header = headerEntries.reduce((sum, entry) => sum + entry.value, 0);
      return { total, header, headerEntries };
    });

    expect(cls.header, JSON.stringify(cls.headerEntries)).toBeLessThanOrEqual(0.001);
    expect(cls.total).toBeLessThan(0.05);

    await page.locator('.unified-settings-btn').click();
    await expect(page.locator('#unifiedSettingsModal.active')).toBeVisible();
    expect(pageErrors.filter((message) => message.toLowerCase().includes('auth'))).toHaveLength(0);
  });
});
