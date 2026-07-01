/**
 * Field CLS attribution reporting (#4580).
 *
 * `reportClsMetric` shapes one web-vitals CLS measurement (attribution build)
 * into a Sentry event and routes it through `enqueueSentryCall` so it survives
 * Sentry's deferred (~10s idle) init. Reporting the largest shift target/value
 * lets field data name the real shifting element before we ship a layout fix.
 *
 * The `onCLS` registration that calls this lives behind the `web-vitals`
 * dependency (see `registerClsReporting` doc at the bottom). This module keeps
 * the reportable logic free of that import so it builds and is unit-tested
 * without the package present.
 */
import { enqueueSentryCall } from '@/bootstrap/sentry-defer';
import { roundMs } from '@/bootstrap/web-vitals-utils';

/** Structural subset of web-vitals' CLS attribution (kept local to avoid the dep). */
export interface ClsAttributionLike {
  largestShiftTarget?: string;
  largestShiftValue?: number;
  largestShiftTime?: number;
  loadState?: string;
}

/** Structural subset of web-vitals' CLSMetricWithAttribution. */
export interface ClsMetricLike {
  value: number;
  rating?: 'good' | 'needs-improvement' | 'poor';
  attribution?: ClsAttributionLike;
}

/**
 * Report one field CLS measurement to Sentry. `enqueue` is injectable for tests;
 * in production it defaults to the deferred-Sentry queue.
 */
export function reportClsMetric(
  metric: ClsMetricLike,
  enqueue: typeof enqueueSentryCall = enqueueSentryCall,
): void {
  // Volume trim: skip 'good' (<0.1) CLS and report needs-improvement / poor /
  // unknown only, so field attribution stays focused on actionable shifts.
  if (metric.rating === 'good') return;
  const a = metric.attribution ?? {};
  enqueue((s) => {
    s.captureMessage('web-vital: CLS', {
      level: 'info',
      tags: {
        webvital: 'cls',
        'cls.rating': metric.rating ?? 'unknown',
      },
      extra: {
        value: metric.value,
        largestShiftTarget: a.largestShiftTarget ?? 'unknown',
        largestShiftValue: a.largestShiftValue,
        largestShiftTime: roundMs(a.largestShiftTime),
        loadState: a.loadState,
      },
    });
  });
}

/**
 * Register the field CLS listener. Browser-only. Uses a dynamic import so
 * `web-vitals` code-splits into its own chunk and so this module stays
 * node-loadable for unit tests. Uses web-vitals' default lifecycle cadence
 * (including bfcache/visibility reports), matching the INP reporter.
 */
export function registerClsReporting(): void {
  if (typeof window === 'undefined') return;
  void import('web-vitals/attribution')
    .then(({ onCLS }) => {
      onCLS((metric) => reportClsMetric(metric as unknown as ClsMetricLike));
    })
    .catch(() => { /* web-vitals chunk failed to load (adblock/CDN) - non-fatal */ });
}
