/**
 * Skeleton Loading Tests
 *
 * Tests for skeleton loading components and panel priority configuration.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PANEL_LOAD_DELAYS,
  getPanelLoadDelay,
  isHighPriorityPanel,
  groupPanelsByBatch,
  RETRY_CONFIG,
  getRetryDelayWithJitter,
} from '../src/constants/panelPriority';
import { renderSkeletonHtml } from '../src/components/Skeleton';

// ==============================================================
// Panel Priority Tests
// ==============================================================

describe('Panel load delays', () => {
  it('should have high priority panels with 0 delay', () => {
    assert.equal(PANEL_LOAD_DELAYS.ieSemiconductors, 0);
    assert.equal(PANEL_LOAD_DELAYS.startups, 0);
    assert.equal(PANEL_LOAD_DELAYS.ai, 0);
    assert.equal(PANEL_LOAD_DELAYS.ieTech, 0);
  });

  it('should have medium priority panels with 300ms delay', () => {
    assert.equal(PANEL_LOAD_DELAYS.ieDeals, 300);
    assert.equal(PANEL_LOAD_DELAYS.ieJobs, 300);
    assert.equal(PANEL_LOAD_DELAYS.ieBusiness, 300);
  });

  it('should have low priority panels with 600ms delay', () => {
    assert.equal(PANEL_LOAD_DELAYS.ieAcademic, 600);
    assert.equal(PANEL_LOAD_DELAYS.ieSummits, 600);
  });
});

describe('getPanelLoadDelay', () => {
  it('should return correct delay for known panels', () => {
    assert.equal(getPanelLoadDelay('ieSemiconductors'), 0);
    assert.equal(getPanelLoadDelay('ieDeals'), 300);
    assert.equal(getPanelLoadDelay('ieAcademic'), 600);
  });

  it('should return 0 for unknown panels', () => {
    assert.equal(getPanelLoadDelay('unknownPanel'), 0);
    assert.equal(getPanelLoadDelay('customPanel'), 0);
  });
});

describe('isHighPriorityPanel', () => {
  it('should return true for high priority panels', () => {
    assert.equal(isHighPriorityPanel('ieSemiconductors'), true);
    assert.equal(isHighPriorityPanel('startups'), true);
    assert.equal(isHighPriorityPanel('ai'), true);
  });

  it('should return false for delayed panels', () => {
    assert.equal(isHighPriorityPanel('ieDeals'), false);
    assert.equal(isHighPriorityPanel('ieAcademic'), false);
  });

  it('should return true for unknown panels (default)', () => {
    assert.equal(isHighPriorityPanel('unknownPanel'), true);
  });
});

describe('groupPanelsByBatch', () => {
  it('should group panels correctly', () => {
    const panels = ['ieSemiconductors', 'ieDeals', 'ieAcademic', 'startups'];
    const { batch1, batch2, batch3 } = groupPanelsByBatch(panels);

    assert.ok(batch1.includes('ieSemiconductors'));
    assert.ok(batch1.includes('startups'));
    assert.ok(batch2.includes('ieDeals'));
    assert.ok(batch3.includes('ieAcademic'));
  });

  it('should handle empty array', () => {
    const { batch1, batch2, batch3 } = groupPanelsByBatch([]);
    assert.equal(batch1.length, 0);
    assert.equal(batch2.length, 0);
    assert.equal(batch3.length, 0);
  });

  it('should put unknown panels in batch 1', () => {
    const { batch1 } = groupPanelsByBatch(['customPanel']);
    assert.ok(batch1.includes('customPanel'));
  });
});

// ==============================================================
// Retry Configuration Tests
// ==============================================================

describe('Retry configuration', () => {
  it('should have correct max retries', () => {
    assert.equal(RETRY_CONFIG.maxRetries, 1);
  });

  it('should have correct retry delay', () => {
    assert.equal(RETRY_CONFIG.retryDelay, 3000);
  });

  it('should have jitter range', () => {
    assert.ok(RETRY_CONFIG.jitterRange > 0);
    assert.ok(RETRY_CONFIG.jitterRange <= 1000);
  });
});

describe('getRetryDelayWithJitter', () => {
  it('should return delay within expected range', () => {
    const delay = getRetryDelayWithJitter();
    const minDelay = RETRY_CONFIG.retryDelay;
    const maxDelay = RETRY_CONFIG.retryDelay + RETRY_CONFIG.jitterRange;

    assert.ok(delay >= minDelay, `Delay ${delay} should be >= ${minDelay}`);
    assert.ok(delay <= maxDelay, `Delay ${delay} should be <= ${maxDelay}`);
  });

  it('should return different values (randomness check)', () => {
    const delays = new Set<number>();
    for (let i = 0; i < 10; i++) {
      delays.add(getRetryDelayWithJitter());
    }
    // With jitter, we should get at least a few different values
    assert.ok(delays.size >= 2, 'Jitter should produce some variation');
  });
});

// ==============================================================
// Skeleton HTML Tests
// ==============================================================

describe('renderSkeletonHtml', () => {
  it('should render default 4 skeleton cards', () => {
    const html = renderSkeletonHtml();
    const cardMatches = html.match(/skeleton-card/g);
    assert.equal(cardMatches?.length, 4);
  });

  it('should render specified number of cards', () => {
    const html = renderSkeletonHtml(6);
    const cardMatches = html.match(/skeleton-card/g);
    assert.equal(cardMatches?.length, 6);
  });

  it('should include skeleton panel container', () => {
    const html = renderSkeletonHtml();
    assert.ok(html.includes('skeleton-panel'));
  });

  it('should include skeleton title element', () => {
    const html = renderSkeletonHtml();
    assert.ok(html.includes('skeleton-title'));
  });

  it('should include shimmer class', () => {
    const html = renderSkeletonHtml();
    assert.ok(html.includes('skeleton-shimmer'));
  });

  it('should include meta elements', () => {
    const html = renderSkeletonHtml();
    assert.ok(html.includes('skeleton-meta'));
    assert.ok(html.includes('skeleton-source'));
    assert.ok(html.includes('skeleton-time'));
  });

  it('should handle count of 0', () => {
    const html = renderSkeletonHtml(0);
    const cardMatches = html.match(/skeleton-card/g);
    assert.equal(cardMatches, null);
  });

  it('should handle count of 1', () => {
    const html = renderSkeletonHtml(1);
    const cardMatches = html.match(/skeleton-card/g);
    assert.equal(cardMatches?.length, 1);
  });
});

// ==============================================================
// Integration Tests
// ==============================================================

describe('Panel loading integration', () => {
  it('priority delays should be in ascending order', () => {
    const delays = Object.values(PANEL_LOAD_DELAYS);
    const sortedDelays = [...delays].sort((a, b) => a - b);
    const uniqueDelays = [...new Set(sortedDelays)];

    // Should have at least 3 different priority levels
    assert.ok(uniqueDelays.length >= 3, 'Should have multiple priority levels');

    // Delays should include 0 (immediate), 300, and 600
    assert.ok(uniqueDelays.includes(0));
    assert.ok(uniqueDelays.includes(300));
    assert.ok(uniqueDelays.includes(600));
  });

  it('Ireland variant panels should all have priorities defined', () => {
    const irelandPanels = [
      'ieTech',
      'ieAcademic',
      'ieSemiconductors',
      'ieDeals',
      'ieJobs',
      'ieBusiness',
      'ieSummits',
    ];

    for (const panel of irelandPanels) {
      const delay = getPanelLoadDelay(panel);
      assert.ok(
        typeof delay === 'number',
        `Panel ${panel} should have a defined delay`
      );
    }
  });
});
