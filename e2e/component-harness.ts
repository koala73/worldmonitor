import type { Page } from '@playwright/test';

export async function openComponentHarness(page: Page): Promise<void> {
  await page.goto('/tests/runtime-harness.html');
  await page.addStyleTag({ url: '/node_modules/maplibre-gl/dist/maplibre-gl.css' });
  await page.addStyleTag({ url: '/src/styles/main.css' });
  await page.evaluate(async () => {
    document.body.replaceChildren();
    const { initI18n } = await import('/src/services/i18n.ts');
    await initI18n({ waitForFullTranslation: true });
  });
}
