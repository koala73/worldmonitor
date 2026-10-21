import { expect, test, type Page, type TestInfo } from '@playwright/test';

const annualizedTotalUsd = 2_684_000_000;

function givingResponse() {
  const generatedAt = new Date().toISOString();
  return {
    summary: {
      generatedAt,
      activityIndex: 0,
      trend: 'stable',
      estimatedDailyFlowUsd: annualizedTotalUsd / 365,
      platforms: [
        {
          platform: 'GoFundMe',
          dailyVolumeUsd: 2_600_000_000 / 365,
          activeCampaignsSampled: 0,
          newCampaigns24h: 0,
          donationVelocity: 0,
          dataFreshness: 'annual',
          lastUpdated: '',
        },
        {
          platform: 'GlobalGiving',
          dailyVolumeUsd: 84_000_000 / 365,
          activeCampaignsSampled: 0,
          newCampaigns24h: 0,
          donationVelocity: 0,
          dataFreshness: 'annual',
          lastUpdated: '',
        },
        {
          platform: 'JustGiving',
          dailyVolumeUsd: 0,
          activeCampaignsSampled: 0,
          newCampaigns24h: 0,
          donationVelocity: 0,
          dataFreshness: 'cumulative',
          lastUpdated: '',
        },
      ],
      categories: [
        {
          category: 'Medical & Health',
          share: 0,
          change24h: 0,
          activeCampaigns: 0,
          trending: false,
        },
      ],
      crypto: {
        dailyInflowUsd: 0,
        trackedWallets: 0,
        transactions24h: 0,
        topReceivers: [],
        pctOfTotal: 0,
      },
      institutional: {
        oecdOdaAnnualUsdBn: 223.7,
        oecdDataYear: 2023,
        cafWorldGivingIndex: 0,
        cafDataYear: 0,
        candidGrantsTracked: 3_000_000,
        dataLag: 'Annual published context',
      },
      dataMode: 'partial_estimate',
      trendAvailable: false,
      provenance: [
        {
          subject: 'GoFundMe weekly giving',
          sourceName: 'GoFundMe',
          sourceUrl: 'https://www.gofundme.com/?lang=en',
          referencePeriod: 'Average week across 2023-2024',
          sourcePublishedAt: '',
          measurementBasis: 'Published lower-bound weekly platform claim',
          status: 'verified',
          coveredMetricPaths: [
            'summary.platforms[platform=GoFundMe].daily_volume_usd',
            'summary.estimated_daily_flow_usd',
          ],
          includedInHighlightedAggregate: true,
          reportedValue: 50_000_000,
          reportedUnit: 'USD',
          notes: 'More than USD 50 million is raised each week on GoFundMe.',
          valueQualifier: 'more_than',
          sourceLocator: 'Homepage giving-volume claim and footnote 1',
          accessedAt: '2026-07-24',
          denominator: 'week',
          derivation: '50,000,000 USD/week * 52 weeks/year.',
        },
        {
          subject: 'GlobalGiving 2024 giving',
          sourceName: 'GlobalGiving',
          sourceUrl: 'https://www.globalgiving.org/2024/',
          referencePeriod: '2024',
          sourcePublishedAt: '',
          measurementBasis: 'Published lower-bound annual platform claim',
          status: 'verified',
          coveredMetricPaths: [
            'summary.platforms[platform=GlobalGiving].daily_volume_usd',
            'summary.estimated_daily_flow_usd',
          ],
          includedInHighlightedAggregate: true,
          reportedValue: 84_000_000,
          reportedUnit: 'USD',
          notes: 'GlobalGiving raised more than USD 84 million in 2024.',
          valueQualifier: 'more_than',
          sourceLocator: '2024 Year in Review',
          accessedAt: '2026-07-24',
          denominator: 'year',
          derivation: 'Reported annual value; no currency conversion.',
        },
        {
          subject: 'JustGiving cumulative giving',
          sourceName: 'JustGiving',
          sourceUrl: 'https://www.justgiving.com/about',
          referencePeriod: '25 years cumulative',
          sourcePublishedAt: '',
          measurementBasis: 'Published lower-bound cumulative platform claim',
          status: 'verified',
          coveredMetricPaths: [
            'summary.platforms[platform=JustGiving].daily_volume_usd',
            'summary.provenance',
          ],
          includedInHighlightedAggregate: false,
          reportedValue: 7_000_000_000,
          reportedUnit: 'GBP',
          notes: 'More than GBP 7 billion raised over 25 years.',
          valueQualifier: 'more_than',
          sourceLocator: 'About JustGiving',
          accessedAt: '2026-07-24',
          denominator: '25 years cumulative',
          derivation: 'No annualization or USD conversion.',
        },
        {
          subject: 'Legacy giving category shares',
          sourceName: 'WorldMonitor issue #5504',
          sourceUrl: 'https://github.com/koala73/worldmonitor/issues/5504',
          referencePeriod: 'Legacy snapshot; reference period not verified',
          sourcePublishedAt: '',
          measurementBasis: 'Unsupported static category distribution',
          status: 'unverified',
          coveredMetricPaths: ['summary.categories[*].share'],
          includedInHighlightedAggregate: false,
          reportedValue: 1,
          reportedUnit: 'distribution total',
          notes: 'Stable primary evidence for the displayed distribution was not established.',
          valueQualifier: 'unverified',
          sourceLocator: 'Issue #5504',
          accessedAt: '2026-07-24',
          denominator: 'legacy distribution',
          derivation: 'No derivation; category values are hidden.',
        },
      ],
      activityIndexAvailable: false,
    },
    fetchedAt: Date.parse(generatedAt),
    dataAvailable: true,
  };
}

