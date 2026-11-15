import type { Locator, Page, TestInfo } from '@playwright/test';

type ScreenshotOptions = Parameters<Page['screenshot']>[0] & Parameters<Locator['screenshot']>[0];

/**
 * A screenshot kept only as review evidence, never compared or read back.
 *
 * Skipped unless WM_E2E_EVIDENCE=1. On CI these shots asserted nothing yet
 * cost up to 54 s each under software GL (#10789), and a failing test already
 * gets Playwright's own failure screenshot and trace (playwright.config.ts).
 * Run with WM_E2E_EVIDENCE=1 to write them for a PR review.
 *
 * Pass `attach` to add the written file to the test report; the attachment is
 * skipped with the screenshot, because attaching a file that was never written
 * fails the test with ENOENT.
 */
export async function evidenceScreenshot(
  target: Page | Locator,
  options?: ScreenshotOptions,
  attach?: { testInfo: TestInfo; name: string },
): Promise<void> {
  if (process.env.WM_E2E_EVIDENCE !== '1') return;
  await target.screenshot(options);
  if (attach) {
    if (!options?.path) throw new Error('evidenceScreenshot: attach needs options.path');
    await attach.testInfo.attach(attach.name, { path: options.path, contentType: 'image/png' });
  }
}
