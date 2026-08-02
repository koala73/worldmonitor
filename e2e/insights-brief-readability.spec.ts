import { expect, test } from '@playwright/test';

const insightsFixture = {
  worldBrief:
    'Trump halts Iran strikes, citing a deal [1][2][3][4][5][6][8]. A deal outline is agreed upon [3].',
  briefStoryLines: [
    { n: 1, text: 'Trump holds off Iran strikes for a deal [1].' },
    { n: 2, text: 'Trump calls off Iran attack for peace deal [2].' },
    { n: 3, text: 'Trump halts Iran attack for deal outline [3].' },
    { n: 4, text: 'Trump expects rapid deal with Iran [4].' },
    { n: 5, text: 'Trump cancels Iran strikes for rapid deal [5].' },
    { n: 6, text: 'Trump cancels Iran attack for deal parameters [6].' },
    { n: 7, text: 'Poilievre calls for Iran-backed group classification [7].' },
    { n: 8, text: 'Trump cites a deal while pausing strikes [8].' },
  ],
  worldBriefSources: Array.from({ length: 8 }, (_, index) => ({
    title: `Story ${index + 1}`,
    source: 'Example News',
    url: `https://example.com/story-${index + 1}`,
  })),
  briefProvider: 'fixture',
  status: 'ok' as const,
  topStories: [{
    primaryTitle: 'Trump halts Iran strikes',
    primarySource: 'Example News',
    primaryLink: 'https://example.com/story-1',
    pubDate: '2026-08-02T10:00:00.000Z',
    sourceCount: 8,
    importanceScore: 1,
    velocity: { level: 'normal', sourcesPerHour: 0 },
    isAlert: false,
    category: 'conflict',
    threatLevel: 'high',
    countryCode: 'IR',
  }],
  generatedAt: '2026-08-02T12:00:00.000Z',
  sourceAgeRange: { newestMs: Date.now(), oldestMs: Date.now() },
  clusterCount: 8,
  multiSourceCount: 8,
  fastMovingCount: 0,
};

test('server World Brief keeps the main insight concise and citations usable', async ({ page }) => {
  await page.goto('/tests/map-harness.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => document.body.replaceChildren());

  const rendered = await page.evaluate(async (fixture) => {
    const { InsightsPanel } = await import('/src/components/InsightsPanel.ts');
    const panel = new InsightsPanel();
    document.body.appendChild(panel.getElement());
    (panel as any).updateGeneration = 1;
    (panel as any).renderServerInsights(fixture, null);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const brief = panel.getElement().querySelector('.insights-brief');
    const mainText = brief?.querySelector('.insights-brief-text');
    const details = brief?.querySelector('.insights-brief-details');
    const storyLineCount = brief?.querySelectorAll('.insights-brief-lines li').length ?? 0;
    return {
      mainCitationLinks: mainText?.querySelectorAll('a.cb-citation').length ?? 0,
      storyLineCount,
      visibleStoryLineCount: details?.matches(':open') ? storyLineCount : 0,
      detailsOpen: details?.hasAttribute('open') ?? false,
      briefText: mainText?.textContent ?? '',
    };
  }, insightsFixture);

  expect(rendered.mainCitationLinks).toBeGreaterThan(0);
  expect(rendered.storyLineCount).toBe(8);
  expect(rendered.visibleStoryLineCount).toBe(0);
  expect(rendered.detailsOpen).toBe(false);
  expect(rendered.briefText).toContain('Trump halts Iran strikes');

  const details = page.locator('.insights-brief-details');
  await details.locator('summary').click();
  await expect(details).toHaveAttribute('open', '');
  await expect(details.locator('.insights-brief-lines li')).toHaveCount(8);
});
