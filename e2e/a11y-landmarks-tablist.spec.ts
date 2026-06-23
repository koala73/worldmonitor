import { expect, test, type Page } from '@playwright/test';

/**
 * Real-DOM regression coverage for the issue #4373 accessibility fixes that
 * the source-invariant unit test (tests/a11y-issue-4373-invariants.test.mjs)
 * can only assert structurally:
 *   - aria-required-children: the dashboard tablist owns ONLY role="tab"
 *     children; the "+" add button is a sibling in the bar, not in the tablist.
 *   - bypass: a single <main id="main"> landmark exists and a skip link is the
 *     first focusable element, moving focus to <main> when activated.
 *   - select-name: #regionSelect exposes an accessible name.
 *
 * Runs against the Vite dev server (default `full` variant) on :4173.
 */

async function loadDashboard(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.documentElement.dataset.wmEventHandlersReady === 'true',
    undefined,
    { timeout: 60_000 },
  );
  await page.locator('[role="tablist"]').first().waitFor({ timeout: 30_000 });
}

test.describe('a11y #4373 — landmarks, tablist ownership, labelled region select', () => {
  test('tablist owns only role="tab" children; add button is outside it', async ({ page }) => {
    await loadDashboard(page);

    // The dashboard tab strip exposes exactly one tablist, on the inner
    // .dashboard-tablist element (NOT the .dashboard-tabs-bar). Other unrelated
    // components (settings, route explorer) may render their own tablists, so
    // this is scoped to the dashboard tab bar rather than the whole document.
    await expect(page.locator('.dashboard-tablist[role="tablist"]')).toHaveCount(1);
    await expect(page.locator('.dashboard-tabs-bar[role="tablist"]')).toHaveCount(0);

    // The tablist owns at least one tab and NO add button.
    await expect(page.locator('.dashboard-tablist [role="tab"]')).not.toHaveCount(0);
    await expect(page.locator('.dashboard-tablist .dashboard-tab-add')).toHaveCount(0);

    // The add button exists as a sibling of the tablist, inside the bar.
    await expect(page.locator('.dashboard-tabs-bar > .dashboard-tab-add')).toHaveCount(1);

    // Every direct child of the tablist resolves to a role="tab" (via the
    // generic .dashboard-tab wrapper) — i.e. no stray non-tab owned roles at
    // the top level. This is the exact shape axe aria-required-children checks.
    const nonTabTopChildren = await page.evaluate(() => {
      const tablist = document.querySelector('.dashboard-tablist[role="tablist"]');
      if (!tablist) return ['NO_TABLIST'];
      return Array.from(tablist.children)
        .filter((c) => !c.querySelector('[role="tab"]') && c.getAttribute('role') !== 'tab')
        .map((c) => c.className);
    });
    expect(nonTabTopChildren).toEqual([]);
  });

  test('single <main id="main"> landmark wraps the dashboard content', async ({ page }) => {
    await loadDashboard(page);
    const main = page.locator('main#main.main-content');
    await expect(main).toHaveCount(1);
    // The panels grid (tabpanel) lives inside the landmark.
    await expect(main.locator('#panelsGrid')).toHaveCount(1);
  });

  test('skip link is the first focusable element and moves focus to <main>', async ({ page }) => {
    await loadDashboard(page);
    await page.locator('#panelsGrid .panel').first().waitFor({ timeout: 30_000 });

    const skip = page.locator('a.skip-link');
    await expect(skip).toHaveCount(1);
    await expect(skip).toHaveAttribute('href', '#main');

    // The skip link is the FIRST tabbable element in document order, so a
    // keyboard user reaches it on the first Tab. Checked structurally (DOM
    // order) rather than by driving Tab, because the app manages focus during
    // hydration and that would race a live keypress.
    const skipTabIndex = await page.evaluate(() => {
      const sel = 'a[href], button, input, select, textarea, [tabindex]';
      const tabbable = Array.from(document.querySelectorAll(sel)).filter((el) => {
        if (el.closest('[inert]')) return false;
        if ((el as HTMLElement).hasAttribute('disabled')) return false;
        const ti = el.getAttribute('tabindex');
        if (ti !== null && Number(ti) < 0) return false;
        const cs = getComputedStyle(el as HTMLElement);
        return cs.display !== 'none' && cs.visibility !== 'hidden';
      });
      return tabbable.indexOf(document.querySelector('a.skip-link') as Element);
    });
    expect(skipTabIndex).toBe(0);

    // Activating the skip link moves focus to the <main> landmark. Enter on a
    // focused <a> fires a native click, so exercising the click handler is the
    // same code path; done in one synchronous step to be deterministic.
    const focusedAfterActivate = await page.evaluate(() => {
      (document.querySelector('a.skip-link') as HTMLElement).click();
      return document.activeElement?.id ?? '';
    });
    expect(focusedAfterActivate).toBe('main');
  });

  test('#regionSelect exposes an accessible name', async ({ page }) => {
    await loadDashboard(page);
    const region = page.locator('#regionSelect');
    await expect(region).toHaveCount(1);
    const label = await region.getAttribute('aria-label');
    expect(label && label.trim().length).toBeTruthy();
  });
});
