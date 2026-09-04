import { expect, test } from '@playwright/test';

/**
 * Mission Pro previews (plan U4/U5) — real-boot coverage.
 *
 * HARNESS NOTE (same honesty rule as e2e/pro-activation.spec.ts): the e2e dev
 * server has no Clerk session and no Convex snapshot, so the visitor settles
 * as ANONYMOUS — which is itself one of the preview's contract states (R7's
 * sign-in branch). What a real boot can honestly prove: the active treated
 * mission's target panel renders exactly one preview, AFTER its free content,
 * with the sign-in CTA; untouched missions render none. The FREE_TIER branch,
 * R9's never-upsell-on-uncertainty guard, dismissal persistence, and checkout
 * attribution are exhaustively covered in tests/dom/pro-preview-section.test.mts
 * (mutation-checked) because entitlement state cannot flip here.
 */

function seedMission(missionId: string | null) {
  return ({ id }: { id: string | null }) => {
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    if (id) localStorage.setItem('worldmonitor-mission-preset-v1', id);
  };
}

test('a treated mission renders one preview after its target panel content', async ({ page }) => {
  await page.addInitScript(seedMission('supply-chain-risk'), { id: 'supply-chain-risk' });
  await page.goto('/');

  const panel = page.locator('[data-panel="supply-chain"]');
  await expect(panel).toBeVisible({ timeout: 30000 });
  // Deferred panels mount on intersection; the preview attaches at the real
  // mount, so bring the panel into view first.
  await panel.scrollIntoViewIfNeeded();

  const preview = panel.locator('.pro-preview');
  await expect(preview).toBeVisible({ timeout: 30000 });
  await expect(preview).toHaveCount(1);
  await expect(preview.locator('.pro-preview__sample')).toBeVisible();
  await expect(preview.locator('.pro-preview__cta')).toHaveText('Sign In');

  // R6: after the free result — the preview is the panel's LAST section,
  // below the content container.
  const isLast = await panel.evaluate((el) => {
    const preview = el.querySelector(':scope > .pro-preview');
    return preview !== null && el.lastElementChild === preview;
  });
  expect(isLast).toBe(true);

  // R8: exactly one invitation on the whole board.
  await expect(page.locator('.pro-preview')).toHaveCount(1);
});

test('untouched comparison missions render no preview anywhere', async ({ page }) => {
  await page.addInitScript(seedMission('tech-ai-watch'), { id: 'tech-ai-watch' });
  await page.goto('/');

  // Board is up once the panels grid has children.
  await expect(page.locator('#panelsGrid [data-panel]').first()).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.pro-preview')).toHaveCount(0);
});
