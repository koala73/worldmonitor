import { devices, expect, test } from '@playwright/test';

// #5159 / PR #5205 review P2: the source-pattern guard in
// tests/skeleton-app-footprint-parity.test.mjs proves the creation template
// SEEDS .collapsed, but only a behavioral check proves the section is never
// OBSERVABLE expanded. Pre-fix, #mapSection painted expanded (~796px) for
// ~150ms (9+ frames) before setupMobileMapToggle collapsed it, shoving
// #panelsGrid up 698px (CLS 0.617, 3/3 repro). This spec samples every rAF
// frame from document start: for the seeded collapsed cohort, NO frame may
// show an attached #mapSection without .collapsed.
//
const { defaultBrowserType, ...mobileDevice } = devices['iPhone 14 Pro Max'];
void defaultBrowserType;

async function expectDashboardBooted(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-wm-event-handlers-ready', 'true', { timeout: 45_000 });
  await expect(page.locator('#mapSection')).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('#panelsGrid')).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('#panelsGrid > .panel[data-panel]:not(.hidden)').first()).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('#mapSection')).not.toHaveClass(/collapsed/);
}

declare global {
  interface Window {
    __wmMapFrames?: Array<{ t: number; collapsed: boolean; className: string }>;
  }
}

test.describe('collapsed-map cohort first paint (#5159)', () => {
  test.use({ ...mobileDevice });

  test('#mapSection is never observable without .collapsed when the pref is set', async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('mobile-map-collapsed', 'true');
      } catch {
        /* storage unavailable — the seeded-cohort contract is then vacuous */
      }
      window.__wmMapFrames = [];
      const sample = (): void => {
        const sec = document.getElementById('mapSection');
        if (sec) {
          const frames = window.__wmMapFrames;
          const collapsed = sec.classList.contains('collapsed');
          const last = frames[frames.length - 1];
          if (!last || last.collapsed !== collapsed) {
            frames.push({ t: Math.round(performance.now()), collapsed, className: sec.className.slice(0, 80) });
          }
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });

    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#mapSection', { timeout: 45_000 });
    // Let several render passes land (deferred panels, map hydration) so a
    // late uncollapse would be caught too.
    await page.waitForTimeout(4_000);

    const frames = await page.evaluate(() => window.__wmMapFrames ?? []);
    expect(frames.length, 'the rAF sampler must have observed #mapSection').toBeGreaterThan(0);
    const uncollapsed = frames.filter((f) => !f.collapsed);
    expect(
      uncollapsed,
      `#mapSection was observable WITHOUT .collapsed for the seeded cohort (pre-#5205 bug: expanded-then-snap, CLS 0.617): ${JSON.stringify(uncollapsed)}`,
    ).toEqual([]);
  });

  test('dashboard boots with defaults when browser storage access is blocked (#5209)', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(`${error.name}: ${error.message}`));

    await page.addInitScript(() => {
      for (const storageName of ['localStorage', 'sessionStorage'] as const) {
        Object.defineProperty(window, storageName, {
          configurable: true,
          get() {
            throw new DOMException('storage blocked', 'SecurityError');
          },
        });
      }
    });

    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

    await expectDashboardBooted(page);
    expect(pageErrors).toEqual([]);
  });

  test('dashboard boots with defaults when browser storage is read-only (#5209)', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(`${error.name}: ${error.message}`));

    await page.addInitScript(() => {
      for (const storage of [window.localStorage, window.sessionStorage]) {
        Object.defineProperties(storage, {
          setItem: {
            configurable: true,
            value() {
              throw new DOMException('storage is read-only', 'QuotaExceededError');
            },
          },
          removeItem: {
            configurable: true,
            value() {
              throw new DOMException('storage is read-only', 'QuotaExceededError');
            },
          },
        });
      }
    });

    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

    await expectDashboardBooted(page);
    expect(pageErrors).toEqual([]);
  });
});
