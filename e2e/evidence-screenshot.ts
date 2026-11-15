import type { Locator, Page } from '@playwright/test';

type ScreenshotOptions = Parameters<Page['screenshot']>[0] & Parameters<Locator['screenshot']>[0];

/**
 * A screenshot kept only as review evidence, never compared or read back.
 *
 * Skipped unless WM_E2E_EVIDENCE=1. On CI these shots asserted nothing yet
 * cost up to 54 s each under software GL (#10789), and a failing test already
 * gets Playwright's own failure screenshot and trace (playwright.config.ts).
 * Run with WM_E2E_EVIDENCE=1 to write them for a PR review.
 */
export async function evidenceScreenshot(target: Page | Locator, options?: ScreenshotOptions): Promise<void> {
  if (process.env.WM_E2E_EVIDENCE !== '1') return;
  await target.screenshot(options);
}
