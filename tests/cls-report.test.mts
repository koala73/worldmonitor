import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectClsReportEnv,
  registerClsReporting,
  reportClsMetric,
  type ClsMetricLike,
  type ClsReportEnv,
} from '@/bootstrap/cls-report';
import { webVitalsTestWindow, withWindow } from './web-vitals-report-test-helpers.mts';

// Capture what reportClsMetric would send, by injecting a fake enqueue that
// immediately invokes the closure with a fake Sentry namespace.
function capture(metric: ClsMetricLike, env?: ClsReportEnv): { msg: string; ctx: any } {
  let out: { msg: string; ctx: any } | null = null;
  const fakeEnqueue = ((fn: (s: any) => void) => {
    fn({ captureMessage: (msg: string, ctx: unknown) => { out = { msg, ctx }; } });
  }) as unknown as typeof import('@/bootstrap/sentry-defer').enqueueSentryCall;
  // Force-keep the sampling gate so distribution-shaping assertions are stable.
  reportClsMetric(metric, fakeEnqueue, env, () => true);
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
  assert.equal(ctx.tags.formFactor, 'desktop');
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
  reportClsMetric({ value: 0.17 }, fakeEnqueue, undefined, () => true);
  assert.equal(calls, 1, 'unknown/undefined rating still reports; do not drop unknowns');
});

test('reportClsMetric drops when the sample gate rejects (volume trim)', () => {
  let calls = 0;
  const fakeEnqueue = ((fn: (s: any) => void) => {
    calls += 1;
    fn({ captureMessage: () => {} });
  }) as unknown as typeof import('@/bootstrap/sentry-defer').enqueueSentryCall;
  reportClsMetric({ value: 0.24, rating: 'poor' }, fakeEnqueue, undefined, () => false);
  assert.equal(calls, 0, 'sampled-out CLS is not enqueued even when rating is poor');
});

test('reportClsMetric tags the configured sampleRate for reweighting', () => {
  const { ctx } = capture({ value: 0.2, rating: 'poor' });
  assert.equal(ctx.tags.sampleRate, '0.2', 'sampleRate tag lets analysis rescale to true field volume');
});

test('reportClsMetric includes the shift-class environment fields (#4580)', () => {
  const { ctx } = capture(
    { value: 0.24, rating: 'poor', attribution: { largestShiftTarget: '#panelsGrid' } },
    {
      hiddenAtLoad: true,
      hadHiddenPeriod: true,
      visibilityState: 'visible',
      scrollY: 0,
      viewport: '1440x900',
    },
  );
  assert.equal(ctx.extra.hiddenAtLoad, true, 'background-tab load flag must reach Sentry');
  assert.equal(ctx.extra.hadHiddenPeriod, true);
  assert.equal(ctx.extra.visibilityState, 'visible');
  assert.equal(ctx.extra.scrollY, 0);
  assert.equal(ctx.extra.viewport, '1440x900');
});

test('reportClsMetric captures formFactor before deferred Sentry drain', () => {
  let queued: ((s: any) => void) | undefined;
  const fakeEnqueue = ((fn: (s: any) => void) => {
    queued = fn;
  }) as unknown as typeof import('@/bootstrap/sentry-defer').enqueueSentryCall;
  const out = withWindow(webVitalsTestWindow(900), () => {
    reportClsMetric({ value: 0.22, rating: 'poor' }, fakeEnqueue, undefined, () => true);
    return { ctx: undefined as any };
  });

  withWindow(webVitalsTestWindow(1440), () => {
    queued?.({ captureMessage: (_msg: string, ctx: unknown) => { out.ctx = ctx; } });
  });

  assert.equal(out.ctx.tags.formFactor, 'mobile');
});

test('collectClsReportEnv is safe (empty) in non-browser contexts', () => {
  // Node test runner has no window/document; the collector must not throw and
  // the report path must still work with the resulting empty env.
  const env = collectClsReportEnv();
  assert.deepEqual(env, {});
  const { ctx } = capture({ value: 0.2, rating: 'poor' }, env);
  assert.equal(ctx.extra.hiddenAtLoad, undefined);
});

test('registerClsReporting returns without importing in non-browser contexts', () => {
  assert.doesNotThrow(() => registerClsReporting());
});
