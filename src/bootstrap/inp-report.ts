/**
 * Field INP attribution reporting (#4537).
 *
 * `reportInpMetric` shapes one web-vitals INP measurement (attribution build)
 * into a Sentry event and routes it through `enqueueSentryCall` so it survives
 * Sentry's deferred (~10s idle) init: the call buffers and drains on init
 * rather than being dropped because the SDK hasn't loaded when the interaction
 * occurs. Reporting interaction target + the three INP sub-parts lets us see
 * which real interaction is slow and whether the cost is input delay,
 * processing, or presentation — the data that drives fix prioritization.
 * Good-rated events are trimmed (#4565), so captured-event p75 is conditioned
 * on the bad tail. Verify fixes with bad-event rate per formFactor plus
 * weekly page-level CrUX queryHistoryRecord, not p75 of captured Sentry events.
 *
 * The `onINP` registration that calls this lives behind the `web-vitals`
 * dependency (see `registerInpReporting` doc at the bottom). This module keeps
 * the reportable logic free of that import so it builds and is unit-tested
 * without the package present.
 */
import { enqueueSentryCall } from '@/bootstrap/sentry-defer';
import { getWebVitalsFormFactor, roundMs } from '@/bootstrap/web-vitals-utils';

/** Structural subset of web-vitals' INP attribution (kept local to avoid the dep). */
export interface InpAttributionLike {
  interactionTarget?: string;
  interactionType?: string;
  inputDelay?: number;
  processingDuration?: number;
  presentationDelay?: number;
  loadState?: string;
}

/** Structural subset of web-vitals' INPMetricWithAttribution. */
export interface InpMetricLike {
  value: number;
  rating?: 'good' | 'needs-improvement' | 'poor';
  attribution?: InpAttributionLike;
}

/**
 * Report one field INP measurement to Sentry (R1, R2). `enqueue` is injectable
 * for tests; in production it defaults to the deferred-Sentry queue.
 */
export function reportInpMetric(
  metric: InpMetricLike,
  enqueue: typeof enqueueSentryCall = enqueueSentryCall,
): void {
  // Volume trim (#4565): skip 'good' (<200ms) INP — ~70% of field events, low
  // diagnostic value. Report needs-improvement / poor / unknown only, so the
  // actionable worst-case signal still lands while Sentry event volume drops ~70%.
  if (metric.rating === 'good') return;
  const a = metric.attribution ?? {};
  const formFactor = getWebVitalsFormFactor();
  enqueue((s) => {
    s.captureMessage('web-vital: INP', {
      level: 'info',
      tags: {
        webvital: 'inp',
        formFactor,
        'inp.rating': metric.rating ?? 'unknown',
        'inp.interactionType': a.interactionType ?? 'unknown',
      },
      extra: {
        value: Math.round(metric.value),
        interactionTarget: a.interactionTarget ?? 'unknown',
        inputDelay: roundMs(a.inputDelay),
        processingDuration: roundMs(a.processingDuration),
        presentationDelay: roundMs(a.presentationDelay),
        loadState: a.loadState,
      },
    });
  });
}

/**
 * Register the field INP listener (R1–R3). Browser-only. Uses a dynamic import
 * so `web-vitals` code-splits into its own chunk (loaded post-paint when this
 * runs) and so this module stays node-loadable for unit tests. web-vitals'
 * `onINP` default reports once per page lifecycle (on visibility-hide) — the
 * quota-safe production behavior (R3); `reportAllChanges` is dev-only debugging.
 */
export function registerInpReporting(): void {
  if (typeof window === 'undefined') return;
  void import('web-vitals/attribution')
    .then(({ onINP }) => {
      onINP((metric) => reportInpMetric(metric as unknown as InpMetricLike));
    })
    .catch(() => { /* web-vitals chunk failed to load (adblock/CDN) — non-fatal */ });
}
