import { expect, test, type Page } from '@playwright/test';
import { renderBriefMagazine } from '../server/_shared/brief-render.js';
import { BRIEF_ENVELOPE_VERSION, type BriefEnvelope, type BriefStory } from '../shared/brief-envelope.js';

const SCROLL_STORY_INDEX = 5;
const EXPECTED_PAGE_COUNT = 9;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function longText(sentence: string, count: number): string {
  return Array.from({ length: count }, () => sentence).join(' ');
}

function story(overrides: Partial<BriefStory> = {}): BriefStory {
  return {
    category: 'Energy',
    country: 'IR',
    threatLevel: 'high',
    headline: 'Iran keeps the Strait of Hormuz open while insurers reprice Gulf transit risk.',
    description:
      'Tehran signalled that commercial shipping can keep moving through Hormuz, but tanker premiums remain elevated.',
    source: 'Multiple wires',
    sourceUrl: 'https://example.com/hormuz-open',
    clusterId: 'cluster-energy-hormuz-001',
    whyMatters:
      'Hormuz carries roughly a fifth of global seaborne oil, so a stability signal can move energy prices faster than diplomatic statements.',
    ...overrides,
  };
}

function envelope(): BriefEnvelope {
  const longUnbrokenToken =
    'TranscontinentalCriticalInfrastructureContinuityAssessmentWithoutNaturalBreakpoints';
  const longStory = story({
    category: 'InfrastructureContinuityStressTest',
    country: 'US / CA',
    threatLevel: 'critical',
    headline: `${longUnbrokenToken} forces operators to test desktop magazine wrapping under unusually long language.`,
    description: longText(
      'A dense operational update combines maritime insurance, port congestion, energy logistics, and cyber-risk posture into a single reader-facing story block.',
      9,
    ),
    source: 'WorldMonitorLongSourceNameWithoutSpacesForOverflowRegression',
    sourceUrl: 'https://example.com/brief-layout-regression',
    clusterId: 'cluster-layout-overflow-001',
    whyMatters: longText(
      'This deliberately long note reproduces the desktop reading failure where content exceeded the viewport and the wheel gesture advanced the deck instead of exposing the rest of the page.',
      10,
    ),
  });

  return {
    version: BRIEF_ENVELOPE_VERSION,
    issuedAt: 1_700_000_000_000,
    data: {
      user: { name: 'Elie', tz: 'UTC' },
      issue: '27.05',
      date: '2026-05-27',
      dateLong: '27 May 2026',
      digest: {
        greeting: 'Good evening.',
        lead: longText(
          'The most important development today is not a single flashpoint but a widening pressure band across shipping, energy, and infrastructure risk.',
          3,
        ),
        numbers: { clusters: 278, multiSource: 21, surfaced: 3 },
        threads: [
          {
            tag: 'Energy',
            teaser: 'Shipping, insurance, and refinery margin signals are moving together.',
          },
          {
            tag: 'Cyber',
            teaser: 'Infrastructure operators are tightening access controls after fresh intrusion reports.',
          },
          {
            tag: 'Maritime',
            teaser: 'Port congestion and war-risk pricing are becoming the same operating story.',
          },
          {
            tag: 'Markets',
            teaser: 'Commodity desks are treating transport disruption as a first-order input.',
          },
        ],
        signals: [
          'Whether war-risk premiums fall faster than freight backlogs clear.',
          'Whether operators report fresh disruptions after shift handovers in the next 24 hours.',
        ],
      },
      stories: [
        longStory,
        story({ category: 'Diplomacy', country: 'IL / LB', threatLevel: 'medium', clusterId: 'cluster-diplomacy-002' }),
        story({ category: 'Markets', country: 'US', threatLevel: 'low', clusterId: 'cluster-markets-003' }),
      ],
    },
  };
}

