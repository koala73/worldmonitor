import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerClsReporting, reportClsMetric, type ClsMetricLike } from '@/bootstrap/cls-report';

// Capture what reportClsMetric would send, by injecting a fake enqueue that
// immediately invokes the closure with a fake Sentry namespace.
function capture(metric: ClsMetricLike): { msg: string; ctx: any } {
  let out: { msg: string; ctx: any } | null = null;
  const fakeEnqueue = ((fn: (s: any) => void) => {
    fn({ captureMessage: (msg: string, ctx: unknown) => { out = { msg, ctx }; } });
  }) as unknown as typeof import('@/bootstrap/sentry-defer').enqueueSentryCall;
  reportClsMetric(metric, fakeEnqueue);
  assert.ok(out, 'reportClsMetric must call enqueue exactly once');
  return out!;
}

test('reportClsMetric drops good-rated CLS without enqueuing', () => {
  let calls = 0;
  const fakeEnqueue = ((fn: (s: any) => void) => {
    calls += 1;
    fn({ captureMessage: () => {} });
  }) as unknown as typeof import('@/bootstrap/sentry-defer').enqueueSentryCall;
  reportClsMetric({ value: 0.04, rating: 'good', attribution: { largestShiftTarget: 'main' } }, fakeEnqueue);
  assert.equal(calls, 0, 'good-rated (<0.1) CLS is not reported');
});

test('reportClsMetric reports CLS attribution for needs-improvement field shifts', () => {
  const { msg, ctx } = capture({
    value: 0.15321,
    rating: 'needs-improvement',
    attribution: {
      largestShiftTarget: 'div.payment-failure-banner',
      largestShiftValue: 0.1287,
      largestShiftTime: 1842.6,
      loadState: 'complete',
    },
  });
  assert.equal(msg, 'web-vital: CLS');
  assert.equal(ctx.tags.webvital, 'cls');
  assert.equal(ctx.tags['cls.rating'], 'needs-improvement');
  assert.equal(ctx.extra.value, 0.15321, 'CLS value keeps fractional precision');
  assert.equal(ctx.extra.largestShiftTarget, 'div.payment-failure-banner');
  assert.equal(ctx.extra.largestShiftValue, 0.1287);
  assert.equal(ctx.extra.largestShiftTime, 1843, 'largest shift time rounded to ms');
  assert.equal(ctx.extra.loadState, 'complete');
});

test('reportClsMetric tolerates poor-rated CLS with missing attribution', () => {
  const { ctx } = capture({ value: 0.31, rating: 'poor' });
  assert.equal(ctx.tags['cls.rating'], 'poor');
  assert.equal(ctx.extra.value, 0.31);
  assert.equal(ctx.extra.largestShiftTarget, 'unknown');
  assert.equal(ctx.extra.largestShiftValue, undefined);
  assert.equal(ctx.extra.largestShiftTime, undefined);
  assert.equal(ctx.extra.loadState, undefined);
});

test('reportClsMetric still reports unknown/undefined-rated CLS conservatively', () => {
  let calls = 0;
  const fakeEnqueue = ((fn: (s: any) => void) => {
    calls += 1;
    fn({ captureMessage: () => {} });
  }) as unknown as typeof import('@/bootstrap/sentry-defer').enqueueSentryCall;
  reportClsMetric({ value: 0.17 }, fakeEnqueue);
  assert.equal(calls, 1, 'unknown/undefined rating still reports; do not drop unknowns');
});

test('registerClsReporting returns without importing in non-browser contexts', () => {
  assert.doesNotThrow(() => registerClsReporting());
});
