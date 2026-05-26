/**
 * Tests for src/services/ai-classify-queue.ts.
 *
 * Module-scope state (aiRecentlyQueued, aiDispatches) is reset between
 * every case via __resetAiClassifyQueueForTests to keep tests order-
 * independent. The reset is exported with the project's `__…ForTests`
 * convention (matches insights-loader.ts:104).
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import {
  canQueueAiClassification,
  __resetAiClassifyQueueForTests,
} from '../src/services/ai-classify-queue.ts';

describe('canQueueAiClassification — link-keyed identity', () => {
  beforeEach(() => {
    __resetAiClassifyQueueForTests();
  });

  it('two distinct-link items sharing a wire headline both enqueue', () => {
    const shared = 'Reuters: Iran fires missiles at undisclosed targets';
    assert.equal(
      canQueueAiClassification({ link: 'https://reuters.com/world/iran/abc', title: shared }),
      true,
    );
    assert.equal(
      canQueueAiClassification({ link: 'https://example.com/iran-news', title: shared }),
      true,
      'Different link → different dedupe slot → second call should still pass',
    );
  });

  it('two items with the same link dedupe (second returns false)', () => {
    const link = 'https://reuters.com/world/iran/abc';
    assert.equal(canQueueAiClassification({ link, title: 'Iran fires missiles' }), true);
    assert.equal(
      canQueueAiClassification({ link, title: 'Different title same link' }),
      false,
      'Same link should collapse to one dedupe slot regardless of title rewrite',
    );
  });

  it('falls back to title identity when link is empty/missing', () => {
    assert.equal(canQueueAiClassification({ link: '', title: 'Same headline' }), true);
    assert.equal(
      canQueueAiClassification({ link: '', title: 'Same headline' }),
      false,
      'Same title + empty link both calls → second dedupes (legacy behavior preserved)',
    );
  });

  it('falls back to title identity when link is undefined', () => {
    assert.equal(canQueueAiClassification({ title: 'No link here' }), true);
    assert.equal(canQueueAiClassification({ title: 'No link here' }), false);
  });

  it('strips utm_* tracker params from link identity', () => {
    const a = 'https://reuters.com/iran?utm_source=feed&utm_medium=rss';
    const b = 'https://reuters.com/iran?utm_source=twitter&utm_campaign=share';
    assert.equal(canQueueAiClassification({ link: a, title: 'x' }), true);
    assert.equal(
      canQueueAiClassification({ link: b, title: 'y' }),
      false,
      'Different utm_* tagging on the same article should collapse to one dedupe slot',
    );
  });

  it('strips fbclid/gclid tracker params from link identity', () => {
    const a = 'https://reuters.com/iran?fbclid=abc';
    const b = 'https://reuters.com/iran?gclid=xyz';
    assert.equal(canQueueAiClassification({ link: a, title: 'x' }), true);
    assert.equal(canQueueAiClassification({ link: b, title: 'y' }), false);
  });

  it('strips URL fragments from link identity', () => {
    const a = 'https://reuters.com/iran#top';
    const b = 'https://reuters.com/iran#section-2';
    assert.equal(canQueueAiClassification({ link: a, title: 'x' }), true);
    assert.equal(canQueueAiClassification({ link: b, title: 'y' }), false);
  });

  it('normalizes host casing in link identity', () => {
    const a = 'https://Reuters.com/iran';
    const b = 'https://reuters.com/iran';
    assert.equal(canQueueAiClassification({ link: a, title: 'x' }), true);
    assert.equal(canQueueAiClassification({ link: b, title: 'y' }), false);
  });

  it('preserves non-tracker query params (different ?p=1 vs ?p=2 are distinct articles)', () => {
    const a = 'https://example.com/article?p=1';
    const b = 'https://example.com/article?p=2';
    assert.equal(canQueueAiClassification({ link: a, title: 'x' }), true);
    assert.equal(
      canQueueAiClassification({ link: b, title: 'y' }),
      true,
      'Pagination params are NOT tracker params; both items must enqueue',
    );
  });

  it('malformed link falls back to title identity without crashing', () => {
    assert.equal(canQueueAiClassification({ link: 'not a url', title: 'Same title' }), true);
    assert.equal(
      canQueueAiClassification({ link: 'also not a url', title: 'Same title' }),
      false,
      'Malformed links short-circuit on the raw string; identical raw strings dedupe, different ones do not',
    );
  });

  it('respects per-minute throughput ceiling (AI_CLASSIFY_MAX_PER_WINDOW)', () => {
    // Default variant ceiling is 80/min. Flood 80 distinct items → all pass.
    // The 81st must be rejected by the throughput gate (not the dedupe gate).
    const ceiling = 80;
    for (let i = 0; i < ceiling; i++) {
      assert.equal(
        canQueueAiClassification({ link: `https://example.com/${i}`, title: `t${i}` }),
        true,
        `Flood item #${i} should pass under the ceiling`,
      );
    }
    assert.equal(
      canQueueAiClassification({ link: 'https://example.com/overflow', title: 'overflow' }),
      false,
      'Flooding past the ceiling must reject via throughput gate',
    );
  });
});