async function setupGivingPage(
  page: Page,
  viewport: { width: number; height: number },
): Promise<void> {
  await page.setViewportSize(viewport);
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('worldmonitor-variant', 'happy');
  });
  await page.route(/^https?:\/\/(?!(127\.0\.0\.1:4173|localhost:4173)(?:\/|$)).*/i, (route) => {
    return route.abort('blockedbyclient');
  });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/giving/v1/get-giving-summary') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(givingResponse()),
      });
      return;
    }
    if (url.pathname === '/api/bootstrap') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: {} }),
      });
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ dataAvailable: false }),
    });
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.wmEventHandlersReady === 'true');

  const panel = page.locator('.panel[data-panel="giving"]:not(.hidden)');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await panel.scrollIntoViewIfNeeded();
  await expect(panel.locator('.giving-panel-content')).toBeVisible({ timeout: 30_000 });
}

async function capturePanel(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.locator('.panel[data-panel="giving"]').screenshot({ path });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test.describe('Happy variant Giving provenance', () => {
  test('desktop discloses partial published evidence before the annualized estimate', async ({ page }, testInfo) => {
    await setupGivingPage(page, { width: 1440, height: 900 });

    const panel = page.locator('.panel[data-panel="giving"]');
    await expect(panel.locator('.panel-title')).toHaveText('Global Giving Benchmarks');
    await expect(panel.locator('.giving-status')).toHaveText(
      'Published benchmarks with partial source coverage.',
    );
    await expect(panel.locator('.giving-stat-headline .giving-stat-value')).toHaveText(
      'At least $2.7B',
    );
    await expect(panel.locator('.giving-stat-headline')).toContainText(
      'Tracked platform giving — annualized estimate',
    );
    await expect(panel.locator('.giving-methodology')).toHaveAttribute('open', '');
    await expect(panel.locator('.panel-tab[data-tab="crypto"]')).toHaveCount(0);
    await expect(panel).not.toContainText('Activity Index');
    await expect(panel).not.toContainText('24h Inflow');

    const disclosurePrecedesEstimate = await panel.evaluate((element) => {
      const status = element.querySelector('.giving-status');
      const stats = element.querySelector('.giving-stats-grid');
      return !!status
        && !!stats
        && (status.compareDocumentPosition(stats) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    });
    expect(disclosurePrecedesEstimate).toBe(true);

    const sourceLinks = panel.locator('.giving-source-meta a, .giving-methodology-source a');
    await expect(sourceLinks).toHaveCount(7);
    for (const link of await sourceLinks.all()) {
      await expect(link).toHaveAttribute('href', /^https:\/\//);
      await expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    }

    await panel.locator('.panel-tab[data-tab="categories"]').click();
    await expect(panel.locator('.giving-unverified')).toHaveText('Source not verified');
    await expect(panel).not.toContainText('33%');

    await capturePanel(page, testInfo, 'giving-provenance-desktop');
  });

  test('mobile keeps source periods, links, and methodology inside the panel', async ({ page }, testInfo) => {
    await setupGivingPage(page, { width: 390, height: 844 });

    const panel = page.locator('.panel[data-panel="giving"]');
    await expect(panel.locator('.giving-status')).toBeVisible();
    await expect(panel.locator('.giving-methodology')).toHaveAttribute('open', '');
    await expect(panel.locator('.giving-source-meta').first()).toContainText(
      'Average week across 2023-2024',
    );

    await expect.poll(() => panel.evaluate((element) =>
      element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    const panelBox = await panel.boundingBox();
    expect(panelBox).not.toBeNull();
    for (const source of await panel.locator('.giving-source-meta').all()) {
      const box = await source.boundingBox();
      if (!box) continue;
      expect(box.x).toBeGreaterThanOrEqual(panelBox!.x);
      expect(box.x + box.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width + 1);
    }

    await capturePanel(page, testInfo, 'giving-provenance-mobile');
  });
});
