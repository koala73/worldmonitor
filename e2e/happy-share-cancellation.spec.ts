import { expect, test } from '@playwright/test';

test('Happy Share cancellation stops fallback while genuine errors retain it', async ({ page }, testInfo) => {
  await page.goto('/tests/runtime-harness.html');
  await page.evaluate(async () => {
    // @ts-expect-error Vite serves the production module and styles.
    const { initI18n } = await import('/src/services/i18n.ts');
    await initI18n();
    // @ts-expect-error Vite serves the production styles.
    await import('/src/styles/base-layer.css');
    document.documentElement.dataset.variant = 'happy';
    document.documentElement.dataset.theme = 'light';
    // @ts-expect-error Vite serves the happy theme.
    await import('/src/styles/happy-theme.css');
    // @ts-expect-error Vite serves the production panel.
    const { PositiveNewsFeedPanel } = await import('/src/components/PositiveNewsFeedPanel.ts');
    const panel = new PositiveNewsFeedPanel();
    panel.renderPositiveNews([{ title: 'Controlled fixture: a community restores its local forest', source: 'Test fixture',
      link: 'https://example.com/story', pubDate: new Date('2026-09-15T10:00:00Z'), happyCategory: 'nature-wildlife', isAlert: false }]);
    document.body.replaceChildren(panel.getElement());
    panel.getElement().style.cssText = 'width: min(600px, 100%); min-height: 300px; height: auto; margin: 24px auto';
  });
  await expect(page.getByRole('button', { name: 'Share this story' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('happy-share-controlled-story.png') });

  for (const scenario of ['cancel', 'cancel-no-clipboard', 'cancel-unbranded', 'native-success', 'clipboard', 'download', 'null-error'] as const) {
    const result = await page.evaluate(async (mode) => {
      let shares = 0; let writes = 0; let downloads = 0;
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
      Object.defineProperty(navigator, 'share', { configurable: true, value: async () => {
        shares++;
        if (mode === 'native-success') return;
        if (mode === 'cancel-unbranded') throw { name: 'AbortError' };
        if (mode === 'null-error') throw null;
        throw new DOMException('Controlled native share result', mode.startsWith('cancel') ? 'AbortError' : 'NotAllowedError');
      } });
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'cancel-no-clipboard' ? undefined : {
        write: async () => { writes++; if (mode === 'download') throw new Error('Controlled clipboard failure'); },
      } });
      const originalClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download === 'happymonitor-story.png') downloads++;
        else originalClick.call(this);
      };
      try {
        // @ts-expect-error Vite serves the real renderer; only browser side effects are controlled.
        const { shareHappyCard } = await import('/src/services/happy-share-renderer.ts');
        await shareHappyCard({ title: 'Controlled fixture: a community restores its local forest', source: 'Test fixture',
          link: 'https://example.com/story', pubDate: new Date('2026-09-15T10:00:00Z'), happyCategory: 'nature-wildlife', isAlert: false });
        return { shares, writes, downloads };
      } finally {
        HTMLAnchorElement.prototype.click = originalClick;
      }
    }, scenario);
    expect(result, scenario).toEqual({ shares: 1, writes: scenario === 'clipboard' || scenario === 'download' || scenario === 'null-error' ? 1 : 0,
      downloads: scenario === 'download' ? 1 : 0 });
  }

  // Drive the real panel's delegated share button, with a native cancellation.
  await page.evaluate(() => {
    const state = { shares: 0, writes: 0 };
    Object.assign(window, { happyShareClickState: state });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async () => {
      state.shares++; throw new DOMException('Canceled', 'AbortError');
    } });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: async () => { state.writes++; } } });
  });
  const downloads: string[] = [];
  page.on('download', download => downloads.push(download.suggestedFilename()));
  await page.getByRole('button', { name: 'Share this story' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { happyShareClickState: { shares: number } }).happyShareClickState.shares)).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('happy-share-after-cancellation.png') });
  expect(await page.evaluate(() => (window as unknown as { happyShareClickState: { writes: number } }).happyShareClickState.writes)).toBe(0);
  expect(downloads).toEqual([]);
});
