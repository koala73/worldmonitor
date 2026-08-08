import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportLcpMetric, type LcpMetricLike } from '@/bootstrap/lcp-report';
import { webVitalsTestWindow, withWindow } from './web-vitals-report-test-helpers.mts';

function capture(metric: LcpMetricLike): { msg: string; ctx: any } {
  let out: { msg: string; ctx: any } | null = null;
  const fakeEnqueue = ((fn: (s: any) => void) => {
    fn({ captureMessage: (msg: string, ctx: unknown) => { out = { msg, ctx }; } });
  }) as unknown as typeof import('@/bootstrap/sentry-defer').enqueueSentryCall;
  // Force-keep the sampling gate so distribution-shaping assertions are stable.
  reportLcpMetric(metric, fakeEnqueue, () => true);
  assert.ok(out, 'reportLcpMetric must call enqueue exactly once');
  return out!;
}

test('reportLcpMetric reports LCP value, target, phase sub-parts, and form factor', () => {
  const { msg, ctx } = capture({
    value: 3875.6,
    rating: 'needs-improvement',
    attribution: {
      target: 'main.hero>h1',
      url: 'https://worldmonitor.app/assets/hero.webp?token=secret',
      timeToFirstByte: 421.3,
      resourceLoadDelay: 83.6,
      resourceLoadDuration: 1170.8,
      elementRenderDelay: 2200.2,
    },
  });

  assert.equal(msg, 'web-vital: LCP');
  assert.equal(ctx.tags.webvital, 'lcp');
  assert.equal(ctx.tags['lcp.rating'], 'needs-improvement');
  assert.equal(ctx.tags['lcp.element'], 'main.hero>h1');
  assert.equal(ctx.tags.formFactor, 'desktop');
  assert.equal(ctx.extra.value, 3876, 'LCP value rounded');
  assert.equal(ctx.extra.elementTarget, 'main.hero>h1');
  assert.equal(ctx.extra.url, 'https://worldmonitor.app/assets/hero.webp?[redacted]');
  assert.equal(ctx.extra.timeToFirstByte, 421);
  assert.equal(ctx.extra.resourceLoadDelay, 84);
  assert.equal(ctx.extra.resourceLoadDuration, 1171);
  assert.equal(ctx.extra.elementRenderDelay, 2200);
});

test('reportLcpMetric drops good-rated LCP without enqueuing (#4565)', () => {
  let calls = 0;
  const fakeEnqueue = ((fn: (s: any) => void) => {
    calls += 1;
    fn({ captureMessage: () => {} });
  }) as unknown as typeof import('@/bootstrap/sentry-defer').enqueueSentryCall;
  reportLcpMetric({ value: 1900, rating: 'good', attribution: { target: 'h1' } }, fakeEnqueue);
  assert.equal(calls, 0, 'good-rated (<=2500ms) LCP is not reported');
});

test('reportLcpMetric captures formFactor before deferred Sentry drain', () => {
  let queued: ((s: any) => void) | undefined;
  const fakeEnqueue = ((fn: (s: any) => void) => {
    queued = fn;
  }) as unknown as typeof import('@/bootstrap/sentry-defer').enqueueSentryCall;
  const out = withWindow(webVitalsTestWindow(900), () => {
    reportLcpMetric({ value: 3200, rating: 'needs-improvement' }, fakeEnqueue, () => true);
    return { ctx: undefined as any };
  });

  withWindow(webVitalsTestWindow(1440), () => {
    queued?.({ captureMessage: (_msg: string, ctx: unknown) => { out.ctx = ctx; } });
  });

  assert.equal(out.ctx.tags.formFactor, 'mobile');
});

test('reportLcpMetric still reports unknown/undefined-rated LCP conservatively', () => {
  let calls = 0;
  const fakeEnqueue = ((fn: (s: any) => void) => {
    calls += 1;
    fn({ captureMessage: () => {} });
  }) as unknown as typeof import('@/bootstrap/sentry-defer').enqueueSentryCall;
  reportLcpMetric({ value: 2600 }, fakeEnqueue, () => true);
  assert.equal(calls, 1, 'unknown/undefined rating still reports; do not drop unknowns');
});

test('reportLcpMetric bounds the LCP element tag value', () => {
  const target = `section.${'x'.repeat(240)}`;
  const { ctx } = capture({
    value: 4100,
    rating: 'poor',
    attribution: { target },
  });
  assert.equal(ctx.tags['lcp.element'].length, 200);
  assert.equal(ctx.extra.elementTarget, target);
});

test('reportLcpMetric drops when the sample gate rejects (volume trim)', () => {
  let calls = 0;
  const fakeEnqueue = ((fn: (s: any) => void) => {
    calls += 1;
    fn({ captureMessage: () => {} });
  }) as unknown as typeof import('@/bootstrap/sentry-defer').enqueueSentryCall;
  reportLcpMetric({ value: 4100, rating: 'poor' }, fakeEnqueue, () => false);
  assert.equal(calls, 0, 'sampled-out LCP is not enqueued even when rating is poor');
});

test('reportLcpMetric tags the configured sampleRate for reweighting', () => {
  const { ctx } = capture({ value: 3200, rating: 'needs-improvement' });
  assert.equal(ctx.tags.sampleRate, '0.2', 'sampleRate tag lets analysis rescale to true field volume');
});

test('reportLcpMetric tolerates missing attribution', () => {
  const { ctx } = capture({ value: 4100, rating: 'poor' });
  assert.equal(ctx.tags['lcp.rating'], 'poor');
  assert.equal(ctx.tags['lcp.element'], 'unknown');
  assert.equal(ctx.extra.value, 4100);
  assert.equal(ctx.extra.elementTarget, 'unknown');
  assert.equal(ctx.extra.timeToFirstByte, undefined);
});
