import { expect, test } from '@playwright/test';

test('uses default trending and basemap settings when localStorage access is blocked', async ({ page }) => {
  await page.goto('/tests/runtime-harness.html');

  const result = await page.evaluate(async () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('storage blocked', 'SecurityError');
      },
    });

    const trending = await import('/src/services/trending-keywords.ts');
    const basemap = await import('/src/config/basemap.ts');

    trending.ingestHeadlines([{
      source: 'Regression',
      title: 'Blocked storage must not interrupt headline ingestion',
      link: 'https://example.com/blocked-storage',
      pubDate: new Date(),
    }]);
    basemap.setMapProvider('carto');
    basemap.setMapTheme('carto', 'voyager');

    return {
      hasPMTilesUrl: basemap.hasPMTilesUrl,
      provider: basemap.getMapProvider(),
      theme: basemap.getMapTheme('carto'),
    };
  });

  expect(result.provider).toBe(result.hasPMTilesUrl ? 'auto' : 'openfreemap');
  expect(result.theme).toBe('dark-matter');
});