async function loadMagazine(page: Page, viewport: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(viewport);
  await page.route('https://fonts.googleapis.com/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/css', body: '' });
  });
  await page.route('https://fonts.gstatic.com/**', async (route) => {
    await route.abort();
  });
  await page.setContent(renderBriefMagazine(envelope()), { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#deck .page')).toHaveCount(EXPECTED_PAGE_COUNT);
  await expect(page.locator('#navDots button')).toHaveCount(EXPECTED_PAGE_COUNT);
}

async function goToPage(page: Page, index: number): Promise<void> {
  await page.locator('#navDots button').nth(index).click();
  await expect
    .poll(async () => activePageIndex(page))
    .toBe(index);
  await expect
    .poll(async () => {
      const left = await page.locator('.page').nth(index).evaluate((el) =>
        Math.round(el.getBoundingClientRect().left),
      );
      return Math.abs(left);
    })
    .toBeLessThanOrEqual(1);
}

async function activePageIndex(page: Page): Promise<number> {
  return page.locator('#navDots button').evaluateAll((buttons) =>
    buttons.findIndex((button) => button.classList.contains('active')),
  );
}

async function currentStoryMetrics(page: Page): Promise<{
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  overflowX: string;
  overflowY: string;
}> {
  return page.locator('.page').nth(SCROLL_STORY_INDEX).evaluate((el) => {
    const pageEl = el as HTMLElement;
    const style = getComputedStyle(pageEl);
    return {
      scrollTop: pageEl.scrollTop,
      scrollHeight: pageEl.scrollHeight,
      clientHeight: pageEl.clientHeight,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
    };
  });
}

async function assertCurrentStoryFitsHorizontally(page: Page): Promise<void> {
  const REQUIRED_BOUNDS_SELECTORS = ['.left-content', '.callout'];
  const result = await page.locator('.page').nth(SCROLL_STORY_INDEX).evaluate(
    (el, selectors) => {
      const pageEl = el as HTMLElement;
      const viewportWidth = window.innerWidth;
      const bounds = selectors.map((selector) => {
        const target = pageEl.querySelector(selector) as HTMLElement | null;
        if (!target) {
          return { selector, found: false, left: 0, right: 0 };
        }
        const rect = target.getBoundingClientRect();
        return { selector, found: true, left: rect.left, right: rect.right };
      });
      const textOverflow = [
        '.story h3',
        '.story .desc',
        '.story .source',
        '.story .callout .note',
        '.story .tag',
      ].flatMap((selector) =>
        Array.from(pageEl.querySelectorAll<HTMLElement>(selector)).map((target) => ({
          selector,
          scrollWidth: target.scrollWidth,
          clientWidth: target.clientWidth,
        })),
      );
      return { viewportWidth, bounds, textOverflow };
    },
    REQUIRED_BOUNDS_SELECTORS,
  );

  for (const box of result.bounds) {
    expect(box.found, `${box.selector} should be present on the current story page`).toBe(true);
    expect(box.left, `${box.selector} should not render off the left edge`).toBeGreaterThanOrEqual(-1);
    expect(box.right, `${box.selector} should not render off the right edge`).toBeLessThanOrEqual(result.viewportWidth + 1);
  }

  for (const target of result.textOverflow) {
    expect(
      target.scrollWidth,
      `${target.selector} should wrap instead of creating horizontal text overflow`,
    ).toBeLessThanOrEqual(target.clientWidth + 2);
  }
}

function expectPngScreenshot(buffer: Buffer, label: string): void {
  expect(buffer.byteLength, `${label} screenshot should not be empty`).toBeGreaterThan(10_000);
  for (let i = 0; i < PNG_MAGIC.length; i += 1) {
    expect(buffer[i], `${label} screenshot byte ${i} should match PNG magic`).toBe(PNG_MAGIC[i]);
  }
}

test.describe('brief magazine responsive layout', () => {
  test('desktop long pages scroll before wheel navigation paginates', async ({ page }) => {
    await loadMagazine(page, { width: 1440, height: 900 });
    await goToPage(page, SCROLL_STORY_INDEX);

    const before = await currentStoryMetrics(page);
    expect(before.overflowX).toBe('hidden');
    expect(before.overflowY).toBe('auto');
    expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);
    await assertCurrentStoryFitsHorizontally(page);

    const screenshot = await page.screenshot({ fullPage: false });
    expectPngScreenshot(screenshot, 'desktop');

    await page.mouse.move(720, 450);
    await page.mouse.wheel(0, 520);

    await expect
      .poll(async () => {
        const metrics = await currentStoryMetrics(page);
        return metrics.scrollTop;
      })
      .toBeGreaterThan(0);
    expect(await activePageIndex(page)).toBe(SCROLL_STORY_INDEX);
  });

  test('mobile render remains horizontally contained and screenshotable', async ({ page }) => {
    await loadMagazine(page, { width: 393, height: 852 });
    await goToPage(page, SCROLL_STORY_INDEX);

    const metrics = await currentStoryMetrics(page);
    expect(metrics.overflowX).toBe('hidden');
    expect(metrics.overflowY).toBe('auto');
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    await assertCurrentStoryFitsHorizontally(page);

    const screenshot = await page.screenshot({ fullPage: false });
    expectPngScreenshot(screenshot, 'mobile');
  });
});
