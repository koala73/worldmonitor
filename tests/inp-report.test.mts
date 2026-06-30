import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportInpMetric, type InpMetricLike } from '@/bootstrap/inp-report';

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
