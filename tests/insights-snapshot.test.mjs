import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  INSIGHTS_MAX_AGE_MS,
  collectInsightSources,
  isAcceptedInsightsSnapshot,
  normalizeInsightSource,
} from '../shared/insights-snapshot.js';

const NOW_MS = Date.parse('2026-08-04T00:00:00.000Z');

function snapshot(overrides = {}) {
  return {
    topStories: [{ primaryTitle: 'Headline' }],
    generatedAt: new Date(NOW_MS - 5 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe('insights snapshot helpers', () => {
  it('accepts a fresh snapshot and rejects stale or future timestamps', () => {
    assert.equal(isAcceptedInsightsSnapshot(snapshot(), NOW_MS), true);
    assert.equal(
      isAcceptedInsightsSnapshot(
        snapshot({ generatedAt: new Date(NOW_MS - INSIGHTS_MAX_AGE_MS).toISOString() }),
        NOW_MS,
      ),
      false,
    );
    assert.equal(
      isAcceptedInsightsSnapshot(
        snapshot({ generatedAt: new Date(NOW_MS + 1).toISOString() }),
        NOW_MS,
      ),
      false,
    );
  });

  it('rejects malformed or empty snapshots', () => {
    assert.equal(isAcceptedInsightsSnapshot(snapshot({ generatedAt: 'not-a-timestamp' }), NOW_MS), false);
    assert.equal(isAcceptedInsightsSnapshot(snapshot({ topStories: [] }), NOW_MS), false);
    assert.equal(isAcceptedInsightsSnapshot(null, NOW_MS), false);
  });

  it('preserves citation indexes when an indexed source has no URL', () => {
    const first = normalizeInsightSource(
      { title: 'First headline', source: 'Unavailable Wire', url: '' },
      { allowEmptyUrl: true },
    );
    const second = normalizeInsightSource({
      title: 'Second headline',
      source: 'Example Wire',
      url: 'https://example.com/second',
    });

    assert.deepEqual(first, { title: 'First headline', source: 'Unavailable Wire', url: '' });
    assert.deepEqual(second, {
      title: 'Second headline',
      source: 'Example Wire',
      url: 'https://example.com/second',
    });
  });

  it('filters unsafe and duplicate URLs from non-indexed source collections', () => {
    assert.deepEqual(
      collectInsightSources([
        { title: 'Unsafe', source: 'Bad Wire', url: 'javascript:alert(1)' },
        { title: 'First', source: 'Example Wire', url: 'https://example.com/one' },
        { title: 'Duplicate', source: 'Example Wire', url: 'https://example.com/one' },
      ]),
      [{ title: 'First', source: 'Example Wire', url: 'https://example.com/one' }],
    );
  });
});
