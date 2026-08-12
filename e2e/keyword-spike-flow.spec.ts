import { expect, test } from '@playwright/test';

test.describe('keyword spike modal/badge flow', () => {
  test('injects synthetic headlines and renders keyword_spike end-to-end', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const setup = await page.evaluate(async () => {
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const { SignalModal } = await import('/src/components/SignalModal.ts');
      const { IntelligenceGapBadge } = await import('/src/components/IntelligenceGapBadge.ts');
      const trending = await import('/src/services/trending-keywords.ts');
      const correlation = await import('/src/services/correlation.ts');

      const previousConfig = trending.getTrendingConfig();
      const headerRight = document.createElement('div');
      headerRight.className = 'header-right';
      document.body.appendChild(headerRight);

      const modal = new SignalModal();
      const badge = new IntelligenceGapBadge();
      badge.setOnSignalClick((signal) => modal.showSignal(signal));

      trending.updateTrendingConfig({
        blockedTerms: [],
        minSpikeCount: 5,
        spikeMultiplier: 3,
        autoSummarize: false,
      });

      const now = new Date();
      // Headlines must have the spike term ("Iran") mid-sentence (not only at index 0)
      // so that isLikelyProperNoun detects it as a capitalized proper noun.
      const headlines = [
        { source: 'Reuters', title: 'Pressure rises as Iran sanctions debate grows', link: 'https://example.com/reuters/1' },
        { source: 'AP', title: 'Washington intensifies Iran sanctions push', link: 'https://example.com/ap/1' },
        { source: 'BBC', title: 'Fresh concerns over Iran sanctions impact', link: 'https://example.com/bbc/1' },
        { source: 'Reuters', title: 'Regional response to Iran sanctions package', link: 'https://example.com/reuters/2' },
        { source: 'AP', title: 'New momentum behind Iran sanctions proposal', link: 'https://example.com/ap/2' },
        { source: 'BBC', title: 'Timeline shortens for Iran sanctions after warnings', link: 'https://example.com/bbc/2' },
      ].map(item => ({
        ...item,
        pubDate: now,
      }));

      trending.ingestHeadlines(headlines);

      let spikes = trending.drainTrendingSignals();
      // handleSpike is async (calls isSignificantTerm) — allow enough time for it to resolve
      for (let i = 0; i < 60 && spikes.length === 0; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
        spikes = trending.drainTrendingSignals();
      }

      if (spikes.length === 0) {
        badge.destroy();
        modal.getElement().remove();
        trending.updateTrendingConfig(previousConfig);
        return { ok: false, reason: 'No keyword spikes emitted from synthetic data' };
      }

      correlation.addToSignalHistory(spikes);
      // `update()` is async — it dynamically imports the alert source before it
      // writes `.findings-count`. Reading the count without awaiting it saw the
      // initial "0" and failed this test on every local dev run.
      await badge.update();

      // Keep refs alive for user interactions in the test.
      (window as unknown as Record<string, unknown>).__keywordSpikeTest = {
        badge,
        modal,
        previousConfig,
      };

      const spikeData = spikes[0]?.data ?? {};

      return {
        ok: true,
        spikeType: spikes[0]?.type,
        title: spikes[0]?.title ?? '',
        badgeCount: (document.querySelector('.findings-count') as HTMLElement | null)?.textContent ?? '0',
        sourceNames: spikeData.sourceNames ?? [],
        sourceCount: spikeData.sourceCount ?? 0,
        articleCount: spikeData.articles?.length ?? 0,
        articlesAllLinked: (spikeData.articles ?? []).every(article => !!article.link),
        articlesAllTimestamped: (spikeData.articles ?? []).every(
          article => typeof article.publishedAt === 'number',
        ),
      };
    });

    expect(setup.ok).toBe(true);
    expect(setup.spikeType).toBe('keyword_spike');
    expect(Number(setup.badgeCount)).toBeGreaterThan(0);
    // The alert must carry the evidence it was built from (#6414): the three
    // synthetic sources by name, and the contributing articles with their URLs
    // and publication times.
    expect([...(setup.sourceNames ?? [])].sort()).toEqual(['AP', 'BBC', 'Reuters']);
    expect(setup.sourceCount).toBe((setup.sourceNames ?? []).length);
    expect(setup.articleCount).toBeGreaterThan(0);
    expect(setup.articlesAllLinked).toBe(true);
    expect(setup.articlesAllTimestamped).toBe(true);

    await page.click('.intel-findings-badge');
    const finding = page.locator('.finding-item').first();
    await expect(finding).toBeVisible();
    await expect(finding).toContainText('Trending');

    await finding.click();
    await expect(page.locator('.signal-modal-overlay.active')).toBeVisible();
    await expect(page.locator('.signal-item .signal-type').first()).toContainText('Keyword Spike');
    await expect(page.locator('.suppress-keyword-btn').first()).toBeVisible();

    // Every source behind the count is named. Asserted against the rendered
    // modal rather than `spikes[0]` — the finding the user clicks is not
    // guaranteed to be the first emitted spike, and all three synthetic sources
    // appear in every headline, so any spike this fixture emits names all three.
    const sourceChips = page.locator('.signal-item .signal-source-chip');
    await expect(sourceChips).toHaveCount(3);
    for (const source of ['Reuters', 'AP', 'BBC']) {
      await expect(page.locator('.signal-item .signal-source-chip', { hasText: source }).first()).toBeVisible();
    }
    // The label resolves to real copy, not the raw i18n key.
    await expect(page.locator('.signal-item .signal-sources-label').first()).toHaveText('SOURCES');

    // ...and each contributing headline is a real link out to its article.
    const articleRows = page.locator('.signal-item .signal-article-item');
    const articleLinks = page.locator('.signal-item .signal-article-item a');
    const renderedRows = await articleRows.count();
    expect(renderedRows).toBeGreaterThan(0);
    await expect(articleLinks).toHaveCount(renderedRows);

    const firstLink = articleLinks.first();
    await expect(firstLink).toBeVisible();
    await expect(firstLink).toHaveAttribute('href', /^https:\/\/example\.com\//);
    await expect(firstLink).toHaveAttribute('target', '_blank');
    expect(await firstLink.getAttribute('rel')).toContain('noopener');
    expect((await firstLink.textContent())?.trim()).toContain('Iran sanctions');

    await page.evaluate(async () => {
      const trending = await import('/src/services/trending-keywords.ts');
      const store = (window as unknown as Record<string, unknown>).__keywordSpikeTest as
        | {
            badge?: { destroy?: () => void };
            modal?: { getElement?: () => HTMLElement };
            previousConfig?: Parameters<typeof trending.updateTrendingConfig>[0];
          }
        | undefined;

      store?.badge?.destroy?.();
      store?.modal?.getElement?.()?.remove();
      if (store?.previousConfig) {
        trending.updateTrendingConfig(store.previousConfig);
      }
      delete (window as unknown as Record<string, unknown>).__keywordSpikeTest;
    });
  });

  test('does not emit spikes from source-attribution suffixes', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const trending = await import('/src/services/trending-keywords.ts');
      const previousConfig = trending.getTrendingConfig();

      try {
        trending.updateTrendingConfig({
          blockedTerms: [],
          minSpikeCount: 4,
          spikeMultiplier: 3,
          autoSummarize: false,
        });

        const now = new Date();
        const headlines = [
          { source: 'Reuters', title: 'Qzxalpha ventures stabilize - WireDesk' },
          { source: 'AP', title: 'Bravotango liquidity trims - WireDesk' },
          { source: 'BBC', title: 'Cindelta refinery expands - WireDesk' },
          { source: 'Bloomberg', title: 'Dorion transit reroutes - WireDesk' },
          { source: 'WSJ', title: 'Epsiluna lending reprices - WireDesk' },
        ].map((item) => ({ ...item, pubDate: now }));

        trending.ingestHeadlines(headlines);

        let spikes = trending.drainTrendingSignals();
        for (let i = 0; i < 20 && spikes.length === 0; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          spikes = trending.drainTrendingSignals();
        }

        return {
          emittedTitles: spikes.map((signal) => signal.title),
          hasWireDeskSpike: spikes.some((signal) => /wiredesk/i.test(signal.title)),
        };
      } finally {
        trending.updateTrendingConfig(previousConfig);
      }
    });

    expect(result.hasWireDeskSpike).toBe(false);
    expect(result.emittedTitles.length).toBe(0);
  });

  test('suppresses month-name token spikes', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const trending = await import('/src/services/trending-keywords.ts');
      const previousConfig = trending.getTrendingConfig();

      try {
        trending.updateTrendingConfig({
          blockedTerms: [],
          minSpikeCount: 4,
          spikeMultiplier: 3,
          autoSummarize: false,
        });

        const now = new Date();
        const headlines = [
          { source: 'Reuters', title: 'January qxavon ledger shift' },
          { source: 'AP', title: 'January brivon routing update' },
          { source: 'BBC', title: 'January caldren supply note' },
          { source: 'Bloomberg', title: 'January dernix cargo brief' },
          { source: 'WSJ', title: 'January eptara policy digest' },
        ].map((item) => ({ ...item, pubDate: now }));

        trending.ingestHeadlines(headlines);

        let spikes = trending.drainTrendingSignals();
        for (let i = 0; i < 20 && spikes.length === 0; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          spikes = trending.drainTrendingSignals();
        }

        return {
          emittedTitles: spikes.map((signal) => signal.title),
          hasJanuarySpike: spikes.some((signal) => /january/i.test(signal.title)),
        };
      } finally {
        trending.updateTrendingConfig(previousConfig);
      }
    });

    expect(result.hasJanuarySpike).toBe(false);
    expect(result.emittedTitles.length).toBe(0);
  });
});
