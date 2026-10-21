import type { Locator, Page, TestInfo } from '@playwright/test';

type CaptureTarget = {
  fullPage?: boolean;
  locator?: Locator;
};

/**
 * Named visual evidence for the chrome gallery.
 * Writes into Playwright's per-test output dir so CI can collect it, then
 * attaches the same file to the report. Do not write to /tmp — that dies
 * with the runner.
 */
export async function captureScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
  options: CaptureTarget = {},
): Promise<string> {
  const screenshotPath = testInfo.outputPath(`${name}.png`);
  const target = options.locator ?? page;
  await target.screenshot({
    animations: 'disabled',
    caret: 'hide',
    ...(options.locator ? {} : { fullPage: options.fullPage ?? true }),
    path: screenshotPath,
  });
  await testInfo.attach(name, { contentType: 'image/png', path: screenshotPath });
  return screenshotPath;
}
