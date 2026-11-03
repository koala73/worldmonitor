export default async function ({ page, base, shot, log, expectVisible }) {
  async function capture(sign) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${base}/tests/signal-modal-prediction-shift-harness.html?sign=${sign}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => window.__predictionShiftHarness?.ready === true);
    await expectVisible('.signal-modal-overlay.active .signal-description');
    const description = await page.locator('.signal-description').innerText();
    log(sign, 'description', description);
    if (sign === 'before' && !description.includes('moved +10.0%')) {
      throw new Error(`before fixture missing unsigned plus: ${description}`);
    }
    if (sign === 'after' && !description.includes('moved -10.0%')) {
      throw new Error(`after fixture missing signed fall: ${description}`);
    }
    await shot(`desktop-${sign}`);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectVisible('.signal-modal-overlay.active .signal-description');
    await shot(`mobile-${sign}`);
  }

  await capture('before');
  await capture('after');
}
