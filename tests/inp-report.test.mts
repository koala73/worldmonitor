import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportInpMetric, type InpMetricLike } from '@/bootstrap/inp-report';
import { webVitalsTestWindow, withWindow } from './web-vitals-report-test-helpers.mts';

// Capture what reportInpMetric would send, by injecting a fake enqueue that
// immediately invokes the closure with a fake Sentry namespace.
function capture(metric: InpMetricLike): { msg: string; ctx: any } {
  let out: { msg: string; ctx: any } | null = null;
  const fakeEnqueue = ((fn: (s: any) => void) => {
    fn({ captureMessage: (msg: string, ctx: unknown) => { out = { msg, ctx }; } });
  }) as unknown as typeof import('@/bootstrap/sentry-defer').enqueueSentryCall;
  reportInpMetric(metric, fakeEnqueue);
  assert.ok(out, 'reportInpMetric must call enqueue exactly once');
  return out!;
}

test('reportInpMetric reports value + all three sub-parts + interaction target (R1)', () => {
  const { msg, ctx } = capture({
    value: 374.6,
    rating: 'needs-improvement',
    attribution: {
      interactionTarget: 'button#search',
      interactionType: 'pointer',
      inputDelay: 12.4,
      processingDuration: 300.7,
      presentationDelay: 61.5,
      loadState: 'complete',
    },
  });
  assert.equal(msg, 'web-vital: INP');
  assert.equal(ctx.extra.value, 375, 'value rounded');
  assert.equal(ctx.extra.interactionTarget, 'button#search');
  assert.equal(ctx.extra.inputDelay, 12);
  assert.equal(ctx.extra.processingDuration, 301);
  assert.equal(ctx.extra.presentationDelay, 62);
  assert.equal(ctx.tags['inp.rating'], 'needs-improvement');
  assert.equal(ctx.tags['inp.interactionType'], 'pointer');
  assert.equal(ctx.tags.webvital, 'inp');
  assert.equal(ctx.tags.formFactor, 'desktop');
});

test('reportInpMetric tolerates missing attribution (R1)', () => {
  const { ctx } = capture({ value: 210 });
  assert.equal(ctx.extra.value, 210);
  assert.equal(ctx.extra.interactionTarget, 'unknown');
  assert.equal(ctx.extra.inputDelay, undefined);
  assert.equal(ctx.tags['inp.rating'], 'unknown');
});

test('reportInpMetric routes through the injected enqueue exactly once (R2 delegation)', () => {
  let calls = 0;
  const fakeEnqueue = ((fn: (s: any) => void) => {
    calls += 1;
    fn({ captureMessage: () => {} });
  }) as unknown as typeof import('@/bootstrap/sentry-defer').enqueueSentryCall;
  reportInpMetric({ value: 100 }, fakeEnqueue);
  assert.equal(calls, 1, 'delegates to enqueueSentryCall (which buffers until Sentry init)');
});

test('reportInpMetric captures formFactor before deferred Sentry drain', () => {
  let queued: ((s: any) => void) | undefined;
  const fakeEnqueue = ((fn: (s: any) => void) => {
    queued = fn;
  }) as unknown as typeof import('@/bootstrap/sentry-defer').enqueueSentryCall;
  const out = withWindow(webVitalsTestWindow(900), () => {
    reportInpMetric({ value: 350, rating: 'needs-improvement' }, fakeEnqueue);
    return { ctx: undefined as any };
  });

  withWindow(webVitalsTestWindow(1440), () => {
    queued?.({ captureMessage: (_msg: string, ctx: unknown) => { out.ctx = ctx; } });
  });

  assert.equal(out.ctx.tags.formFactor, 'mobile');
});

test('reportInpMetric drops good-rated INP without enqueuing (#4565)', () => {
  let calls = 0;
  const fakeEnqueue = ((fn: (s: any) => void) => {
    calls += 1;
    fn({ captureMessage: () => {} });
  }) as unknown as typeof import('@/bootstrap/sentry-defer').enqueueSentryCall;
  reportInpMetric({ value: 120, rating: 'good', attribution: { interactionTarget: 'x' } }, fakeEnqueue);
  assert.equal(calls, 0, 'good-rated (<200ms) INP is not reported');
});

test('reportInpMetric still reports poor-rated INP (#4565)', () => {
  const { ctx } = capture({ value: 900, rating: 'poor', attribution: { interactionTarget: 'canvas' } });
  assert.equal(ctx.tags['inp.rating'], 'poor');
  assert.equal(ctx.extra.value, 900);
});

test('reportInpMetric still reports unknown/undefined-rated INP (conservative) (#4565)', () => {
  let calls = 0;
  const fakeEnqueue = ((fn: (s: any) => void) => {
    calls += 1;
    fn({ captureMessage: () => {} });
  }) as unknown as typeof import('@/bootstrap/sentry-defer').enqueueSentryCall;
  reportInpMetric({ value: 250 }, fakeEnqueue); // no rating field
  assert.equal(calls, 1, 'unknown/undefined rating still reports — do not drop unknowns');
});
