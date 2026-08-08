import { expect, test, type Page } from '@playwright/test';

// Regression guard for the country deep-dive panel visibility contract.
//
// PR #4346 added an inline critical-CSS rule in index.html to keep the CLOSED
// panel off-canvas before the bundled CSS loads. The original rule was
// UNLAYERED and UNCONDITIONAL:
//
//     #country-deep-dive-panel.country-deep-dive{ right:-460px; visibility:hidden }
//
// The open-state rules live in country-deep-dive.css, which main.ts loads into
// @layer base (via base-layer.css):
//
//     .country-deep-dive.active    { right: 0; visibility: visible }
//     .country-deep-dive.maximized { inset: 0 }   /* => right: 0 */
//
// Unlayered styles beat ANY layered style regardless of specificity, so the
// inline rule won the cascade even after open() added `.active` / `.maximized`
// and set aria-hidden="false" — the panel could never slide on-screen. The fix
// scopes the inline rule to the closed state ([aria-hidden="true"]) so it stops
// matching once the panel opens. Issue #4580 later found that animating `right`
// itself can show up as CLS on the panel; the contract is now "right stays
// settled at 0, transform moves the panel off/on canvas."
//
// This spec loads the real dashboard (inline critical CSS + the layered bundle)
// and applies the exact class + aria-hidden mutations CountryDeepDivePanel
// performs in open()/hide(), then asserts the *rendered* geometry. The slide
// transition is disabled per measurement so getComputedStyle reads the settled
// value. It does not depend on the map, deck.gl, or any network call.
//
// To extend this to the full routing path, navigate to `/?country=US` (standard
// slide-in) or `/?c=US` (maximized) — App.handleDeepLinks() opens the panel
// ~1500ms later via openCountryBriefByCode(); that path additionally exercises
// data loading, so prefer mocking the brief response if you add it.

const PANEL = '#country-deep-dive-panel';

type Geometry = { right: string; transform: string; visibility: string };

// Mirrors the DOM mutations in CountryDeepDivePanel.open()/hide():
// classList.add('active'[, 'maximized']) + setAttribute('aria-hidden', ...).
const applyPanelState = (page: Page, classes: string[], ariaHidden: boolean): Promise<Geometry> =>
  page.evaluate(({ classes, ariaHidden }) => {
    const el = document.querySelector<HTMLElement>('#country-deep-dive-panel');
    if (!el) throw new Error('#country-deep-dive-panel not found');
    // Disable the 0.28s slide so getComputedStyle returns the settled target,
    // not an interpolated frame. This is an inline style and only affects
    // `transition` — `right`/`transform`/`visibility` still resolve through the real cascade.
    el.style.transition = 'none';
    el.classList.remove('active', 'maximized');
    for (const cls of classes) el.classList.add(cls);
    el.setAttribute('aria-hidden', ariaHidden ? 'true' : 'false');
    void el.offsetWidth; // force a style/layout flush before measuring
    const style = getComputedStyle(el);
    return { right: style.right, transform: style.transform, visibility: style.visibility };
  }, { classes, ariaHidden });

const bootDashboard = async (page: Page): Promise<void> => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  // Wait until the app bundle has hydrated — by which point base-layer.css
  // (carrying the .country-deep-dive open-state rules in @layer base) is applied.
  await page.locator('.header').waitFor();
  await page.locator('#panelsGrid').waitFor();
  await expect(page.locator(PANEL)).toHaveCount(1);
};

test.describe('country deep-dive panel visibility contract', () => {
  test.beforeEach(async ({ page }) => {
    await bootDashboard(page);
  });

  test('stays off-canvas and hidden while closed (aria-hidden="true")', async ({ page }) => {
    const closed = await applyPanelState(page, [], true);
    expect(closed.visibility).toBe('hidden');
    expect(closed.right).toBe('0px');
    expect(closed.transform).not.toBe('none');
  });

  test('slides on-screen and becomes visible when opened (.active)', async ({ page }) => {
    const open = await applyPanelState(page, ['active'], false);
    // Pre-fix these fail: the unlayered inline #id.class rule pins
    // right:-460px / visibility:hidden over the layered .country-deep-dive.active.
    expect(open.visibility).toBe('visible');
    expect(open.right).toBe('0px');
    expect(open.transform).toBe('none');
  });

  test('is visible and full-bleed when opened maximized (.active.maximized)', async ({ page }) => {
    const maximized = await applyPanelState(page, ['active', 'maximized'], false);
    expect(maximized.visibility).toBe('visible');
    expect(maximized.right).toBe('0px'); // from inset: 0
    expect(maximized.transform).toBe('none');
  });
});
